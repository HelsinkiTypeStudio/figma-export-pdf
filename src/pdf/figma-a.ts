// Reads export A: Figma's own PDF of a frame or slide. Besides the drawn outlines, it has
// an invisible text layer made of Type 3 "FigmaGlyphs" fonts whose glyphs draw nothing
// but record each glyph's advance width and box. That layer gives the exact position,
// size and characters of every glyph Figma drew.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { Matrix, IDENTITY, lex, multiply, apply, Token } from "./lexer";
import { asDict, asNumbers, dictGet, latin1, lookup, pageContent, pageResources, streamBytes } from "./objects";

export interface FigmaGlyph {
  /** Advance width and box edges in em. Figma's top edge (ury) is unreliable and left out. */
  w: number;
  llx: number;
  lly: number;
  urx: number;
}

export interface Type3Font {
  name: string;           // resource name, e.g. "F1"
  glyphs: Map<number, FigmaGlyph>;
  unicode: Map<number, string>;
}

export type TextPart =
  | { kind: "font"; name: string; size: number }
  | { kind: "glyphs"; font: string; codes: number[] }
  | { kind: "adjust"; value: number };

export interface Glyph {
  font: string;
  code: number;
  chars: string;
  /** Position along the line, in text space units (em times the Tf size), and the Tf size. */
  x: number;
  size: number;
}

export interface HiddenLine {
  index: number;
  /** Byte offsets of this BT ... ET block in the content stream. */
  start: number;
  end: number;
  ctm: Matrix;
  tm: Matrix;
  parts: TextPart[];
  glyphs: Glyph[];
  text: string;
  /** Font size on the page, in points. */
  size: number;
  /** The line's origin on the page, in Figma's coordinates (y down from the top). */
  x: number;
  y: number;
  /** Set when the block uses text operators this reader doesn't follow. */
  unsupported?: string;
}

export interface ExportA {
  width: number;
  height: number;
  fonts: Map<string, Type3Font>;
  lines: HiddenLine[];
  /** The colour space name Figma uses for fills (an ICC RGB space), if any. */
  colorSpace?: string;
}

function parseToUnicode(s: string): Map<number, string> {
  const m = new Map<number, string>();
  const hexToStr = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const block of s.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const r of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) m.set(parseInt(r[1], 16), hexToStr(r[2]));
  }
  for (const block of s.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const r of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (r[3].startsWith("[")) {
        const items = [...r[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) m.set(c, items[c - lo]);
      } else {
        const base = hexToStr(r[3].slice(1, -1));
        for (let c = lo; c <= hi; c++) {
          m.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
        }
      }
    }
  }
  return m;
}

function readType3(doc: PDFDocument, name: string, font: PDFDict): Type3Font | undefined {
  const subtype = dictGet(doc, font, "Subtype");
  if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Type3") return undefined;
  const fm = asNumbers(doc, font.get(PDFName.of("FontMatrix")));
  const sx = fm[0] || 1, sy = fm[3] || 1;
  const procs = asDict(dictGet(doc, font, "CharProcs"));
  const enc = asDict(dictGet(doc, font, "Encoding"));
  const diffs = enc ? lookup(doc, enc.get(PDFName.of("Differences"))) : undefined;
  const glyphs = new Map<number, FigmaGlyph>();
  if (procs && diffs instanceof PDFArray) {
    let code = 0;
    for (let i = 0; i < diffs.size(); i++) {
      const o = lookup(doc, diffs.get(i));
      if (o instanceof PDFNumber) { code = o.asNumber(); continue; }
      if (o instanceof PDFName) {
        const proc = dictGet(doc, procs, o.decodeText());
        if (proc) {
          const nums = latin1(streamBytes(proc)).trim().split(/\s+/).slice(0, 6).map(Number);
          const [wx, , llx, lly, urx, ury] = nums;
          glyphs.set(code, { w: wx * sx, llx: llx * sx, lly: Math.min(lly, ury) * sy, urx: urx * sx });
        }
        code++;
      }
    }
  }
  const tu = dictGet(doc, font, "ToUnicode");
  const unicode = tu ? parseToUnicode(latin1(streamBytes(tu))) : new Map<number, string>();
  return { name, glyphs, unicode };
}

