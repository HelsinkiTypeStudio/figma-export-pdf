// Builds the final page from export A (Figma's own PDF): the letter outlines of the checked
// text come out, and that text goes back in as real text, glyph by glyph, at Figma's exact
// positions. Everything else Figma drew stays as it was.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFString,
} from "pdf-lib";
import type { ExportA, HiddenLine } from "./figma-a";
import { lex, literal, matrixString, fmt, Matrix, IDENTITY, multiply, apply } from "./lexer";
import { asDict, asNumbers, dictGet, fromLatin1, latin1, lookup, pageContent, pageResources, streamBytes } from "./objects";
import { readPaths, assignContours, removeContours, Contour, GlyphBox, Scope, Rect } from "./outlines";
import type { FontPlan, LinePlan, PagePlan } from "../plan";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf16hex(s: string): string {
  let h = "";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return h;
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

function subsetTag(): string {
  let t = "";
  for (let i = 0; i < 6; i++) t += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return t;
}

/** Byte ranges of every BT ... ET block: Figma's hidden text, all of which is written again. */
export function textBlocks(content: string): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = -1;
  for (const t of lex(content)) {
    if (t.kind === "arrayStart") depth++;
    else if (t.kind === "arrayEnd") depth--;
    else if (t.kind === "op" && depth === 0) {
      if (t.value === "BT" && start < 0) start = t.start;
      else if (t.value === "ET" && start >= 0) { out.push([start, t.end]); start = -1; }
    }
  }
  return out;
}

interface EmbeddedFont {
  resName: string;
  /** Entry index (from the font plan) to CID. */
  cid: (entry: number) => number;
}

function embedFont(doc: PDFDocument, fp: FontPlan, resName: string): EmbeddedFont {
  const p = fp.prepared!;
  const ctx = doc.context;
  const data = base64ToBytes(p.font!);
  const isCFF = p.format === "CFF";
  const entries = fp.request.glyphs;
  const gids = p.glyphs!.map((g) => g.gid);
  // TrueType: one CID per entry (glyph plus its typed characters), mapped to the glyph by a
  // CIDToGIDMap, so a glyph Figma used for two characters copies as each. CFF: Font Helper
  // already built one glyph per entry, and the CID is the glyph number.
  const cid = (e: number) => (isCFF ? (gids[e] as number) : e + 1);

  const name = `${subsetTag()}+${(p.postScriptName || fp.request.family).replace(/[^A-Za-z0-9_-]/g, "")}`;
  const fontFile = ctx.flateStream(data, isCFF ? { Subtype: "CIDFontType0C" } : { Length1: data.length });
  const italic = (p.italicAngle ?? 0) !== 0;
  const flags = (p.fixedPitch ? 1 : 0) | (p.serif ? 2 : 0) | 4 | (italic ? 64 : 0);
  const descriptor = ctx.obj({
    Type: "FontDescriptor",
    FontName: name,
    Flags: flags,
    FontBBox: p.bbox ?? [0, -200, 1000, 800],
    ItalicAngle: p.italicAngle ?? 0,
    Ascent: p.ascent ?? 800,
    Descent: p.descent ?? -200,
    CapHeight: p.capHeight ?? 700,
    StemV: 80,
    [isCFF ? "FontFile3" : "FontFile2"]: ctx.register(fontFile),
  });

  // Widths: Figma's own advance widths, so every glyph lands exactly where Figma put it.
  const byCid = new Map<number, number>();
  const chars = new Map<number, string>();
  entries.forEach((g, e) => {
    if (gids[e] === null) return;
    byCid.set(cid(e), g.w * 1000);
    chars.set(cid(e), g.chars);
  });
  const sorted = [...byCid.keys()].sort((x, y) => x - y);
  const w = ctx.obj([]) as PDFArray;
  for (const c of sorted) {
    w.push(PDFNumber.of(c));
    w.push(ctx.obj([Math.round(byCid.get(c)! * 10000) / 10000]));
  }

  const cidFont = ctx.obj({
    Type: "Font",
    Subtype: isCFF ? "CIDFontType0" : "CIDFontType2",
    BaseFont: name,
    CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
    FontDescriptor: ctx.register(descriptor),
    DW: 0,
    W: w,
  }) as PDFDict;
  if (!isCFF) {
    const max = sorted.length ? sorted[sorted.length - 1] : 0;
    const map = new Uint8Array(2 * (max + 1));
    entries.forEach((_, e) => {
      const g = gids[e];
      if (g === null) return;
      const c = cid(e);
      map[2 * c] = (g >> 8) & 0xff;
      map[2 * c + 1] = g & 0xff;
    });
    cidFont.set(PDFName.of("CIDToGIDMap"), ctx.register(ctx.flateStream(map)));
  }

  // Character map: each CID to the characters Figma recorded for its glyph, ligatures included.
  const lines = [...chars.entries()].filter(([, s]) => s).sort((x, y) => x[0] - y[0]).map(([c, s]) => `<${hex4(c)}> <${utf16hex(s)}>`);
  let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (let i = 0; i < lines.length; i += 100) {
    const chunk = lines.slice(i, i + 100);
    cmap += `${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar\n`;
  }
  cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  const toUnicode = ctx.register(ctx.flateStream(fromLatin1(cmap)));

  const type0 = ctx.obj({
    Type: "Font",
    Subtype: "Type0",
    BaseFont: name,
    Encoding: "Identity-H",
    DescendantFonts: [ctx.register(cidFont)],
    ToUnicode: toUnicode,
  });
  const fontDict = ensureDict(doc, pageResources(doc, doc.getPage(0)), "Font");
  fontDict.set(PDFName.of(resName), ctx.register(type0));
  return { resName, cid };
}

