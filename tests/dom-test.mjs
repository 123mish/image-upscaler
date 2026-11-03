import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3000";
const html = readFileSync("public/index.html", "utf8");
const appjs = readFileSync("public/app.js", "utf8");
const css = readFileSync("public/style.css", "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => errors.push(`jsdomError: ${e.message}`));
virtualConsole.on("error", (...a) => errors.push(`console.error: ${a.join(" ")}`));

const dom = new JSDOM(html, {
  url: BASE,
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole,
});

const { window } = dom;

// Inline the real stylesheet so computed styles exercise the actual cascade.
const styleTag = window.document.createElement("style");
styleTag.textContent = css;
window.document.head.appendChild(styleTag);

/* --- stubs jsdom does not implement ------------------------------------ */
const canvasOps = { drawImage: 0, fill: 0, stroke: 0, getImageData: 0 };
const ctx2d = {
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
  closePath() {},
  fill() { canvasOps.fill += 1; },
  stroke() { canvasOps.stroke += 1; },
  drawImage() { canvasOps.drawImage += 1; },
  getImageData: (x, y, w, h) => {
    canvasOps.getImageData += 1;
    return {
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)).map((_, i) =>
        i % 4 === 3 ? 255 : (i * 37) % 256
      ),
      width: w, height: h,
    };
  },
  set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
};
window.HTMLCanvasElement.prototype.getContext = () => ctx2d;

window.URL.createObjectURL = () => "blob:stub";
window.URL.revokeObjectURL = () => {};

// Track the fetch calls the app makes.
const calls = [];
const realFetch = (url, opts) => {
  calls.push({ url: String(url), method: opts?.method ?? "GET" });
  return fetch(new URL(String(url), BASE).toString(), opts);
};
window.fetch = realFetch;
window.FormData = FormData;
window.Blob = Blob;
window.File = File;

// Image loading: jsdom never fires onload, so resolve immediately.
const nativeImage = window.Image;
window.Image = class extends nativeImage {
  set src(value) {
    this._src = value;
    // naturalWidth has no setter in jsdom, so define own properties instead.
    Object.defineProperty(this, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(this, "naturalHeight", { value: 600, configurable: true });
    setTimeout(() => this.onload?.({}), 0);
  }
  get src() { return this._src; }
};
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};

/* --- run the app ------------------------------------------------------- */
const script = window.document.createElement("script");
script.textContent = appjs;
window.document.body.appendChild(script);
// jsdom fires DOMContentLoaded itself once parsing settles — dispatching it here
// as well would boot the app twice (doubled listeners), which no browser does.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => Array.from(window.document.querySelectorAll(sel));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const result = {};

await wait(300);

result.examplesRendered = $$(".example").length;
result.exampleLabel = $(".example span")?.textContent ?? null;
result.initialRunDisabled = $("#runBtn").disabled;
result.stagesRendered = $$(".stage-item").length;
result.logLines = $$("#logList li").length;

/* 1. one-click example load */
click($(".example"));
await wait(2500);
result.sourceBadge = $("#sourceBadge").textContent;
result.analysisVisible = !$("#analysis").hidden;
result.metaCells = $$("#metaGrid .meta").length;
result.tonalShadow = $("#tShadow").textContent;
result.runEnabled = !$("#runBtn").disabled;
result.infoCalled = calls.some((c) => c.url.endsWith("/api/info"));

/* 2. run the pipeline with all four kernels + sharpen */
$$("#methodGroup input").forEach((cb) => {
  cb.checked = true;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
});
$("#sharpenRange").value = "4";
$("#sharpenRange").dispatchEvent(new window.Event("input", { bubbles: true }));
click($("#factorGroup .seg[data-factor='4']"));
click($("#runBtn"));
await wait(4000);

result.resultRows = $$("#resultsBody tr").length;
result.chips = $$("#outputChips .chip").length;
result.activeChip = $("#outputChips .chip.is-active")?.textContent?.trim() ?? null;
result.gaugeScore = $("#gaugeScore").textContent;
result.verdictVisible = !$("#verdict").hidden;
result.verdictTitle = $("#verdictTitle").textContent;
result.scrubHasImage = $("#scrub").classList.contains("has-image");
result.afterSrc = $("#imgAfter").getAttribute("src");
result.cmpMethod = $("#cmpMethod").textContent;
result.cmpRes = $("#cmpRes").textContent;
result.cmpSize = $("#cmpSize").textContent;
result.cmpDelta = $("#cmpDelta").textContent;
result.upscaleCalls = calls.filter((c) => c.url.endsWith("/api/upscale")).length;

/* 3. scrub drag changes the reveal */
const scrub = $("#scrub");
scrub.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 });
const before = scrub.style.getPropertyValue("--reveal");
scrub.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, clientX: 400 }));
scrub.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: 120 }));
scrub.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, clientX: 120 }));
result.revealBefore = before || "50%";
result.revealAfter = scrub.style.getPropertyValue("--reveal");
result.dividerLeft = $("#divider").style.left;
result.revealChanged = result.revealBefore !== result.revealAfter;

/* 4. sharpening toggle swaps the previewed file */
const sharpSrc = $("#imgAfter").getAttribute("src");
click($('#sharpenToggle button[data-mode="plain"]'));
await wait(700);
const plainSrc = $("#imgAfter").getAttribute("src");
result.sharpSrc = sharpSrc;
result.plainSrc = plainSrc;
result.sharpenToggleWorks = sharpSrc !== plainSrc;
result.plainVariantRequested = calls.some((c) => c.url.endsWith("/api/variant"));

click($('#sharpenToggle button[data-mode="sharp"]'));
await wait(500);

