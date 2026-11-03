import { readFileSync } from "node:fs";
import http from "node:http";

const file = process.argv[2] ?? "uploads/photo.png";
const target = process.argv[3] ?? "/api/info";
const extra = process.argv.slice(4);

const boundary = "----probe" + Date.now();
const chunks = [];
const line = (s) => chunks.push(Buffer.from(s + "\r\n"));

line(`--${boundary}`);
line(`Content-Disposition: form-data; name="file"; filename="${file.split("/").pop()}"`);
line("Content-Type: image/png");
line("");
chunks.push(readFileSync(file));
line(`--${boundary}`);
for (const pair of extra) {
  const [k, v] = pair.split("=");
  line(`Content-Disposition: form-data; name="${k}"`);
  line("");
  line(v ?? "");
  line(`--${boundary}`);
}
line(`--${boundary}--`);
line("");

const body = Buffer.concat(chunks);
const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 3000,
    path: target,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": body.length,
    },
  },
  (res) => {
    const out = [];
    res.on("data", (c) => out.push(c));
    res.on("end", () => {
      const text = Buffer.concat(out).toString("utf8");
      console.log("status", res.statusCode);
      try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        console.log(text.slice(0, 800));
      }
    });
  },
);
req.on("error", (e) => console.error("request error:", e.message));
req.end(body);
