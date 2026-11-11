// Decides, line by line, which text becomes real text and which stays as Figma's outlines.
import type { ExportA, FigmaGlyph, HiddenLine } from "./pdf/figma-a";
import { matchLines, LineMatch } from "./match";
import type { ClearRange, SolidFill, TextInfo } from "./types";

/** What Font Helper answers for one font (see font-helper's fontwork.py). */
export interface PreparedFont {
  ok: boolean;
  error?: string;
  path?: string;
  format?: "TrueType" | "CFF";
  font?: string;            // base64
  glyphs?: { gid: number | null; how: string; diff?: number }[];
  postScriptName?: string;
  upm?: number;
  ascent?: number;
  descent?: number;
  capHeight?: number;
  italicAngle?: number;
  bbox?: number[];
  fixedPitch?: boolean;
  serif?: boolean;
}

export interface FontRequest {
  family: string;
  style: string;
  axes: Record<string, number>;
  glyphs: (FigmaGlyph & { chars: string })[];
}

export interface FontPlan {
  key: string;
  request: FontRequest;
  entryIndex: Map<string, number>;   // "F1:12:chars" -> entry
  prepared?: PreparedFont;
}

export interface LinePlan {
  line: HiddenLine;
  match?: LineMatch;
  /** Why the line stays as outlines; undefined when it is written as real text. */
  reason?: string;
  fill?: SolidFill;
  /** For each glyph: its font plan and entry. */
  glyphFont: string[];
  glyphEntry: number[];
}

export interface PagePlan {
  lines: LinePlan[];
  fonts: Map<string, FontPlan>;
  clear: ClearRange[];
}

function sameFill(a: SolidFill, b: SolidFill): boolean {
  return Math.abs(a.r - b.r) < 1e-4 && Math.abs(a.g - b.g) < 1e-4 && Math.abs(a.b - b.b) < 1e-4;
}

/** Step 1: match lines to layers, check styles, and list the glyphs each font must have. */
export function planPage(a: ExportA, texts: TextInfo[]): PagePlan {
  const matches = matchLines(a.lines, texts);
  const fonts = new Map<string, FontPlan>();
  const lines: LinePlan[] = [];

  for (const line of a.lines) {
    const lp: LinePlan = { line, glyphFont: [], glyphEntry: [] };
    lines.push(lp);
    const m = matches.get(line);
    if (line.unsupported) { lp.reason = `Figma wrote this line in an unexpected way (${line.unsupported})`; continue; }
    if (!m) { lp.reason = "couldn't find which layer this line belongs to"; continue; }
    lp.match = m;
    if (m.text.keepOutlines) { lp.reason = m.text.keepOutlines; continue; }

    let fill: SolidFill | undefined;
    for (const seg of m.glyphSegment) {
      if (!seg.fill) { lp.reason = seg.fillProblem || "its fill isn't a single solid colour"; break; }
      if (seg.textDecoration && seg.textDecoration !== "NONE") { lp.reason = "underlined or struck-through text"; break; }
      if (fill && !sameFill(fill, seg.fill)) { lp.reason = "more than one colour in the line"; break; }
      fill = seg.fill;
    }
    if (lp.reason) continue;
    lp.fill = fill;

    line.glyphs.forEach((g, gi) => {
      const fn = m.glyphSegment[gi].fontName;
      const axes = fn.variationSettings ?? {};
      const key = JSON.stringify([fn.family, fn.style, Object.keys(axes).sort().map((k) => [k, axes[k]])]);
      let fp = fonts.get(key);
      if (!fp) {
        fp = { key, request: { family: fn.family, style: fn.style, axes, glyphs: [] }, entryIndex: new Map() };
        fonts.set(key, fp);
      }
      const ek = `${g.font}:${g.code}:${g.chars}`;
      let ei = fp.entryIndex.get(ek);
      if (ei === undefined) {
        const fig = a.fonts.get(g.font)!.glyphs.get(g.code)!;
        ei = fp.request.glyphs.length;
        fp.request.glyphs.push({ ...fig, chars: g.chars });
        fp.entryIndex.set(ek, ei);
      }
      lp.glyphFont.push(key);
      lp.glyphEntry.push(ei);
    });
  }
  return { lines, fonts, clear: [] };
}

/** Step 2, after Font Helper has answered: keep only lines whose every glyph was found. */
export function finishPlan(plan: PagePlan): void {
  plan.clear = [];
  for (const lp of plan.lines) {
    if (lp.reason || !lp.match) continue;
    const missing: string[] = [];
    let problem: string | undefined;
    lp.line.glyphs.forEach((g, gi) => {
      const fp = plan.fonts.get(lp.glyphFont[gi])!;
      const p = fp.prepared;
      if (!p || !p.ok) { problem = p?.error === "not installed" ? `${fp.request.family} ${fp.request.style} isn't installed` : `couldn't read ${fp.request.family} ${fp.request.style}: ${p?.error ?? "Font Helper didn't answer"}`; return; }
      if (p.glyphs![lp.glyphEntry[gi]].gid === null) missing.push(g.chars || `#${g.code}`);
    });
    if (problem) { lp.reason = problem; continue; }
    if (missing.length) {
      const fp = plan.fonts.get(lp.glyphFont[0])!;
      lp.reason = `letters that don't match ${fp.request.family} ${fp.request.style}: ${[...new Set(missing)].join(" ")}`;
      continue;
    }
    plan.clear.push({ id: lp.match.text.id, start: lp.match.start, end: lp.match.end });
  }
}
