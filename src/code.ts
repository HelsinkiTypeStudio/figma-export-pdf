// figma-export-pdf, Figma side. It never changes your layers: each frame or slide is
// copied, the copy is exported twice and then deleted.
//   Export A: Figma's own PDF, whose hidden text layer gives every glyph's exact position.
//   Export B: the same copy with the fill cleared on the text the plugin window checked.
// The plugin window (ui.ts) does the PDF work and asks Font Helper for the fonts.
import { solidFill } from "./fills";
import type { ClearRange, PageJob, TextInfo, ToMain, ToUI } from "./types";

figma.showUI(__html__, { width: 340, height: 480, themeColors: true });

const KEY = "fontHelperKey";
const post = (m: ToUI) => figma.ui.postMessage(m);
const waiting = new Map<number, (r: ClearRange[]) => void>();
let running = false;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

figma.ui.onmessage = async (m: ToMain) => {
  switch (m.type) {
    case "get-key":
      post({ type: "key", key: ((await figma.clientStorage.getAsync(KEY)) as string | undefined) ?? null });
      break;
    case "set-key":
      await figma.clientStorage.setAsync(KEY, m.key);
      break;
    case "run":
      if (running) return;
      running = true;
      run().catch((e) => post({ type: "error", message: errText(e) })).then(() => { running = false; });
      break;
    case "clear":
      waiting.get(m.index)?.(m.ranges);
      waiting.delete(m.index);
      break;
    case "notify":
      figma.notify(m.text, { error: !!m.error });
      break;
    case "close":
      figma.closePlugin();
      break;
  }
};

// ---------- what to export ----------

