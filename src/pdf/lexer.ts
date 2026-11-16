// A small lexer for PDF content streams. Content streams are bytes; we read them as
// latin1 strings so that every byte is one character and offsets stay byte offsets.

export type Token =
  | { kind: "num"; value: number; start: number; end: number }
  | { kind: "name"; value: string; start: number; end: number }
  | { kind: "str"; bytes: number[]; start: number; end: number }
  | { kind: "arrayStart" | "arrayEnd" | "dictStart" | "dictEnd"; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number };

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

function isRegular(c: number): boolean {
  return !WHITE.has(c) && !DELIM.has(c);
}

/** Splits a content stream into tokens. Throws on inline images, which Figma doesn't use. */
export function lex(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WHITE.has(c)) { i++; continue; }
    if (c === 0x25) { // % comment
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    const start = i;
    if (c === 0x28) { // ( literal string )
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = s.charCodeAt(i);
        if (ch === 0x5c) { // backslash
          i++;
          const e = s[i];
          if (e >= "0" && e <= "7") {
            let oct = "";
            while (oct.length < 3 && s[i] >= "0" && s[i] <= "7") oct += s[i++];
            bytes.push(parseInt(oct, 8) & 0xff);
            continue;
          }
          const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (e === "\r" || e === "\n") { // line continuation
            i++;
            if (e === "\r" && s[i] === "\n") i++;
            continue;
          }
          bytes.push(e in map ? map[e] : s.charCodeAt(i));
          i++;
          continue;
        }
        if (ch === 0x28) depth++;
        if (ch === 0x29) { depth--; if (depth === 0) { i++; break; } }
        bytes.push(ch);
        i++;
      }
      out.push({ kind: "str", bytes, start, end: i });
      continue;
    }
    if (c === 0x3c) { // < hex string > or << dict
      if (s[i + 1] === "<") { out.push({ kind: "dictStart", start, end: i + 2 }); i += 2; continue; }
      i++;
      let hex = "";
      while (i < n && s[i] !== ">") { if (!WHITE.has(s.charCodeAt(i))) hex += s[i]; i++; }
      i++;
      if (hex.length % 2) hex += "0";
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      out.push({ kind: "str", bytes, start, end: i });
      continue;
    }
    if (c === 0x3e && s[i + 1] === ">") { out.push({ kind: "dictEnd", start, end: i + 2 }); i += 2; continue; }
    if (c === 0x5b) { out.push({ kind: "arrayStart", start, end: i + 1 }); i++; continue; }
    if (c === 0x5d) { out.push({ kind: "arrayEnd", start, end: i + 1 }); i++; continue; }
    if (c === 0x2f) { // /Name
      i++;
      while (i < n && isRegular(s.charCodeAt(i))) i++;
      const raw = s.slice(start + 1, i).replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      out.push({ kind: "name", value: raw, start, end: i });
      continue;
    }
    if (c === 0x7b || c === 0x7d) { i++; continue; } // { } only in PostScript functions
    while (i < n && isRegular(s.charCodeAt(i))) i++;
    const word = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ kind: "num", value: parseFloat(word), start, end: i });
    } else {
      if (word === "BI") throw new Error("inline images are not supported");
      out.push({ kind: "op", value: word, start, end: i });
    }
  }
  return out;
}

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m then n, in PDF's row-vector convention (the result of "m cm" inside n). */
export function multiply(m: Matrix, n: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const [A, B, C, D, E, F] = n;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function matrixString(m: Matrix): string {
  return m.map(fmt).join(" ");
}

/** A PDF literal string for raw bytes, with every byte escaped as octal where needed. */
export function literal(bytes: number[]): string {
  let s = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
}