function ensureDict(doc: PDFDocument, parent: PDFDict, key: string): PDFDict {
  const existing = asDict(dictGet(doc, parent, key));
  if (existing) return existing;
  const d = doc.context.obj({});
  parent.set(PDFName.of(key), d);
  return d;
}

function freeName(dict: PDFDict, prefix: string): string {
  const used = new Set(dict.keys().map((k) => k.decodeText()));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** Real text for one line, in the fonts from Font Helper. */
function realLine(lp: LinePlan, fonts: Map<string, EmbeddedFont>, colorSpace: string | undefined): string {
  const line = lp.line;
  const fill = lp.fill!;
  let s = `q ${matrixString(line.ctm)} cm\nBT\n`;
  s += colorSpace ? `/${colorSpace} cs ${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} scn\n` : `${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} rg\n`;
  s += `${matrixString(line.tm)} Tm\n`;
  let size = 1;
  let current = "";
  let open = false;
  let pending: number[] = [];
  let gi = 0;
  const close = () => { if (open) { s += "] TJ\n"; open = false; } };
  for (const part of line.parts) {
    if (part.kind === "font") { size = part.size; current = ""; close(); continue; }
    if (part.kind === "adjust") {
      if (open) s += `${fmt(part.value)} `;
      else pending.push(part.value);
      continue;
    }
    for (let k = 0; k < part.codes.length; k++, gi++) {
      const f = fonts.get(lp.glyphFont[gi])!;
      if (f.resName !== current) {
        close();
        s += `/${f.resName} ${fmt(size)} Tf\n`;
        current = f.resName;
      }
      if (!open) {
        s += "[ " + pending.map((v) => fmt(v) + " ").join("");
        pending = [];
        open = true;
      }
      s += `<${hex4(f.cid(lp.glyphEntry[gi]))}> `;
    }
  }
  close();
  return s + "ET\nQ\n";
}

/** Figma's own invisible text for a line that stays as outlines, so it still selects and copies. */
function hiddenLine(line: HiddenLine, rename: Map<string, string>): string {
  let s = `q ${matrixString(line.ctm)} cm\nBT\n3 Tr\n${matrixString(line.tm)} Tm\n`;
  let open = false;
  const close = () => { if (open) { s += "] TJ\n"; open = false; } };
  for (const part of line.parts) {
    if (part.kind === "font") { close(); s += `/${rename.get(part.name) ?? part.name} ${fmt(part.size)} Tf\n`; continue; }
    if (!open) { s += "[ "; open = true; }
    if (part.kind === "adjust") s += `${fmt(part.value)} `;
    else s += literal(part.codes) + " ";
  }
  close();
  return s + "ET\nQ\n";
}

export interface AssembleResult {
  written: number;
  kept: number;
}

/**
 * Turns export A into the final page, in place: the letter outlines of the lines that
 * passed every check come out, and those lines go back in as real text. Lines that stay as
 * outlines keep Figma's invisible text, so they still select and copy.
 */
export function assemblePage(doc: PDFDocument, a: ExportA, plan: PagePlan): AssembleResult {
  const page = doc.getPage(0);
  const content = pageContent(doc, page);
  const res = pageResources(doc, page);
  const scopes = new Map<Scope, PDFRef>();
  const pageScope = makeScope(doc, content, res, countForms(doc, content, res), scopes);
  const remove = takeOutlines(pageScope, a, plan);
  const fontDict = ensureDict(doc, res, "Font");

  const writtenLines = plan.lines.filter((lp) => !lp.reason);
  const embedded = new Map<string, EmbeddedFont>();
  for (const lp of writtenLines) {
    for (const key of lp.glyphFont) {
      if (embedded.has(key)) continue;
      embedded.set(key, embedFont(doc, plan.fonts.get(key)!, freeName(fontDict, "R")));
    }
  }
  const colorSpace = a.colorSpace && asDict(dictGet(doc, res, "ColorSpace"))?.get(PDFName.of(a.colorSpace)) ? a.colorSpace : undefined;

  let text = "";
  for (const lp of plan.lines) text += lp.reason ? hiddenLine(lp.line, new Map()) : realLine(lp, embedded, colorSpace);
  const changed = removeContours(remove, pageScope, textBlocks(content));
  for (const [scope, kept] of changed) {
    if (scope === pageScope) continue;
    replaceStream(doc, scopes.get(scope)!, kept);
  }
  const out = `q\n${changed.get(pageScope)}\nQ\n${text}`;
  // The old content streams would stay in the file unused, so they go.
  const old = page.node.get(PDFName.of("Contents"));
  const oldRefs: PDFRef[] = old instanceof PDFRef ? [old] : [];
  const oldArray = lookup(doc, old);
  if (oldArray instanceof PDFArray) for (let i = 0; i < oldArray.size(); i++) { const r = oldArray.get(i); if (r instanceof PDFRef) oldRefs.push(r); }
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(fromLatin1(out))));
  for (const r of oldRefs) doc.context.delete(r);
  return { written: writtenLines.length, kept: plan.lines.length - writtenLines.length };
}

