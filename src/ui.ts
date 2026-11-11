// figma-export-pdf, plugin window side: reads Figma's exports, asks Font Helper for the
// fonts, writes the real text and saves the PDF.
import { PDFDocument } from "pdf-lib";
import { readExportA, ExportA } from "./pdf/figma-a";
import { assemblePage } from "./pdf/assemble";
import { planPage, finishPlan, PagePlan } from "./plan";
import { Helper } from "./helper";
import type { PageJob, ToMain, ToUI } from "./types";

const $ = (id: string) => document.getElementById(id)!;
const send = (m: ToMain) => parent.postMessage({ pluginMessage: m }, "*");

const helper = new Helper(null, (key) => send({ type: "set-key", key }));

interface PageState {
  job: PageJob;
  aDoc?: PDFDocument;
  a?: ExportA;
  plan?: PagePlan;
  result?: PDFDocument;
  note?: string;
}

let pages: PageState[] = [];
let fileName = "Export";
let started = 0;

function setStatus(text: string, kind: "" | "ok" | "bad" = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

function setBusy(busy: boolean) {
  ($("export") as HTMLButtonElement).disabled = busy;
}

async function checkHelper(): Promise<boolean> {
  let s = await helper.status();
  if (s === "offline") {
    setStatus("Font Helper isn't running. Start it from Applications, then try again. Without it, all text stays as Figma's outlines.", "bad");
    return false;
  }
  if (s === "unpaired") {
    setStatus("Font Helper is asking whether to allow this plugin. Click Allow in its dialog.");
    const ok = await helper.pair().catch(() => false);
    if (!ok) { setStatus("Font Helper didn't allow this plugin.", "bad"); return false; }
    s = await helper.status();
  }
  return s === "ok";
}

async function onPageA(job: PageJob) {
  const st: PageState = { job };
  pages[job.index] = st;
  let ranges: { id: string; start: number; end: number }[] = [];
  try {
    st.aDoc = await PDFDocument.load(job.a, { updateMetadata: false });
    st.a = readExportA(st.aDoc);
    st.plan = planPage(st.a, job.texts);
    for (const fp of st.plan.fonts.values()) {
      setStatus(`${job.name}: checking ${fp.request.family} ${fp.request.style}…`);
      fp.prepared = await helper.prepare(fp.request);
    }
    finishPlan(st.plan);
    ranges = st.plan.clear;
  } catch (e) {
    st.note = `kept as Figma exported it: ${(e as Error).message}`;
    st.plan = undefined;
  }
  send({ type: "clear", index: job.index, ranges });
}

async function onPageB(m: Extract<ToUI, { type: "page-b" }>) {
  const st = pages[m.index];
  if (!st.aDoc || !st.a || !st.plan) return;
  try {
    // A layer the Figma side couldn't change still has its outlines: keep its lines as outlines too.
    if (m.failed.length) {
      const failed = new Set(m.failed);
      for (const lp of st.plan.lines) if (!lp.reason && lp.match && failed.has(lp.match.text.id)) lp.reason = "couldn't change the layer";
    }
    if (!st.plan.clear.length) { st.result = st.aDoc; return; }
    if (!m.b && !m.nothingVisible) throw new Error(m.problem || "the second export failed");
    const r = await assemblePage(st.aDoc, st.a, m.b, st.plan);
    st.result = r.doc;
  } catch (e) {
    st.result = st.aDoc;
    st.note = `kept as Figma exported it: ${(e as Error).message}`;
    for (const lp of st.plan.lines) if (!lp.reason) lp.reason = "page kept as Figma exported it";
  }
}

function report(): string {
  let written = 0, kept = 0;
  const reasons = new Map<string, Set<string>>();
  const fonts = new Set<string>();
  for (const p of pages) {
    if (!p) continue;
    if (p.note) reasons.set(p.note, (reasons.get(p.note) ?? new Set()).add(p.job.name));
    for (const lp of p.plan?.lines ?? []) {
      if (lp.reason) {
        kept++;
        const where = lp.match ? `${p.job.name}: ${lp.match.text.name}` : p.job.name;
        reasons.set(lp.reason, (reasons.get(lp.reason) ?? new Set()).add(where));
      } else {
        written++;
        for (const k of new Set(lp.glyphFont)) {
          const r = p.plan!.fonts.get(k)!.request;
          fonts.add(`${r.family} ${r.style}`);
        }
      }
    }
  }
  const out: string[] = [];
  out.push(`${written} of ${written + kept} lines are real text${fonts.size ? ` in ${[...fonts].sort().join(", ")}` : ""}.`);
  if (reasons.size) {
    out.push("", "Kept as Figma's outlines:");
    for (const [r, where] of reasons) {
      const list = [...where];
      out.push(`• ${r} (${list.slice(0, 3).join("; ")}${list.length > 3 ? `; and ${list.length - 3} more` : ""})`);
    }
  }
  return out.join("\n");
}

async function onDone() {
  try {
    setStatus("Putting the pages together…");
    const out = await PDFDocument.create();
    for (const p of pages) {
      if (!p?.result) continue;
      const [page] = await out.copyPages(p.result, [0]);
      out.addPage(page);
    }
    out.setTitle(fileName);
    out.setProducer("figma-export-pdf with Font Helper");
    out.setCreator("Figma");
    const bytes = await out.save({ useObjectStreams: true });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    setStatus(`Ready (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${seconds} s). Choose where to save it.`);
    const saved = await helper.save(`${fileName.replace(/[\/:]/g, "-")}.pdf`, bytes);
    $("report").textContent = report();
    if (saved) {
      setStatus(`Saved ${saved.split("/").pop()} (${(bytes.length / 1024 / 1024).toFixed(1)} MB).`, "ok");
      send({ type: "notify", text: "PDF saved" });
    } else {
      setStatus("Not saved.");
    }
  } catch (e) {
    setStatus(`Couldn't finish: ${(e as Error).message}`, "bad");
  } finally {
    setBusy(false);
  }
}

window.onmessage = async (ev: MessageEvent) => {
  const m = ev.data.pluginMessage as ToUI | undefined;
  if (!m) return;
  switch (m.type) {
    case "key":
      helper.key = m.key;
      break;
    case "start":
      pages = [];
      fileName = m.fileName;
      setStatus(`Exporting ${m.count} ${m.count === 1 ? "page" : "pages"}…`);
      break;
    case "progress":
      setStatus(m.text);
      break;
    case "page-a":
      await onPageA(m.job);
      break;
    case "page-b":
      await onPageB(m);
      break;
    case "done":
      await onDone();
      break;
    case "error":
      setStatus(m.message, "bad");
      setBusy(false);
      break;
  }
};

$("export").onclick = async () => {
  setBusy(true);
  $("report").textContent = "";
  started = Date.now();
  if (!(await checkHelper())) { setBusy(false); return; }
  send({ type: "run" });
};

send({ type: "get-key" });
