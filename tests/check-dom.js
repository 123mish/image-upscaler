import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const js = readFileSync("public/app.js", "utf8");

const htmlIds = new Set();
const idRegex = /\bid="([^"]+)"/g;
let m;
while ((m = idRegex.exec(html))) htmlIds.add(m[1]);

const dupes = [];
const seen = new Set();
idRegex.lastIndex = 0;
while ((m = idRegex.exec(html))) {
  if (seen.has(m[1])) dupes.push(m[1]);
  seen.add(m[1]);
}

const used = new Set();
const useRegex = /\$\("#([A-Za-z0-9_-]+)"\)|\$\$\("#([A-Za-z0-9_-]+)/g;
while ((m = useRegex.exec(js))) used.add(m[1] ?? m[2]);

const missing = [...used].filter((id) => !htmlIds.has(id));

console.log("html ids:", htmlIds.size);
console.log("ids referenced by app.js:", used.size);
console.log("duplicate ids:", dupes.length ? dupes.join(", ") : "none");
console.log("missing in html:", missing.length ? missing.join(", ") : "none");

// selectors used with $$ but scoped by class
const classSel = /\$\$\("([^"]+)"\)/g;
const classRefs = new Set();
while ((m = classSel.exec(js))) classRefs.add(m[1]);
console.log("\nall querySelectorAll targets:");
for (const s of classRefs) console.log(" ", s);

process.exit(missing.length ? 1 : 0);