/** Gives a form new content, keeping everything else about it. */
function replaceStream(doc: PDFDocument, ref: PDFRef, content: string) {
  const old = doc.context.lookup(ref) as PDFRawStream;
  const fresh = doc.context.flateStream(fromLatin1(content));
  for (const [k, v] of old.dict.entries()) {
    const key = k.decodeText();
    if (key === "Length" || key === "Filter" || key === "DecodeParms") continue;
    fresh.dict.set(k, v);
  }
  doc.context.assign(ref, fresh);
}

function names(content: string, op: string): string[] {
  const out: string[] = [];
  let name = "";
  for (const t of lex(content)) {
    if (t.kind === "name") name = t.value;
    else if (t.kind === "op") { if (t.value === op && name) out.push(name); name = ""; }
    else name = "";
  }
  return out;
}

function formOf(doc: PDFDocument, res: PDFDict, name: string): { ref: PDFRef; stream: PDFRawStream } | undefined {
  const ref = asDict(dictGet(doc, res, "XObject"))?.get(PDFName.of(name));
  if (!(ref instanceof PDFRef)) return undefined;
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return undefined;
  if (stream.dict.get(PDFName.of("Subtype"))?.toString() !== "/Form") return undefined;
  return { ref, stream };
}

function formResources(doc: PDFDocument, stream: PDFRawStream, parent: PDFDict): PDFDict {
  return asDict(lookup(doc, stream.dict.get(PDFName.of("Resources")))) ?? parent;
}

