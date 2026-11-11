// Runs the plugin's PDF side outside Figma, on exports saved by the figma-export-pdf test
// plugin (test02): "<stem>-A-as-is.pdf", "<stem>-B-all-text-cleared.pdf", "<stem>-texts.json".
// Font Helper's font work (fontwork.py) is run directly, with font files found by family name.
//
// node test/run.mjs <exports folder> <fonts folder> <path to fontwork.py> <output folder>
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { readExportA } from "../src/pdf/figma-a";
import { planPage, finishPlan } from "../src/plan";
import { assemblePage } from "../src/pdf/assemble";
import { solidFill } from "../src/fills";
import type { TextInfo } from "../src/types";

const [exportsDir, fontsDir, fontwork, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const index: Record<string, string[]> = JSON.parse(spawnSync("python3", ["-c", `
import glob, os, json, sys
from fontTools.ttLib import TTFont
out = {}
for p in glob.glob(os.path.join(sys.argv[1], "**", "*.[ot]tf"), recursive=True):
    try:
        n = TTFont(p, lazy=True)["name"]
        out.setdefault(n.getDebugName(16) or n.getDebugName(1), []).append(p)
    except Exception: pass
print(json.dumps(out))`, fontsDir], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout);

function prepare(req: object): any {
  const r = spawnSync("python3", [fontwork], { input: JSON.stringify(req) + "\n", encoding: "utf8", maxBuffer: 1 << 28 });
  return JSON.parse(r.stdout);
}

function texts(json: any): TextInfo[] {
  return json.texts.map((t: any) => ({
    id: t.id, name: t.name, characters: t.characters,
    box: t.relativeBox ?? { x: 0, y: 0, width: 0, height: 0 },
    segments: t.segments.map((s: any) => {
      const f = solidFill(s.fills);
      return { start: s.start, end: s.end, fontName: s.fontName, fontSize: s.fontSize, fill: f.fill, fillProblem: f.problem, textDecoration: s.textDecoration };
    }),
  }));
}

async function main() {
  const stems = readdirSync(exportsDir).filter((f) => f.endsWith("-A-as-is.pdf")).map((f) => f.slice(0, -"-A-as-is.pdf".length));
  for (const stem of stems) {
    let json: any, bBytes: Uint8Array;
    try {
      json = JSON.parse(readFileSync(join(exportsDir, stem + "-texts.json"), "utf8"));
      bBytes = readFileSync(join(exportsDir, stem + "-B-all-text-cleared.pdf"));
    } catch { continue; }
    const t0 = Date.now();
    const aDoc = await PDFDocument.load(readFileSync(join(exportsDir, stem + "-A-as-is.pdf")));
    const a = readExportA(aDoc);
    const plan = planPage(a, texts(json));
    for (const fp of plan.fonts.values()) {
      const files = index[fp.request.family] ?? [];
      fp.prepared = files.length
        ? prepare({ id: 1, op: "prepare", candidates: files.map((p) => ({ path: p })), ...fp.request })
        : { ok: false, error: "not installed" };
    }
    finishPlan(plan);
    try {
      const { doc, written, kept } = await assemblePage(aDoc, a, bBytes, plan);
      const bytes = await doc.save({ useObjectStreams: true });
      const out = join(outDir, basename(stem) + "-real-text.pdf");
      writeFileSync(out, bytes);
      const reasons = new Map<string, number>();
      for (const lp of plan.lines) if (lp.reason) reasons.set(lp.reason, (reasons.get(lp.reason) ?? 0) + 1);
      console.log(`${basename(stem)}: ${a.lines.length} lines, ${written} written as real text, ${kept} kept as outlines; ` +
        `${plan.fonts.size} fonts; ${(bytes.length / 1024).toFixed(0)} KB; ${Date.now() - t0} ms`);
      for (const [r, n] of reasons) console.log(`    ${n} × ${r}`);
    } catch (e) {
      console.log(`${basename(stem)}: FAILED ${(e as Error).stack}`);
    }
  }
}
main();