const CONTAINERS = new Set(["FRAME", "GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "SLIDE"]);

/** A selected frame, group or slide exports itself; anything else exports its slide or top-level frame. */
function exportRoot(n: SceneNode): SceneNode {
  if (CONTAINERS.has(n.type)) return n;
  let cur: BaseNode = n;
  while (cur.parent) {
    if (cur.type === "SLIDE") return cur as SceneNode;
    const p: BaseNode = cur.parent;
    if (p.type === "PAGE" || p.type === "SLIDE_ROW" || p.type === "SLIDE_GRID") return cur as SceneNode;
    cur = p;
  }
  return n;
}

function slidesInOrder(): SceneNode[] {
  const grid = (figma as unknown as { getSlideGrid?: () => SceneNode[][] }).getSlideGrid?.();
  return grid ? grid.reduce<SceneNode[]>((all, row) => all.concat(row), []) : [];
}

function pickRoots(): SceneNode[] {
  const sel = figma.currentPage.selection;
  if (figma.editorType === "slides") {
    const all = slidesInOrder();
    if (!sel.length) return all.filter((s) => s.visible);
    const chosen = new Set(sel.map(exportRoot));
    const ordered = all.filter((s) => chosen.has(s));
    return ordered.concat([...chosen].filter((s) => !ordered.includes(s)));
  }
  const list = sel.length
    ? [...new Set(sel.map(exportRoot))]
    : figma.currentPage.children.filter((n) => n.visible && CONTAINERS.has(n.type));
  // Top to bottom, then left to right, like reading the canvas.
  const box = (n: SceneNode) => n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  return list.slice().sort((a, b) => (Math.abs(box(a).y - box(b).y) > 1 ? box(a).y - box(b).y : box(a).x - box(b).x));
}

// ---------- which text can become real text ----------

type Rect = { x: number; y: number; width: number; height: number };

function boundsOf(n: SceneNode): Rect | null {
  return ("absoluteRenderBounds" in n && n.absoluteRenderBounds) || n.absoluteBoundingBox || null;
}

function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0.5 && h > 0.5;
}

function inside(a: Rect, b: Rect): boolean {
  return a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
}

function visiblePaints(p: unknown): boolean {
  return Array.isArray(p) && p.some((x: Paint) => x.visible !== false && (x.opacity ?? 1) > 0);
}

function visibleEffects(n: SceneNode): boolean {
  return "effects" in n && Array.isArray(n.effects) && n.effects.some((e) => e.visible);
}

function paints(n: SceneNode): boolean {
  if ("isMask" in n && n.isMask) return false;
  return ("fills" in n && visiblePaints(n.fills)) || ("strokes" in n && visiblePaints(n.strokes)) || visibleEffects(n);
}

/** Layer-level reasons a node changes how what's inside it looks. */
function layerProblem(n: SceneNode): string | undefined {
  if ("opacity" in n && n.opacity < 1) return "see-through layer";
  if ("blendMode" in n && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") return "layer blend mode";
  if (visibleEffects(n)) return "layer effects";
  return undefined;
}

interface TextRecord {
  node: TextNode;
  order: number;
  reason?: string;
}

/** Walks the copy in drawing order, noting for each text layer anything that stops it from becoming real text. */
function survey(root: SceneNode): { texts: TextRecord[]; order: SceneNode[] } {
  const texts: TextRecord[] = [];
  const order: SceneNode[] = [];
  const walk = (n: SceneNode, clips: Rect[], masked: boolean, problem: string | undefined) => {
    if (!n.visible) return;
    order.push(n);
    const own = layerProblem(n);
    if (n.type === "TEXT") {
      let reason = problem ?? own;
      if (!reason && masked) reason = "masked";
      if (!reason && "strokes" in n && visiblePaints(n.strokes)) reason = "text with a stroke";
      if (!reason && n.textTruncation === "ENDING") reason = "text cut off with an ellipsis";
      const b = boundsOf(n);
      if (!reason && b && clips.some((c) => !inside(b, c))) reason = "cut off by the frame it sits in";
      texts.push({ node: n, order: order.length - 1, reason });
      return;
    }
    if (n.type === "BOOLEAN_OPERATION" || !("children" in n)) return;
    let childClips = clips;
    if (n !== root && "clipsContent" in n && n.clipsContent && n.absoluteBoundingBox) childClips = clips.concat([n.absoluteBoundingBox]);
    const childProblem = problem ?? own;
    let childMasked = masked;
    for (const c of n.children) {
      if ("isMask" in c && c.isMask && c.visible) { childMasked = true; order.push(c); continue; }
      walk(c, childClips, childMasked, childProblem);
    }
  };
  walk(root, [], false, undefined);

  // Covered: anything drawn later that overlaps the text.
  for (const t of texts) {
    if (t.reason) continue;
    const b = boundsOf(t.node);
    if (!b) continue;
    for (let j = t.order + 1; j < order.length; j++) {
      const o = order[j];
      if (!paints(o)) continue;
      const ob = boundsOf(o);
      if (ob && overlaps(b, ob)) { t.reason = `covered by “${o.name}”`; break; }
    }
  }
  return { texts, order };
}

function describe(t: TextRecord, origin: Rect): TextInfo {
  const n = t.node;
  const box = n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const segs = n.getStyledTextSegments(["fontName", "fontSize", "fills", "textDecoration"]);
  return {
    id: n.id,
    name: n.name,
    characters: n.characters,
    box: { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height },
    keepOutlines: t.reason,
    segments: segs.map((s) => {
      const f = solidFill(s.fills);
      const fn = s.fontName as FontName & { variationSettings?: Record<string, number> };
      return {
        start: s.start, end: s.end, fontSize: s.fontSize,
        fontName: { family: fn.family, style: fn.style, variationSettings: fn.variationSettings },
        fill: f.fill, fillProblem: f.problem,
        textDecoration: s.textDecoration,
      };
    }),
  };
}

// ---------- exporting ----------

async function makeCopy(root: SceneNode): Promise<SceneNode> {
  const copy = root.clone();
  if (root.type !== "SLIDE") {
    // Off to the side on the page, so it doesn't push anything around or show over your work.
    const abs = root.absoluteBoundingBox;
    if (copy.parent?.type !== "PAGE") figma.currentPage.appendChild(copy);
    if (abs) { copy.x = abs.x + 100000; copy.y = abs.y; }
  }
  return copy;
}

async function clearText(copy: SceneNode, ranges: ClearRange[]): Promise<string[]> {
  const failed: string[] = [];
  const byId = new Map<string, ClearRange[]>();
  for (const r of ranges) byId.set(r.id, (byId.get(r.id) ?? []).concat([r]));
  for (const [id, rs] of byId) {
    try {
      const n = (await figma.getNodeByIdAsync(id)) as TextNode | null;
      if (!n || n.type !== "TEXT") throw new Error("layer not found");
      for (const f of n.getRangeAllFontNames(0, n.characters.length)) await figma.loadFontAsync(f);
      for (const r of rs) n.setRangeFills(r.start, r.end, []);
    } catch (e) {
      failed.push(id);
    }
  }
  return failed;
}

async function run() {
  const roots = pickRoots().filter((n) => "exportAsync" in n);
  if (!roots.length) {
    post({ type: "error", message: figma.editorType === "slides" ? "There are no slides to export." : "Select one or more frames to export." });
    return;
  }
  const fileName = (roots.length === 1 ? roots[0].name : figma.root.name) || "Export";
  post({ type: "start", count: roots.length, fileName });

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    post({ type: "progress", text: `${root.name} (${i + 1} of ${roots.length})` });
    let copy: SceneNode | undefined;
    try {
      copy = await makeCopy(root);
      const origin = copy.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
      const { texts } = survey(copy);
      const a = await copy.exportAsync({ format: "PDF" });
      const job: PageJob = {
        index: i, name: root.name, width: origin.width, height: origin.height, a,
        texts: texts.map((t) => describe(t, origin)),
      };
      const ranges = await new Promise<ClearRange[]>((resolve) => {
        waiting.set(i, resolve);
        post({ type: "page-a", job });
      });
      const failed = await clearText(copy, ranges);
      let b: Uint8Array | null = null;
      let problem: string | undefined;
      let nothingVisible = false;
      if (ranges.length) {
        try {
          b = await copy.exportAsync({ format: "PDF" });
        } catch (e) {
          problem = errText(e);
          nothingVisible = /visible/i.test(problem);
        }
      }
      post({ type: "page-b", index: i, b, problem, nothingVisible, failed });
    } finally {
      try { copy?.remove(); } catch (e) { /* already gone */ }
    }
  }
  post({ type: "done" });
}
