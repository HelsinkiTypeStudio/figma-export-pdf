// Data passed between the plugin's main code (Figma side) and its window (PDF side).

export interface FontRef {
  family: string;
  style: string;
  variationSettings?: Record<string, number>;
}

export interface SolidFill {
  r: number;
  g: number;
  b: number;
}

export interface TextSegment {
  start: number;
  end: number;
  fontName: FontRef;
  fontSize: number;
  /** The one solid fill, or why this range can't be written as real text. */
  fill: SolidFill | null;
  fillProblem?: string;
  textDecoration: string;
}

export interface TextInfo {
  id: string;
  name: string;
  characters: string;
  segments: TextSegment[];
  /** Box relative to the exported frame or slide, in points. */
  box: { x: number; y: number; width: number; height: number };
  /** Why the whole layer stays as Figma's outlines, if it does. */
  keepOutlines?: string;
}

export interface PageJob {
  index: number;
  name: string;
  width: number;
  height: number;
  a: Uint8Array;
  texts: TextInfo[];
}

export interface ClearRange {
  id: string;
  start: number;
  end: number;
}

export type ToUI =
  | { type: "start"; count: number; fileName: string }
  | { type: "page-a"; job: PageJob }
  | { type: "page-b"; index: number; b: Uint8Array | null; problem?: string; nothingVisible?: boolean; failed: string[] }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "key"; key: string | null }
  | { type: "progress"; text: string };

export type ToMain =
  | { type: "run" }
  | { type: "clear"; index: number; ranges: ClearRange[] }
  | { type: "get-key" }
  | { type: "set-key"; key: string | null }
  | { type: "notify"; text: string; error?: boolean }
  | { type: "close" };
