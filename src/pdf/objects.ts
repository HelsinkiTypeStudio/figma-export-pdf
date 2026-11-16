// Helpers for reading objects with pdf-lib's low-level API.
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRawStream, PDFRef, PDFStream,
  decodePDFRawStream,
} from "pdf-lib";

export function lookup(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  if (o instanceof PDFRef) return doc.context.lookup(o);
  return o;
}

export function dictGet(doc: PDFDocument, d: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!d) return undefined;
  return lookup(doc, d.get(PDFName.of(key)));
}

export function asDict(o: PDFObject | undefined): PDFDict | undefined {
  return o instanceof PDFDict ? o : undefined;
}

export function asNumber(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

export function asNumbers(doc: PDFDocument, o: PDFObject | undefined): number[] {
  const a = lookup(doc, o);
  if (!(a instanceof PDFArray)) return [];
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) out.push(asNumber(lookup(doc, a.get(i))) ?? 0);
  return out;
}

export function streamBytes(o: PDFObject | undefined): Uint8Array {
  if (o instanceof PDFRawStream) return decodePDFRawStream(o).decode();
  if (o instanceof PDFStream) return (o as unknown as { getContents(): Uint8Array }).getContents();
  throw new Error("not a stream");
}

export function latin1(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return s;
}

export function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** The page's content streams joined into one string. */
export function pageContent(doc: PDFDocument, page: PDFPage): string {
  const c = lookup(doc, page.node.get(PDFName.of("Contents")));
  if (c instanceof PDFArray) {
    const parts: string[] = [];
    for (let i = 0; i < c.size(); i++) parts.push(latin1(streamBytes(lookup(doc, c.get(i)))));
    return parts.join("\n");
  }
  if (!c) return "";
  return latin1(streamBytes(c));
}

/** The page's resource dictionary (inherited resources included). */
export function pageResources(doc: PDFDocument, page: PDFPage): PDFDict {
  let node: PDFDict | undefined = page.node;
  while (node) {
    const r = asDict(dictGet(doc, node, "Resources"));
    if (r) return r;
    node = asDict(dictGet(doc, node, "Parent"));
  }
  const r = doc.context.obj({});
  page.node.set(PDFName.of("Resources"), r);
  return r;
}
