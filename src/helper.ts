// Talks to Font Helper, the menu bar app that serves the fonts installed on this Mac.
import type { FontRequest, PreparedFont } from "./plan";

const BASE = "http://localhost:7337";

export class Helper {
  constructor(public key: string | null, private onKey: (key: string | null) => void) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.key) h["X-Helper-Key"] = this.key;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** "ok", "unpaired" or "offline". */
  async status(): Promise<"ok" | "unpaired" | "offline"> {
    try {
      const r = await fetch(`${BASE}/ping`, { headers: this.headers() });
      const j = await r.json();
      return j.paired ? "ok" : "unpaired";
    } catch {
      return "offline";
    }
  }

  /** Asks Font Helper for a key; it shows you an Allow dialog first. */
  async pair(): Promise<boolean> {
    const r = await fetch(`${BASE}/pair`, {
      method: "POST", headers: this.headers(true), body: JSON.stringify({ plugin: "Export PDF with Real Text" }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    this.key = j.key;
    this.onKey(this.key);
    return true;
  }

  async prepare(req: FontRequest): Promise<PreparedFont> {
    try {
      const r = await fetch(`${BASE}/fonts/prepare`, { method: "POST", headers: this.headers(true), body: JSON.stringify(req) });
      if (r.status === 401) { this.key = null; this.onKey(null); return { ok: false, error: "Font Helper doesn't know this plugin any more" }; }
      return (await r.json()) as PreparedFont;
    } catch (e) {
      return { ok: false, error: `Font Helper didn't answer (${(e as Error).message})` };
    }
  }

  /**
   * Shows a save dialog. Font Helper may make the PDF smaller before writing it. Returns the
   * saved path and size, or null if you cancelled.
   */
  async save(name: string, bytes: Uint8Array): Promise<{ path: string; bytes: number } | null> {
    const r = await fetch(`${BASE}/save?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { ...this.headers(), "Content-Type": "application/pdf" }, body: new Blob([bytes as BlobPart]),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.saved ? { path: j.saved, bytes: j.bytes ?? bytes.length } : null;
  }
}
