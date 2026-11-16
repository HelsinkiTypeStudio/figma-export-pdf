// Finds the letter outlines Figma drew for each line, so they can be taken out of export A
// and replaced by real text. Nothing else in the drawing is touched.
//
// Figma fills each text layer's letters as one path, one closed contour after another.
// A contour belongs to a glyph when it lies inside that glyph's box, measured in the line's
// own text space, so rotated and scaled text works too. Only contours of plain solid
// fills in the page's own content are considered.
import { lex, multiply, apply, Matrix, IDENTITY } from "./lexer";
import type { HiddenLine } from "./figma-a";

export interface Contour {
  /** Byte range of this contour's operators (operands included) in its stream. */
  start: number;
  end: number;
  /** Its points on the page. */
  points: [number, number][];
  path: PathInfo;
  /** Set when it isn't fully inside the area a mask lets through, so it can't be replaced. */
  masked?: boolean;
}

export interface PathInfo {
  /** The content stream it is in: the page's own, or a form drawn by the page. */
  stream: Scope;
  /** Byte range of the painting operator ("f" or "f*"). */
  paintStart: number;
  paintEnd: number;
  fill: number[];          // operands of the last scn/sc/rg before it
  contours: Contour[];
}

/**
 * One content stream and what its names refer to. Slides wrap most of a slide in a form
 * (a group drawn by the page with "Do"); its letters are found and taken out there.
 */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export interface Scope {
  content: string;
  /**
   * Whether painting under this graphics state looks the same as painting plainly (full
   * opacity, normal blending, no mask): true or false, or, for a mask that only lets a
   * rectangle through (Figma's way of clipping a slide or frame), that rectangle in the
   * current user space.
   */
  plainState(name: string): boolean | Rect;
  /** A form this stream draws: only one drawn exactly once, so changing it changes nothing else. */
  form(name: string): { scope: Scope; matrix: Matrix } | undefined;
}

/** Every filled path of the content stream (outside text blocks) and of the forms it draws, with their contours. */
export function readPaths(scope: Scope, start: Matrix = IDENTITY, masksAtStart: Rect[] = [], depth = 0, paths: PathInfo[] = []): PathInfo[] {
  const tokens = lex(scope.content);
  let ctm: Matrix = start;
  let plain = true;
  let masks = masksAtStart;      // areas on the page that masks let through
  const stack: { ctm: Matrix; fill: number[]; plain: boolean; masks: Rect[] }[] = [];
  let fill: number[] = [];
  let nums: number[] = [];
  let name = "";
  let operandStart = -1;
  let contours: Contour[] = [];
  let current: Contour | undefined;
  let clip = false;
  let inText = false;
  let arrays = 0;

  const endPath = () => { current = undefined; contours = []; clip = false; };

  for (const t of tokens) {
    if (t.kind === "arrayStart") { arrays++; continue; }
    if (t.kind === "arrayEnd") { arrays--; continue; }
    if (arrays > 0) continue;
    if (t.kind !== "op") {
      if (operandStart < 0) operandStart = t.start;
      if (t.kind === "num") nums.push(t.value);
      if (t.kind === "name") name = t.value;
      continue;
    }
    const op = t.value;
    const opStart = operandStart >= 0 ? operandStart : t.start;
    if (inText) {
      if (op === "ET") inText = false;
    } else {
      switch (op) {
        case "BT": inText = true; break;
        case "q": stack.push({ ctm, fill, plain, masks }); break;
        case "Q": { const s = stack.pop(); if (s) { ctm = s.ctm; fill = s.fill; plain = s.plain; masks = s.masks; } break; }
        case "cm": if (nums.length >= 6) ctm = multiply(nums.slice(-6) as Matrix, ctm); break;
        case "gs": {
          const st = scope.plainState(name);
          if (st === false) plain = false;
          else if (st !== true) {
            const r = pageRect(ctm, st);
            if (r) masks = masks.concat([r]); else plain = false;
          }
          break;
        }
        case "sc": case "scn": case "rg": case "g": case "k": fill = nums.slice(); break;
        case "Do":
          if (plain && depth < 4) {
            const f = scope.form(name);
            if (f) readPaths(f.scope, multiply(f.matrix, ctm), masks, depth + 1, paths);
          }
          break;
        case "m":
          if (current) current.end = opStart;
          current = { start: opStart, end: t.end, points: [apply(ctm, nums[0], nums[1])], path: undefined as unknown as PathInfo };
          contours.push(current);
          break;
        case "l":
          if (current) { current.points.push(apply(ctm, nums[0], nums[1])); current.end = t.end; }
          break;
        case "c": case "v": case "y":
          if (current) {
            for (let i = 0; i + 1 < nums.length; i += 2) current.points.push(apply(ctm, nums[i], nums[i + 1]));
            current.end = t.end;
          }
          break;
        case "h":
          if (current) current.end = t.end;
          break;
        case "re":
          // Rectangles aren't letters; a path that has one is never touched.
          contours.push({ start: opStart, end: t.end, points: [], path: undefined as unknown as PathInfo });
          current = undefined;
          clip = true;
          break;
        case "W": case "W*": clip = true; break;
        case "f": case "f*": case "F":
          // Letters drawn see-through, blended or masked stay as they are.
          if (!clip && plain && contours.length) {
            const p: PathInfo = { stream: scope, paintStart: opStart, paintEnd: t.end, fill, contours };
            for (const c of contours) {
              c.path = p;
              if (masks.some((r) => c.points.some(([x, y]) => x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1))) c.masked = true;
            }
            paths.push(p);
          }
          endPath();
          break;
        case "S": case "s": case "B": case "B*": case "b": case "b*": case "n":
          endPath();
          break;
      }
    }
    nums = [];
    name = "";
    operandStart = -1;
  }
  return paths;
}

