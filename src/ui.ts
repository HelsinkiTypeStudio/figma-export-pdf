// figma-export-pdf, the plugin's hidden window: reads Figma's export of each page, asks
// Font Helper for the fonts, swaps the letter outlines for real text and saves the PDF.
// It only shows itself if you ask for the details at the end.
import { PDFDocument } from "pdf-lib";
import { readExportA } from "./pdf/figma-a";
import { assemblePage } from "./pdf/assemble";
import { planPage, finishPlan, PagePlan } from "./plan";
import { Helper } from "./helper";
import type { PageJob, ToMain, ToUI } from "./types";

const send = (m: ToMain) => parent.postMessage({ pluginMessage: m }, "*");

const helper = new Helper(null, (key) => send({ type: "set-key", key }));

interface PageState {
  job: PageJob;
  plan?: PagePlan;
  result: PDFDocument;
  note?: string;
}

let pages: PageState[] = [];
let fileName = "Export";
let started = 0;
/** Where the time went, shown under Details. */
let timing: string[] = [];

/** Checks Font Helper is running and allows this plugin. Returns why not, if it can't be used. */
async function checkHelper(): Promise<string | null> {
  let s = await helper.status();
  if (s === "offline") return "Font Helper isn't running. Open it from Applications and try again.";
  if (s === "unpaired") {
    send({ type: "status", text: "Click Allow in Font Helper's window" });
    const ok = await helper.pair().catch(() => false);
    if (!ok) return "Font Helper didn't allow this plugin.";
    s = await helper.status();
  }
  return s === "ok" ? null : "Font Helper didn't accept this plugin's key. Try again.";
}

async function onPage(job: PageJob) {
  const t = Date.now();
  const aDoc = await PDFDocument.load(job.a, { updateMetadata: false, parseSpeed: Infinity });
  const st: PageState = { job, result: aDoc };
  pages[job.index] = st;
  try {
    const a = readExportA(aDoc);
    const plan = planPage(a, job.texts);
    st.plan = plan;
    for (const fp of plan.fonts.values()) {
      fp.prepared = await helper.prepare(fp.request);
    }
    finishPlan(plan);
    assemblePage(aDoc, a, plan);
  } catch (e) {
    // Anything unexpected: this page stays exactly as Figma exported it.
    st.result = await PDFDocument.load(job.a, { updateMetadata: false, parseSpeed: Infinity });
    st.note = `page kept as Figma exported it: ${(e as Error).message}`;
    for (const lp of st.plan?.lines ?? []) if (!lp.reason) lp.reason = "page kept as Figma exported it";
  }
  pageMs += Date.now() - t;
}
let pageMs = 0;

function counts(): { written: number; total: number } {
  let written = 0, total = 0;
  for (const p of pages) for (const lp of p?.plan?.lines ?? []) { total++; if (!lp.reason) written++; }
  return { written, total };
}

function report(): string {
  const { written, total } = counts();
  const reasons = new Map<string, Set<string>>();
  const fonts = new Set<string>();
  for (const p of pages) {
    if (!p) continue;
    const page = `${p.job.index + 1} ${p.job.name}`;
    if (p.note) reasons.set(p.note, (reasons.get(p.note) ?? new Set()).add(page));
    for (const lp of p.plan?.lines ?? []) {
      if (lp.reason) {
        const where = lp.match ? `${page}: ${lp.match.text.name}` : page;
        reasons.set(lp.reason, (reasons.get(lp.reason) ?? new Set()).add(where));
      } else {
        for (const k of new Set(lp.glyphFont)) {
          const r = p.plan!.fonts.get(k)!.request;
          fonts.add(`${r.family} ${r.style}`);
        }
      }
    }
  }
  const out: string[] = [];
  out.push(`${written} of ${total} lines are real text${fonts.size ? ` in ${[...fonts].sort().join(", ")}` : ""}.`);
  if (reasons.size) {
    out.push("", "Kept as Figma's outlines:");
    for (const [r, where] of reasons) {
      const list = [...where];
      out.push(`• ${r} (${list.slice(0, 3).join("; ")}${list.length > 3 ? `; and ${list.length - 3} more` : ""})`);
    }
  }
  if (timing.length) out.push("", "Time: " + timing.join("; ") + ".");
  return out.join("\n");
}

async function onDone() {
  timing.push(`exporting ${((Date.now() - started - pageMs) / 1000).toFixed(1)} s, fonts and real text ${(pageMs / 1000).toFixed(1)} s`);
  const t0 = Date.now();
  const out = await PDFDocument.create();
  for (const p of pages) {
    if (!p) continue;
    const [page] = await out.copyPages(p.result, [0]);
    out.addPage(page);
  }
  const t1 = Date.now();
  out.setTitle(fileName);
  out.setProducer("figma-export-pdf with Font Helper");
  out.setCreator("Figma");
  const bytes = await out.save({ useObjectStreams: true, objectsPerTick: Infinity });
  timing.push(`joining pages ${((t1 - t0) / 1000).toFixed(1)} s, writing the file ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  send({ type: "status", text: "Choose where to save the PDF", fraction: 1 });
  const t2 = Date.now();
  const saved = await helper.save(`${fileName.replace(/[\/:]/g, "-")}.pdf`, bytes);
  timing.push(`saving ${((Date.now() - t2) / 1000).toFixed(1)} s (dialog and making it smaller included)`);
  // The details stay in the plugin console for anyone who wants them.
  console.log(report());
  send({ type: "finished", message: saved ? "PDF saved" : "PDF not saved", report: "" });
}

function showDetails(text: string) {
  document.getElementById("report")!.textContent = text;
  document.body.hidden = false;
}

window.onmessage = async (ev: MessageEvent) => {
  const m = ev.data.pluginMessage as ToUI | undefined;
  if (!m) return;
  try {
    switch (m.type) {
      case "init": {
        helper.key = m.key;
        pages = [];
        fileName = m.fileName;
        started = Date.now();
        timing = [];
        pageMs = 0;
        const problem = await checkHelper();
        send(problem ? { type: "stop", message: problem } : { type: "go" });
        break;
      }
      case "page":
        await onPage(m.job);
        send({ type: "page-done" });
        break;
      case "done":
        await onDone();
        break;
      case "details":
        showDetails(m.report);
        break;
    }
  } catch (e) {
    send({ type: "finished", message: "Export failed", report: (e as Error).message, error: true });
  }
};

document.getElementById("close")!.onclick = () => send({ type: "close" });