export function readExportA(doc: PDFDocument): ExportA {
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  const res = pageResources(doc, page);
  const fonts = new Map<string, Type3Font>();
  const fontDict = asDict(dictGet(doc, res, "Font"));
  if (fontDict) {
    for (const [k, v] of fontDict.entries()) {
      const d = asDict(lookup(doc, v));
      const name = k.decodeText();
      const f = d && readType3(doc, name, d);
      if (f) fonts.set(name, f);
    }
  }
  const content = pageContent(doc, page);
  const tokens = lex(content);
  const lines: HiddenLine[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let ops: Token[] = [];
  let colorSpace: string | undefined;
  let inText = false;
  let line: HiddenLine | undefined;
  let tm: Matrix = IDENTITY;
  let font = "";
  let fontSize = 1;
  let arrayDepth = 0;
  let tx = 0;
  let arrayItems: Token[] = [];

  const nums = () => ops.filter((t) => t.kind === "num").map((t) => (t as { value: number }).value);

  for (const t of tokens) {
    if (t.kind === "arrayStart") { arrayDepth++; if (arrayDepth === 1) arrayItems = []; continue; }
    if (t.kind === "arrayEnd") { arrayDepth--; continue; }
    if (arrayDepth > 0) { arrayItems.push(t); continue; }
    if (t.kind !== "op") { ops.push(t); continue; }
    const op = t.value;
    if (!inText) {
      if (op === "q") stack.push(ctm);
      else if (op === "Q") ctm = stack.pop() ?? IDENTITY;
      else if (op === "cm") { const v = nums(); if (v.length >= 6) ctm = multiply(v.slice(-6) as Matrix, ctm); }
      else if (op === "cs") {
        const n = ops.filter((x) => x.kind === "name").pop();
        if (n && n.kind === "name" && colorSpace === undefined) colorSpace = n.value;
      } else if (op === "BT") {
        inText = true;
        tm = IDENTITY;
        tx = 0;
        line = { index: lines.length, start: t.start, end: t.end, ctm, tm, parts: [], glyphs: [], text: "", size: 0, x: 0, y: 0 };
      }
    } else if (line) {
      if (op === "ET") {
        line.end = t.end;
        line.text = line.glyphs.map((g) => g.chars).join("");
        if (line.glyphs.length) lines.push(line);
        inText = false;
        line = undefined;
      } else if (op === "Tm") {
        const v = nums();
        if (line.glyphs.length) {
          // A new text position inside the same block (Figma does this for lines of one
          // layer): treat it as a line of its own, in the font already set.
          line.end = t.start;
          line.text = line.glyphs.map((g) => g.chars).join("");
          lines.push(line);
          line = { index: lines.length, start: t.start, end: t.end, ctm: line.ctm, tm, parts: [], glyphs: [], text: "", size: 0, x: 0, y: 0 };
          if (font) line.parts.push({ kind: "font", name: font, size: fontSize });
        }
        tm = v.slice(-6) as Matrix;
        line.tm = tm;
        tx = 0;
      } else if (op === "Tf") {
        const n = ops.filter((x) => x.kind === "name").pop();
        const v = nums();
        font = n && n.kind === "name" ? n.value : "";
        fontSize = v.length ? v[v.length - 1] : 1;
        line.parts.push({ kind: "font", name: font, size: fontSize });
      } else if (op === "TJ" || op === "Tj") {
        const items = op === "TJ" ? arrayItems : ops.filter((x) => x.kind === "str");
        for (const it of items) {
          if (it.kind === "num") {
            line.parts.push({ kind: "adjust", value: it.value });
            tx -= (it.value / 1000) * fontSize;
          } else if (it.kind === "str") {
            line.parts.push({ kind: "glyphs", font, codes: it.bytes.slice() });
            const f = fonts.get(font);
            for (const code of it.bytes) {
              line.glyphs.push({ font, code, chars: f?.unicode.get(code) ?? "", x: tx, size: fontSize });
              const g = f?.glyphs.get(code);
              if (!g) line.unsupported = `glyph ${code} of font ${font} has no measurements`;
              else tx += g.w * fontSize;
            }
          }
        }
        if (!line.size) {
          const m = multiply(tm, line.ctm);
          line.size = Math.abs(fontSize) * Math.hypot(m[0], m[1]);
          const [px, py] = apply(line.ctm, tm[4], tm[5]);
          line.x = px;
          line.y = height - py;
        }
      } else if (["Td", "TD", "T*", "'", "\"", "Tc", "Tw", "Tz", "TL", "Ts", "d0", "d1"].includes(op)) {
        line.unsupported = `text operator ${op}`;
      }
      // Tr, colour operators and marked content inside text are ignored.
    }
    ops = [];
  }
  return { width, height, fonts, lines, colorSpace };
}
