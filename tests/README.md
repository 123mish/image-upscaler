# Verification scripts

Run everything that works without a browser:

```bash
npm test
```

| Script | What it proves |
| --- | --- |
| `check-dom.js` | Every `#id` referenced by `public/app.js` exists in `public/index.html`, and no HTML id is duplicated. Catches boot-time crashes without a browser. |
| `css-hidden-test.mjs` | Every element `app.js` toggles with `.hidden` (found by scanning the source, so the list can't rot) is loaded with the real `style.css` and asserted to compute to `display: none` while hidden **and** to be displayed when the attribute is lifted. Guards the class of bug where an author `display` rule outranks the browser's own `[hidden]` rule. |
| `hist-test.mjs` | Imports the **real** `histogramFromImage` and `tonalStats` functions out of `app.js` and runs them over genuine RGBA pixels decoded by sharp. Asserts 64 bins, tonal percentages summing to 100, and a sane mean. |
| `dom-test.mjs` | Loads the real `index.html` (with `style.css` inlined, so computed styles exercise the real cascade) and executes the real `app.js` in jsdom, then drives the whole flow: gallery load → analysis → 4-kernel upscale → scrub drag → sharpen toggle → method chips → zoom → batch queue → shortcuts sheet. 30 assertions, exits non-zero on any failure. The sheet checks assert **computed `display`**, not just the `hidden` flag, so a CSS rule that outranks `[hidden]` is caught. |
| `probe.js` | Sends a real multipart upload to a running server. Useful for checking endpoints by hand: `node tests/probe.js uploads/photo.png /api/upscale factor=2 method=lanczos sharpen=4`. |
| `browser-test.mjs` | Playwright pass that takes screenshots and repeats the UI flow in a real browser. Not part of `npm test`. |

## Note on `DOMContentLoaded`

`dom-test.mjs` appends `app.js` and then lets jsdom fire `DOMContentLoaded` on its own. Do not
dispatch it manually as well — that boots the app twice, doubling every listener and making
toggle-style shortcuts (`?`, `Esc`, `S`) appear to do nothing in the test.

## Known limitation of `dom-test.mjs`

jsdom ships no canvas and never fires `Image.onload`, so the histogram canvas and the
shadow/midtone/highlight readouts cannot be asserted there — they report `—` and are skipped
explicitly. That logic is covered by `hist-test.mjs` against real pixel data instead.

## Running the browser test

`browser-test.mjs` needs Playwright plus a browser binary, and on a minimal Linux container it
also needs Chromium's system libraries (`libnss3`, `libatk*`, `libpango`, `libcairo`, `libasound2`):

```bash
npm i -D playwright
npx playwright install chromium
npx playwright install-deps chromium   # needs root
npm run test:browser
```

It writes `artifacts/studio-full.png`, `artifacts/compare-studio.png`, `artifacts/source-panel.png`,
`artifacts/results-panel.png` and `artifacts/studio-shortcuts.png`.