/** A rectangle in user space, on the page; only when it stays a rectangle there (no rotation). */
function pageRect(m: Matrix, r: Rect): Rect | undefined {
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return undefined;
  const [ax, ay] = apply(m, r.x0, r.y0);
  const [bx, by] = apply(m, r.x1, r.y1);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

function invert(m: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return undefined;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** A glyph's box in its line's text space. */
export interface GlyphBox {
  line: number;
  glyph: number;
  x0: number; y0: number; x1: number; y1: number;
}

/**
 * Assigns contours to glyphs. `boxes` gives, per line, the box of each glyph in that line's
 * text space (null for glyphs with no outline). Returns for each contour the lines whose
 * glyph boxes contain it.
 */
export function assignContours(paths: PathInfo[], lines: HiddenLine[], boxes: (GlyphBox | null)[][], tolerance: number): Map<Contour, GlyphBox[]> {
  const out = new Map<Contour, GlyphBox[]>();
  const inv = lines.map((l) => invert(multiply(l.tm, l.ctm)));
  // Each line's area on the page, to skip lines quickly.
  const pageBox = lines.map((l, li) => {
    const m = multiply(l.tm, l.ctm);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes[li]) {
      if (!b) continue;
      for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        const [px, py] = apply(m, x, y);
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    return { x0, y0, x1, y1 };
  });
  for (const p of paths) {
    for (const c of p.contours) {
      if (c.points.length < 2 || c.masked) continue;
      let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
      for (const [x, y] of c.points) { cx0 = Math.min(cx0, x); cy0 = Math.min(cy0, y); cx1 = Math.max(cx1, x); cy1 = Math.max(cy1, y); }
      const hits: GlyphBox[] = [];
      lines.forEach((l, li) => {
        const pb = pageBox[li];
        const im = inv[li];
        if (!im || cx1 < pb.x0 - 2 || cx0 > pb.x1 + 2 || cy1 < pb.y0 - 2 || cy0 > pb.y1 + 2) return;
        // The contour in the line's text space.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of c.points) {
          const [u, v] = apply(im, x, y);
          x0 = Math.min(x0, u); y0 = Math.min(y0, v); x1 = Math.max(x1, u); y1 = Math.max(y1, v);
        }
        for (const b of boxes[li]) {
          if (!b) continue;
          const tol = tolerance * (l.glyphs[b.glyph]?.size || 1);
          if (x0 >= b.x0 - tol && x1 <= b.x1 + tol && y0 >= b.y0 - tol && y1 <= b.y1 + tol) hits.push(b);
        }
      });
      if (hits.length) out.set(c, hits);
    }
  }
  return out;
}

/**
 * Removes the given contours (and, in the page's own stream, any extra byte ranges) and
 * returns each changed stream's new content. A path that loses all its contours loses its
 * fill operator too.
 */
export function removeContours(remove: Set<Contour>, page: Scope, extra: [number, number][] = []): Map<Scope, string> {
  const cuts = new Map<Scope, [number, number][]>([[page, extra.slice()]]);
  const byPath = new Map<PathInfo, Contour[]>();
  for (const c of remove) byPath.set(c.path, (byPath.get(c.path) ?? []).concat([c]));
  for (const [p, cs] of byPath) {
    const list = cuts.get(p.stream) ?? [];
    cuts.set(p.stream, list);
    for (const c of cs) list.push([c.start, c.end]);
    if (cs.length === p.contours.length) list.push([p.paintStart, p.paintEnd]);
  }
  const out = new Map<Scope, string>();
  for (const [scope, list] of cuts) {
    list.sort((a, b) => a[0] - b[0]);
    const content = scope.content;
    let s = "";
    let last = 0;
    for (const [a, b] of list) {
      if (a < last) continue;
      s += content.slice(last, a) + " ";
      last = b;
    }
    out.set(scope, s + content.slice(last));
  }
  return out;
}
