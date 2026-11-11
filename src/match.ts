// Matches each line of Figma's hidden text to the text layer and characters it came from.
// Figma writes lines in its own order, not layer order (test 3), so lines are matched by
// their characters, then font size and position break ties.
import type { HiddenLine } from "./pdf/figma-a";
import type { TextInfo, TextSegment } from "./types";

export interface LineMatch {
  line: HiddenLine;
  text: TextInfo;
  start: number;          // first character of the line in the layer
  end: number;            // one past the last character
  glyphChar: number[];    // for each glyph, the index of its first character in the layer
  glyphSegment: TextSegment[];
}

interface Folded {
  s: string;
  /** For each character of s, the index of the source character it came from. */
  map: number[];
}

/** Lowercase, with every run of white space as one space, keeping a map back to the source. */
function fold(src: string): Folded {
  let s = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const len = ch.length;
    if (/\s/u.test(ch)) {
      if (!lastSpace) { s += " "; map.push(i); }
      lastSpace = true;
    } else {
      const low = ch.toLowerCase();
      for (let k = 0; k < low.length; k++) map.push(i);
      s += low;
      lastSpace = false;
    }
    i += len;
  }
  return { s, map };
}

function segmentAt(t: TextInfo, i: number): TextSegment {
  for (const s of t.segments) if (i >= s.start && i < s.end) return s;
  return t.segments[t.segments.length - 1];
}

function distance(t: TextInfo, x: number, y: number): number {
  const b = t.box;
  const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

export function matchLines(lines: HiddenLine[], texts: TextInfo[]): Map<HiddenLine, LineMatch> {
  const folded = texts.map((t) => fold(t.characters));
  const used = texts.map(() => new Set<number>());
  const out = new Map<HiddenLine, LineMatch>();

  for (const line of lines) {
    // The line's characters, folded the same way, with the glyph each character belongs to.
    let ls = "";
    const glyphOf: number[] = [];
    let lastSpace = false;
    line.glyphs.forEach((g, gi) => {
      for (const ch of Array.from(g.chars)) {
        if (/\s/u.test(ch)) {
          if (!lastSpace) { ls += " "; glyphOf.push(gi); }
          lastSpace = true;
        } else {
          const low = ch.toLowerCase();
          ls += low;
          for (let k = 0; k < low.length; k++) glyphOf.push(gi);
          lastSpace = false;
        }
      }
    });
    const trimmed = ls.trim();
    if (!trimmed) continue;
    const lead = ls.indexOf(trimmed);

    let best: { score: number[]; ti: number; pos: number } | undefined;
    texts.forEach((t, ti) => {
      const f = folded[ti];
      for (let pos = f.s.indexOf(trimmed); pos >= 0; pos = f.s.indexOf(trimmed, pos + 1)) {
        if (used[ti].has(pos)) continue;
        const seg = segmentAt(t, f.map[pos]);
        const sizeOk = Math.abs(seg.fontSize - line.size) < 0.05 ? 1 : 0;
        // Higher is better: right size, then close to the layer, then earlier in it.
        const score = [sizeOk, -Math.round(distance(t, line.x, line.y)), -pos];
        if (!best || compare(score, best.score) > 0) best = { score, ti, pos };
      }
    });
    if (!best || best.score[0] === 0) continue;

    const t = texts[best.ti];
    const f = folded[best.ti];
    used[best.ti].add(best.pos);
    const start = f.map[best.pos];
    const lastFolded = best.pos + trimmed.length - 1;
    const lastSrc = f.map[lastFolded];
    const end = lastSrc + String.fromCodePoint(t.characters.codePointAt(lastSrc)!).length;

    // Each glyph's first character in the layer. Glyphs for leading or trailing white space
    // that isn't part of the folded match borrow the nearest matched position.
    const glyphChar: number[] = new Array(line.glyphs.length).fill(-1);
    for (let k = 0; k < trimmed.length; k++) {
      const gi = glyphOf[lead + k];
      if (glyphChar[gi] < 0) glyphChar[gi] = f.map[best.pos + k];
    }
    let last = start;
    for (let gi = 0; gi < glyphChar.length; gi++) {
      if (glyphChar[gi] < 0) glyphChar[gi] = last;
      else last = glyphChar[gi];
    }
    out.set(line, {
      line, text: t, start, end, glyphChar,
      glyphSegment: glyphChar.map((ci) => segmentAt(t, ci)),
    });
  }
  return out;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