/** How many times each form is drawn, counting forms inside forms. */
function countForms(doc: PDFDocument, content: string, res: PDFDict, counts = new Map<string, number>(), depth = 0): Map<string, number> {
  for (const n of names(content, "Do")) {
    const f = formOf(doc, res, n);
    if (!f) continue;
    const key = f.ref.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key) === 1 && depth < 4) {
      countForms(doc, latin1(streamBytes(f.stream)), formResources(doc, f.stream, res), counts, depth + 1);
    }
  }
  return counts;
}

/**
 * The rectangle an alpha mask lets through, when the mask is nothing but one opaque
 * rectangle: Figma clips slides and frames this way. Anything else gives undefined.
 */
function maskRect(doc: PDFDocument, mask: PDFDict): Rect | undefined {
  if (dictGet(doc, mask, "S")?.toString() !== "/Alpha") return undefined;
  const tr = dictGet(doc, mask, "TR");
  if (tr && tr.toString() !== "/Identity") return undefined;
  const g = dictGet(doc, mask, "G");
  if (!(g instanceof PDFRawStream)) return undefined;
  let m: Matrix = IDENTITY;
  const fm = asNumbers(doc, g.dict.get(PDFName.of("Matrix")));
  if (fm.length === 6) m = fm as Matrix;
  const stack: Matrix[] = [];
  const pts: [number, number][] = [];
  let nums: number[] = [];
  let fills = 0;
  let curves = 0;
  for (const t of lex(latin1(streamBytes(g)))) {
    if (t.kind === "num") { nums.push(t.value); continue; }
    if (t.kind === "name") continue;
    if (t.kind !== "op") return undefined;
    switch (t.value) {
      case "q": stack.push(m); break;
      case "Q": m = stack.pop() ?? IDENTITY; break;
      case "cm": m = multiply(nums.slice(-6) as Matrix, m); break;
      case "cs": case "scn": case "sc": case "g": case "rg": case "n": case "h": break;
      case "m": case "l": pts.push(apply(m, nums[0], nums[1])); break;
      case "f": case "f*": fills++; break;
      case "c": case "v": case "y": curves++; break;
      default: return undefined;
    }
    nums = [];
  }
  if (fills !== 1 || curves || pts.length < 4 || pts.length > 5) return undefined;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  // Only a rectangle: every corner on the box's edges in both directions.
  if (!pts.every(([x, y]) => (Math.abs(x - r.x0) < 0.01 || Math.abs(x - r.x1) < 0.01) && (Math.abs(y - r.y0) < 0.01 || Math.abs(y - r.y1) < 0.01))) return undefined;
  return r;
}

function isPlainState(o: PDFObject | undefined, doc: PDFDocument): boolean | Rect {
  const d = asDict(lookup(doc, o));
  if (!d) return false;
  const ca = dictGet(doc, d, "ca");
  if (ca instanceof PDFNumber && ca.asNumber() < 1) return false;
  const bm = dictGet(doc, d, "BM");
  if (bm instanceof PDFArray) { if (bm.size() !== 1 || !["/Normal", "/Compatible"].includes(lookup(doc, bm.get(0))!.toString())) return false; }
  else if (bm && !["/Normal", "/Compatible"].includes(bm.toString())) return false;
  const mask = dictGet(doc, d, "SMask");
  if (mask && mask.toString() !== "/None") {
    const md = asDict(mask);
    return (md && maskRect(doc, md)) || false;
  }
  return true;
}

