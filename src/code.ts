// figma-export-pdf, Figma side. Choosing the plugin starts the export straight away: no
// window, no button, and nothing in your file changes. Each frame or slide is exported once
// with Figma's own PDF export, whose hidden text layer gives every glyph's exact position.
// The plugin's hidden window (ui.ts) asks Font Helper for the fonts, swaps Figma's letter
// outlines for real text and saves the PDF. Progress shows at the bottom of the screen.
import { solidFill } from "./fills";
import type { PageJob, TextInfo, ToMain, ToUI } from "./types";

const KEY = "fontHelperKey";
const post = (m: ToUI) => figma.ui.postMessage(m);

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- messages at the bottom of the screen ----------

let cancelled = false;
let shown: NotificationHandler | undefined;

/** Shows a message, replacing the one before. */
function say(text: string, options: NotificationOptions = {}) {
  const old = shown;
  shown = figma.notify(text, options);
  old?.cancel();
}

let label = "Exporting";
let fraction = 0;

let pageCount = 1;

/** A text progress bar, one circle per page, since the message at the bottom of the screen can only show text. */
function bar(f: number): string {
  const full = Math.round(Math.max(0, Math.min(1, f)) * pageCount);
  return "●".repeat(full) + "○".repeat(pageCount - full);
}

/** Shows the progress bar, with a new label or how far along it is. */
function progress(f: number = fraction, text: string = label) {
  fraction = f;
  label = text;
  say(`${label}   ${bar(fraction)}`, {
    timeout: Infinity,
    button: { text: "Cancel", action: () => { cancelled = true; finish("Export cancelled."); return true; } },
  });
}

let closing = false;

/** Ends the run with a short message (and, when it failed, a Details button); the plugin closes once the message has gone. */
function finish(message: string, report = "", error = false) {
  if (closing) return;
  closing = true;
  const close = () => { shown = undefined; figma.closePlugin(); };
  say(message, {
    error,
    timeout: report ? 12000 : 6000,
    button: report ? {
      text: "Details",
      action: () => {
        // Keep the plugin open to show the details; closing the window ends it.
        figma.ui.resize(360, 420);
        figma.ui.show();
        post({ type: "details", report });
        return true;
      },
    } : undefined,
    onDequeue: (reason) => { if (reason !== "action_button_click") close(); },
  });
}

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
    // Every slide, in order, whatever is selected.
    return slidesInOrder();
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

const EFFECT_NAMES: Record<string, string> = {
  DROP_SHADOW: "drop shadow", INNER_SHADOW: "inner shadow", LAYER_BLUR: "layer blur", BACKGROUND_BLUR: "background blur",
};

/** Effects that change how the layer's contents look. A frame's shadows and background blur don't touch what's inside it; on text, every effect counts. */
function effectProblem(n: SceneNode): string | undefined {
  if (!("effects" in n) || !Array.isArray(n.effects)) return undefined;
  const isText = n.type === "TEXT";
  for (const e of n.effects) {
    if (!e.visible) continue;
    if (!isText && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW" || e.type === "BACKGROUND_BLUR")) continue;
    const name = EFFECT_NAMES[e.type] ?? e.type.toLowerCase().replace(/_/g, " ");
    return isText ? `text with a ${name}` : `inside a layer with a ${name}`;
  }
  return undefined;
}

/** Layer-level reasons a node changes how what's inside it looks. */
function layerProblem(n: SceneNode): string | undefined {
  if ("opacity" in n && n.opacity < 1) return "see-through layer";
  if ("blendMode" in n && n.blendMode !== "PASS_THROUGH" && n.blendMode !== "NORMAL") return "layer blend mode";
  return effectProblem(n);
}

interface TextRecord {
  node: TextNode;
  order: number;
  reason?: string;
}

/** Walks the frame or slide in drawing order, noting for each text layer anything that stops it from becoming real text. */
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

figma.showUI(__html__, { visible: false, width: 360, height: 420, themeColors: true });

let pageDone: (() => void) | undefined;
let uiReady: ((m: ToMain) => void) | undefined;

figma.ui.onmessage = async (m: ToMain) => {
  switch (m.type) {
    case "set-key":
      await figma.clientStorage.setAsync(KEY, m.key);
      break;
    case "go": case "stop":
      uiReady?.(m);
      break;
    case "page-done":
      pageDone?.();
      break;
    case "status":
      if (!cancelled && !closing) progress(m.fraction ?? fraction, m.text ?? label);
      break;
    case "finished":
      finish(m.message, m.report, m.error);
      break;
    case "close":
      figma.closePlugin();
      break;
  }
};

async function run() {
  const roots = pickRoots().filter((n) => "exportAsync" in n);
  if (!roots.length) {
    finish(figma.editorType === "slides" ? "There are no slides to export" : "Select one or more frames to export", "", true);
    return;
  }
  const fileName = (figma.editorType === "slides" || roots.length > 1 ? figma.root.name : roots[0].name) || "Export";
  pageCount = roots.length;
  progress(0, "Exporting");

  const key = ((await figma.clientStorage.getAsync(KEY)) as string | undefined) ?? null;
  const answer = await new Promise<ToMain>((resolve) => {
    uiReady = resolve;
    post({ type: "init", key, count: roots.length, fileName });
  });
  if (answer.type === "stop") { finish("Export failed", answer.message, true); return; }

  for (let i = 0; i < roots.length && !cancelled; i++) {
    const root = roots[i];
    progress(i / roots.length, "Exporting");
    const origin = root.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const { texts } = survey(root);
    const a = await root.exportAsync({ format: "PDF" });
    const job: PageJob = {
      index: i, name: root.name, width: origin.width, height: origin.height, a,
      texts: texts.map((t) => describe(t, origin)),
    };
    await new Promise<void>((resolve) => {
      pageDone = resolve;
      post({ type: "page", job });
    });
  }
  if (!cancelled) {
    progress(1);
    post({ type: "done" });
  }
}

run().catch((e) => finish("Export failed", errText(e), true));