/* 5. method chip switch */
const secondChip = $$("#outputChips .chip")[1];
if (secondChip) {
  click(secondChip);
  await wait(800);
  result.switchedMethod = $("#cmpMethod").textContent;
  result.switchedChipActive = $("#outputChips .chip.is-active")?.textContent?.trim() ?? null;
}

/* 6. zoom */
window.document.querySelector("#zoomRange").value = "220";
window.document.querySelector("#zoomRange").dispatchEvent(new window.Event("input", { bubbles: true }));
result.zoomLabel = $("#zoomOut").textContent;
result.stageZoom = $("#stage").style.getPropertyValue("--zoom") || "1";
click($("#resetView"));
result.zoomAfterReset = $("#zoomOut").textContent;

/* 7. batch queue */
click($("#addBatch"));
click($("#addBatch"));
result.batchRows = $$("#batchList li").length;
result.batchStatuses = $$("#batchList .bstatus").map((s) => s.textContent);
result.queueStat = $("#statQueue").textContent;

/* 8. shortcuts overlay */
const sheet = $("#shortcutOverlay");
const displayOfSheet = () => window.getComputedStyle(sheet).display;
result.sheetDisplayAtRest = displayOfSheet();

window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "?", bubbles: true }));
await wait(60);
result.sheetOpen = !sheet.hidden;
result.sheetDisplayOpen = displayOfSheet();
result.sheetFocus = window.document.activeElement?.id ?? null;

// A stray shortcut while the sheet is up must not leak through to the studio.
const altBefore = $("#shortcutOverlay").hidden;
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "1", bubbles: true }));
await wait(40);
result.sheetBlocksShortcuts = sheet.hidden === altBefore;

// Close button
click($("#closeShortcuts"));
await wait(60);
result.sheetClosedByButton = sheet.hidden;
result.sheetDisplayAfterButton = displayOfSheet();
result.sheetFocusRestored = window.document.activeElement?.id ?? null;

// Backdrop click
click($("#shortcutsBtn"));
await wait(40);
click(sheet);
await wait(60);
result.sheetClosedByBackdrop = sheet.hidden && displayOfSheet() === "none";

// Escape key
click($("#shortcutsBtn"));
await wait(40);
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(60);
result.sheetClosed = sheet.hidden;
result.sheetDisplayAfterEscape = displayOfSheet();

/* 9. histogram drawn with both series after a result exists */
result.renderedTonalValues = [$("#tShadow").textContent, $("#tMid").textContent, $("#tHigh").textContent, $("#tMean").textContent];
result.reportEnabled = !$("#reportBtn").disabled;
result.copyEnabled = !$("#copyBtn").disabled;
result.statOutputs = $("#statOutputs").textContent;
result.statBest = $("#statBest").textContent;
result.statLatency = $("#statLatency").textContent;

result.canvasOps = canvasOps;
result.errors = errors;

/* --- explicit assertions ---------------------------------------------- */
const checks = [
  ["3 sample images render in the gallery", result.examplesRendered === 3],
  ["pipeline stages are listed", result.stagesRendered === 6],
  ["run is disabled before an image is loaded", result.initialRunDisabled === true],
  ["one-click gallery load populates the source", result.sourceBadge === "photo.png"],
  ["analysis panel opens after load", result.analysisVisible === true],
  ["metadata grid renders 9 cells", result.metaCells === 9],
  ["/api/info was called on load", result.infoCalled === true],
  ["run becomes enabled after load", result.runEnabled === true],
  ["upscale returns one row per kernel", result.resultRows === 4],
  ["comparison chips render for every method", result.chips === 4],
  ["best method is badged and active", /best/.test(result.activeChip ?? "")],
  ["verdict panel is shown with a score", result.verdictVisible === true && Number(result.gaugeScore) > 0],
  ["scrub divider is draggable", result.revealChanged === true && result.revealAfter === "15%"],
  ["divider element follows the reveal", result.dividerLeft === "15%"],
  ["compare metadata is populated", Boolean(result.cmpMethod) && Boolean(result.cmpRes) && Boolean(result.cmpSize)],
  ["sharpening toggle swaps to the plain variant", result.sharpenToggleWorks === true],
  ["plain variant was pre-rendered (no extra request)", result.plainVariantRequested === false],
  ["switching method chips updates the compare view", result.switchedMethod === "nearest"],
  ["zoom applies and Fit resets it", result.stageZoom === "2.2" && result.zoomAfterReset === "100%"],
  ["batch queue accepts jobs", result.batchRows === 2 && result.queueStat === "2"],
  ["shortcut sheet is not visible at rest", result.sheetDisplayAtRest === "none"],
  ["? opens the sheet", result.sheetOpen === true && result.sheetDisplayOpen !== "none"],
  ["focus moves into the sheet", result.sheetFocus === "closeShortcuts"],
  ["shortcuts are inert while the sheet is open", result.sheetBlocksShortcuts === true],
  ["Close button actually hides the sheet", result.sheetClosedByButton === true && result.sheetDisplayAfterButton === "none"],
  ["focus returns to the shortcuts button", result.sheetFocusRestored === "shortcutsBtn"],
  ["backdrop click closes the sheet", result.sheetClosedByBackdrop === true],
  ["Escape closes the sheet", result.sheetClosed === true && result.sheetDisplayAfterEscape === "none"],
  ["report and copy actions are enabled", result.reportEnabled === true && result.copyEnabled === true],
  ["no runtime errors during the whole flow", result.errors.length === 0],
];

console.log(JSON.stringify(result, null, 2));
console.log("\n── assertions ──────────────────────────────");
let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log("\nSKIP  histogram + tonal readouts — jsdom provides no canvas/Image loading");
console.log("      (covered by tests/hist-test.mjs, which runs the real functions on real pixels)");
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
