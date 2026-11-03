/**
 * The studio hides panels with the `hidden` attribute, but several of those
 * elements also carry an explicit `display` in style.css — and an author
 * `display` outranks the browser's own `[hidden] { display: none }`. When that
 * happens the element can never be hidden again (the shortcuts sheet was stuck
 * open exactly this way).
 *
 * This test loads the real stylesheet into jsdom and asserts that every element
 * app.js toggles via `.hidden` reports `display: none` while hidden.
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

// Ids that app.js assigns `.hidden` on — all must honour the attribute.
const TOGGLED = ["shortcutOverlay", "analysis", "progress", "scrubEmpty", "verdict"];

const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/style.css", "utf8");
const appjs = readFileSync("public/app.js", "utf8");

// Any element app.js sets `.hidden` on must live here, so the list cannot rot.
// Covers both `$("#id").hidden = …` and `const alias = $("#id")` + `alias.hidden`.
const direct = [...appjs.matchAll(/\$\("#([A-Za-z0-9_]+)"\)\.hidden/g)].map((m) => m[1]);
const aliased = [...appjs.matchAll(/const (\w+) = \$\("#([A-Za-z0-9_]+)"\)/g)]
  .filter(([, name]) => new RegExp(`\\b${name}\\.hidden`).test(appjs))
  .map(([, , id]) => id);
const toggledIds = [...new Set([...direct, ...aliased])].sort();

const dom = new JSDOM(html, { pretendToBeVisual: true });
const { window } = dom;

const style = window.document.createElement("style");
style.textContent = css;
window.document.head.appendChild(style);

const fails = [];
const check = (label, ok) => {
  if (!ok) fails.push(label);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

console.log("── hidden-attribute cascade ────────────────");
console.log(`elements toggled by app.js: ${toggledIds.join(", ")}`);

check(
  "the id list in this test covers every toggled element",
  toggledIds.every((id) => TOGGLED.includes(id))
);

for (const id of toggledIds) {
  const el = window.document.getElementById(id);
  if (!el) {
    check(`#${id} exists in index.html`, false);
    continue;
  }

  el.hidden = true;
  const whenHidden = window.getComputedStyle(el).display;

  el.hidden = false;
  const whenShown = window.getComputedStyle(el).display;

  el.hidden = true;
  const reHidden = window.getComputedStyle(el).display;

  check(`#${id} collapses to display:none when hidden`, whenHidden === "none");
  check(`#${id} is displayed when the attribute is lifted`, whenShown !== "none");
  check(`#${id} can be hidden again after being shown`, reHidden === "none");
}

console.log(`\n${fails.length ? fails.length + " FAILED" : "all checks passed"}`);
process.exit(fails.length ? 1 : 0);
