import type { SolidFill } from "./types";

interface PaintLike {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: { r: number; g: number; b: number };
}

/** The single solid colour of a text range, or the reason it can't be written as real text. */
export function solidFill(fills: readonly PaintLike[] | unknown): { fill: SolidFill | null; problem?: string } {
  if (!Array.isArray(fills)) return { fill: null, problem: "mixed fills" };
  const visible = (fills as PaintLike[]).filter((f) => f.visible !== false && (f.opacity ?? 1) > 0);
  if (visible.length === 0) return { fill: null, problem: "no visible fill" };
  if (visible.length > 1) return { fill: null, problem: "more than one fill" };
  const f = visible[0];
  if (f.type !== "SOLID" || !f.color) return { fill: null, problem: f.type.startsWith("GRADIENT") ? "gradient fill" : `${f.type.toLowerCase()} fill` };
  if ((f.opacity ?? 1) < 1) return { fill: null, problem: "see-through fill" };
  if (f.blendMode && f.blendMode !== "NORMAL" && f.blendMode !== "PASS_THROUGH") return { fill: null, problem: "fill blend mode" };
  return { fill: { r: f.color.r, g: f.color.g, b: f.color.b } };
}
