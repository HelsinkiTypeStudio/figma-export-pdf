// Builds the final page: export B (Figma's PDF with the checked text's fill cleared) plus
// that text written back as real text, glyph by glyph, at export A's exact positions.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRef, PDFString,
} from "pdf-lib";
import type { ExportA, HiddenLine } from "./figma-a";
import { lex, literal, matrixString, fmt } from "./lexer";
import { asDict, dictGet, fromLatin1, lookup, pageContent, pageResources } from "./objects";
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

/** Removes every BT ... ET block from a content stream: Figma's hidden text, all of which is written again. */
export function stripTextBlocks(content: string): string {
  const tokens = lex(content);
  let out = "";
  let last = 0;
  let depth = 0;
  let start = -1;
  for (const t of tokens) {
    if (t.kind === "arrayStart") depth++;
    else if (t.kind === "arrayEnd") depth--;
    else if (t.kind === "op" && depth === 0) {
      if (t.value === "BT" && start < 0) start = t.start;
      else if (t.value === "ET" && start >= 0) {
        out += content.slice(last, start);
        last = t.end;
        start = -1;
      }
    }
  }
  return out + content.slice(last);
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
  doc: PDFDocument;
  written: number;
  kept: number;
}

/**
 * Writes the plan into export B. `b` is null when Figma refused to export B because nothing
 * visible was left (a selection made only of text); a blank page is used then.
 */
export async function assemblePage(aDoc: PDFDocument, a: ExportA, b: Uint8Array | null, plan: PagePlan): Promise<AssembleResult> {
  let doc: PDFDocument;
  if (b) {
    doc = await PDFDocument.load(b, { updateMetadata: false });
    const { width, height } = doc.getPage(0).getSize();
    if (Math.abs(width - a.width) > 0.01 || Math.abs(height - a.height) > 0.01) {
      throw new Error(`the two exports differ in page size (${width}×${height} and ${a.width}×${a.height})`);
    }
  } else {
    doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([a.width, a.height]);
  }
  const page = doc.getPage(0);
  const res = pageResources(doc, page);
  const fontDict = ensureDict(doc, res, "Font");

  // Colour space for the text colour: the same one Figma uses for fills.
  let colorSpace = a.colorSpace;
  if (colorSpace) {
    const csDict = ensureDict(doc, res, "ColorSpace");
    if (!csDict.get(PDFName.of(colorSpace))) {
      const aRes = pageResources(aDoc, aDoc.getPage(0));
      const src = asDict(dictGet(aDoc, aRes, "ColorSpace"))?.get(PDFName.of(colorSpace));
      if (src) csDict.set(PDFName.of(colorSpace), PDFObjectCopier.for(aDoc.context, doc.context).copy(src));
      else colorSpace = undefined;
    }
  }

  // Fonts from Font Helper for the lines written as real text.
  const writtenLines = plan.lines.filter((lp) => !lp.reason);
  const embedded = new Map<string, EmbeddedFont>();
  for (const lp of writtenLines) {
    for (const key of lp.glyphFont) {
      if (embedded.has(key)) continue;
      embedded.set(key, embedFont(doc, plan.fonts.get(key)!, freeName(fontDict, "R")));
    }
  }

  // Figma's invisible fonts for the lines that stay as outlines.
  const rename = new Map<string, string>();
  const keptLines = plan.lines.filter((lp) => lp.reason);
  if (keptLines.length) {
    const aFonts = asDict(dictGet(aDoc, pageResources(aDoc, aDoc.getPage(0)), "Font"));
    const copier = PDFObjectCopier.for(aDoc.context, doc.context);
    for (const lp of keptLines) {
      for (const part of lp.line.parts) {
        if (part.kind !== "font" || rename.has(part.name)) continue;
        const src = aFonts?.get(PDFName.of(part.name));
        if (!src) continue;
        const n = freeName(fontDict, "FigmaGlyphs");
        const copied = src instanceof PDFRef ? copier.copy(lookup(aDoc, src)!) : copier.copy(src);
        fontDict.set(PDFName.of(n), copied instanceof PDFRef ? copied : doc.context.register(copied));
        rename.set(part.name, n);
      }
    }
  }

  let text = "";
  for (const lp of plan.lines) {
    text += lp.reason ? hiddenLine(lp.line, rename) : realLine(lp, embedded, colorSpace);
  }

  const original = b ? stripTextBlocks(pageContent(doc, page)) : "";
  const content = `q\n${original}\nQ\n${text}`;
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(fromLatin1(content))));
  return { doc, written: writtenLines.length, kept: keptLines.length };
}