function makeScope(doc: PDFDocument, content: string, res: PDFDict, counts: Map<string, number>, refs: Map<Scope, PDFRef>): Scope {
  const states = asDict(dictGet(doc, res, "ExtGState"));
  const made = new Map<string, { scope: Scope; matrix: Matrix }>();
  return {
    content,
    plainState: (name) => isPlainState(states?.get(PDFName.of(name)), doc),
    form: (name) => {
      if (made.has(name)) return undefined;   // drawn twice in this stream
      const f = formOf(doc, res, name);
      if (!f || counts.get(f.ref.toString()) !== 1) return undefined;
      const m = asNumbers(doc, f.stream.dict.get(PDFName.of("Matrix")));
      const scope = makeScope(doc, latin1(streamBytes(f.stream)), formResources(doc, f.stream, res), counts, refs);
      refs.set(scope, f.ref);
      const entry = { scope, matrix: (m.length === 6 ? m : IDENTITY) as Matrix };
      made.set(name, entry);
      return entry;
    },
  };
}

function sameColour(fill: number[], c: { r: number; g: number; b: number }): boolean {
  return fill.length === 3 && Math.abs(fill[0] - c.r) < 0.002 && Math.abs(fill[1] - c.g) < 0.002 && Math.abs(fill[2] - c.b) < 0.002;
}

/**
 * Finds the outlines of every line planned as real text. A line whose outlines can't all be
 * found, or share a contour with another line that stays, is kept as outlines instead.
 * Returns the contours to remove.
 */
function takeOutlines(page: Scope, a: ExportA, plan: PagePlan): Set<Contour> {
  const paths = readPaths(page);
  const lines = plan.lines.map((lp) => lp.line);

  for (let round = 0; round < 5; round++) {
    // Glyph boxes in each line's text space: exact boxes from the font file for lines
    // planned as real text, generous ones (from Figma's numbers, 1 em tall) for the rest.
    const boxes: (GlyphBox | null)[][] = plan.lines.map((lp, li) => lp.line.glyphs.map((g, gi) => {
      const fig = a.fonts.get(g.font)?.glyphs.get(g.code);
      if (!fig || fig.urx - fig.llx <= 0) return null;
      if (!lp.reason) {
        const fp = plan.fonts.get(lp.glyphFont[gi]);
        const box = fp?.prepared?.glyphs?.[lp.glyphEntry[gi]]?.box;
        if (!box) return null;
        return { line: li, glyph: gi, x0: g.x + box[0] * g.size, y0: box[1] * g.size, x1: g.x + box[2] * g.size, y1: box[3] * g.size };
      }
      return { line: li, glyph: gi, x0: g.x + fig.llx * g.size, y0: Math.min(fig.lly, 0) * g.size, x1: g.x + fig.urx * g.size, y1: 1.2 * g.size };
    }));
    const hits = assignContours(paths, lines, boxes, 0.01);

    const found = plan.lines.map((lp) => lp.line.glyphs.map(() => false));
    const owned = new Map<number, Contour[]>();
    const spoiled = new Set<number>();
    for (const [c, bs] of hits) {
      const linesHit = new Set(bs.map((b) => b.line));
      const written = [...linesHit].filter((li) => !plan.lines[li].reason);
      if (!written.length) continue;
      const li = written[0];
      if (linesHit.size > 1) { written.forEach((w) => spoiled.add(w)); continue; }
      if (!sameColour(c.path.fill, plan.lines[li].fill!)) continue;
      for (const b of bs) found[li][b.glyph] = true;
      owned.set(li, (owned.get(li) ?? []).concat([c]));
    }

    let changed = false;
    plan.lines.forEach((lp, li) => {
      if (lp.reason) return;
      if (spoiled.has(li)) { lp.reason = "overlaps other text that stays as outlines"; changed = true; return; }
      const missing = boxes[li].some((b, gi) => b && !found[li][gi]);
      if (missing) { lp.reason = "couldn't find its outlines in Figma's export"; changed = true; }
    });
    if (!changed) {
      const remove = new Set<Contour>();
      plan.lines.forEach((lp, li) => { if (!lp.reason) for (const c of owned.get(li) ?? []) remove.add(c); });
      return remove;
    }
  }
  for (const lp of plan.lines) if (!lp.reason) lp.reason = "couldn't find its outlines in Figma's export";
  return new Set();
}
