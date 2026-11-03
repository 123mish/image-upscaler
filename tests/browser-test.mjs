import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const errors = [];

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2 });

page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });

const report = {};

// 1. Boot state
report.title = await page.title();
report.examples = await page.locator(".example").count();
report.histogramCanvas = await page.locator("#histogram").isVisible();
report.runDisabled = await page.locator("#runBtn").isDisabled();

// 2. Load a sample from the gallery (one-click load)
await page.locator(".example").first().click();
await page.waitForSelector("#analysis:not([hidden])", { timeout: 8000 });
await page.waitForTimeout(1200);
report.sourceBadge = await page.locator("#sourceBadge").textContent();
report.metaCells = await page.locator("#metaGrid .meta").count();
report.checkboxState = await page.locator('#methodGroup input[value="bicubic"]').isChecked();

// 3. Enable all four kernels + sharpen, then run
for (const m of ["nearest", "bilinear", "lanczos"]) {
  await page.locator(`#methodGroup input[value="${m}"]`).check();
}
await page.locator("#sharpenRange").fill("4");
await page.locator("#factorGroup .seg[data-factor='4']").click();
await page.locator("#runBtn").click();

await page.waitForSelector("#verdict:not([hidden])", { timeout: 40000 });
await page.waitForTimeout(900);

report.resultRows = await page.locator("#resultsBody tr").count();
report.chips = await page.locator("#outputChips .chip").count();
report.activeChip = await page.locator("#outputChips .chip.is-active").textContent();
report.gaugeScore = await page.locator("#gaugeScore").textContent();
report.verdictTitle = await page.locator("#verdictTitle").textContent();
report.scrubHasImage = await page.locator("#scrub.has-image").count();
report.cmpMethod = await page.locator("#cmpMethod").textContent();
report.cmpRes = await page.locator("#cmpRes").textContent();
report.cmpSize = await page.locator("#cmpSize").textContent();
report.cmpDelta = await page.locator("#cmpDelta").textContent();
report.afterSrcSet = await page.locator("#imgAfter").getAttribute("src");
report.logLines = await page.locator("#logList li").count();

await page.screenshot({ path: "artifacts/studio-full.png", fullPage: true });

// 4. Scrub slider: drag the divider and confirm the clip position changes
const before = await page.locator("#afterClip").evaluate((el) => getComputedStyle(el).clipPath);
const box = await page.locator("#scrub").boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.22, box.y + box.height * 0.5, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const after = await page.locator("#afterClip").evaluate((el) => getComputedStyle(el).clipPath);
report.scrubClipBefore = before;
report.scrubClipAfter = after;
report.scrubChanged = before !== after;

// 5. Sharpening toggle must swap to a different variant file
const sharpSrc = await page.locator("#imgAfter").getAttribute("src");
await page.locator("#sharpenToggle button[data-mode='plain']").click();
await page.waitForTimeout(500);
const plainSrc = await page.locator("#imgAfter").getAttribute("src");
report.sharpenSrcSharp = sharpSrc;
report.sharpenSrcPlain = plainSrc;
report.sharpenVariantDiffers = sharpSrc !== plainSrc;
report.plainToggleActive = await page.locator("#sharpenToggle button[data-mode='plain']").evaluate((b) => b.classList.contains("is-active"));

await page.locator("#sharpenToggle button[data-mode='sharp']").click();
await page.waitForTimeout(300);

// 6. Zoom
await page.locator("#zoomRange").fill("200");
await page.waitForTimeout(300);
report.zoomOut = await page.locator("#zoomOut").textContent();
report.stageZoom = await page.locator("#stage").evaluate((el) => el.style.getPropertyValue("--zoom"));
await page.locator("#resetView").click();
await page.waitForTimeout(200);
report.zoomReset = await page.locator("#zoomOut").textContent();

// 7. Switch to a different method chip
const chips = page.locator("#outputChips .chip");
await chips.nth(1).click();
await page.waitForTimeout(500);
report.switchedChip = await page.locator("#outputChips .chip.is-active").textContent();
report.switchedMethod = await page.locator("#cmpMethod").textContent();

// 8. Batch queue
await page.locator("#addBatch").click();
await page.locator("#addBatch").click();
report.batchRows = await page.locator("#batchList li").count();
report.queueStat = await page.locator("#statQueue").textContent();

// 9. Shortcuts overlay
await page.keyboard.press("?");
await page.waitForTimeout(300);
report.shortcutSheetVisible = await page.locator("#shortcutOverlay").isVisible();
await page.screenshot({ path: "artifacts/studio-shortcuts.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
report.shortcutSheetClosed = await page.locator("#shortcutOverlay").isHidden();

// 10. Report export
report.reportBtnEnabled = await page.locator("#reportBtn").isEnabled();

// Focused screenshots
await page.locator(".col-compare").screenshot({ path: "artifacts/compare-studio.png" });
await page.locator(".col-source").screenshot({ path: "artifacts/source-panel.png" });
await page.locator(".col-results").screenshot({ path: "artifacts/results-panel.png" });

report.consoleErrors = errors;

console.log(JSON.stringify(report, null, 2));
await browser.close();
