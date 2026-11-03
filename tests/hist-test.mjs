import { readFileSync } from "node:fs";
import sharp from "sharp";

const src = readFileSync("public/app.js", "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const histSrc = extract("histogramFromImage");
const tonalSrc = extract("tonalStats");

// Decode a real image into the same RGBA layout a canvas would expose.
const file = process.argv[2] ?? "uploads/photo.png";
const { data, info } = await sharp(file)
  .resize({ width: 180, height: 135, fit: "inside" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const fakeCtx = {
  drawImage() {},
  getImageData: () => ({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }),
};
const fakeCanvas = { width: 0, height: 0, getContext: () => fakeCtx };
const fakeDocument = { createElement: (tag) => (tag === "canvas" ? fakeCanvas : {}) };
const fakeImage = { naturalWidth: info.width, naturalHeight: info.height };

const factory = new Function(
  "document",
  `"use strict"; ${histSrc}; return { histogramFromImage, binsProbe: null };`
);
const { histogramFromImage } = factory(fakeDocument);

const hist = histogramFromImage(fakeImage, 64);
const tonalFactory = new Function(`"use strict"; ${tonalSrc}; return tonalStats;`);
const tonalStats = tonalFactory();
const t = tonalStats(hist);

const pct = (v) => Number(String(v).replace("%", ""));
const sum = pct(t.shadow) + pct(t.mid) + pct(t.high);

console.log(
  JSON.stringify(
    {
      file,
      pixels: `${info.width}x${info.height}`,
      bins: hist.length,
      histogramNonZero: hist.filter((v) => v > 0).length,
      tonal: t,
      tonalSum: sum,
      meanInRange: pct(t.mean) >= 0 && pct(t.mean) <= 255,
    },
    null,
    2
  )
);

const ok = hist.length === 64 && sum >= 99 && sum <= 101 && pct(t.mean) > 0 && pct(t.mean) < 255;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
