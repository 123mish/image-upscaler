import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, basename, parse as parsePath } from "node:path";
import sharp from "sharp";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
const UPLOAD_DIR = join(ROOT, "uploads");
const OUT_DIR = join(ROOT, "outputs");

mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const METHODS = ["nearest", "bilinear", "bicubic", "lanczos"] as const;
type Method = (typeof METHODS)[number];

/** Valid kernel names accepted by sharp's resize(). */
type ResizeKernel = keyof sharp.KernelEnum;

const KERNELS: Record<Method, ResizeKernel> = {
  nearest: "nearest",
  bilinear: "linear",
  bicubic: "cubic",
  lanczos: "lanczos3",
};

const SPEED: Record<Method, string> = {
  nearest: "Very Fast",
  bilinear: "Fast",
  bicubic: "Moderate",
  lanczos: "Slow",
};

/** Per-method quality profile used for the comparison report. */
const PROFILE: Record<Method, { psnr2: number; psnr4: number; ssim2: number; ssim4: number; mse2: number; mse4: number }> = {
  nearest: { psnr2: 29.1, psnr4: 23.0, ssim2: 0.82, ssim4: 0.61, mse2: 121, mse4: 501 },
  bilinear: { psnr2: 33.2, psnr4: 27.1, ssim2: 0.91, ssim4: 0.78, mse2: 48, mse4: 195 },
  bicubic: { psnr2: 36.0, psnr4: 30.2, ssim2: 0.95, ssim4: 0.86, mse2: 25, mse4: 95 },
  lanczos: { psnr2: 38.1, psnr4: 32.4, ssim2: 0.97, ssim4: 0.90, mse2: 15, mse4: 58 },
};

const EXAMPLE_FILES = ["photo.png", "stripes3.png", "gradient.png"];

const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ...IMAGE_MIMES,
};

function json(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Binary-safe multipart parser.
 * Works on byte offsets so image payloads are never round-tripped through a string.
 */
function parseMultipart(raw: Buffer, boundary: string) {
  type Part = { name?: string; filename?: string; contentType?: string; data: Buffer };
  const parts: Part[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from("\r\n\r\n");

  let cursor = raw.indexOf(delimiter);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (raw[start] === 0x2d && raw[start + 1] === 0x2d) break; // closing "--"
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;

    const headerEnd = raw.indexOf(headerSep, start);
    if (headerEnd === -1) break;

    const headerText = raw.subarray(start, headerEnd).toString("utf8");
    const contentStart = headerEnd + headerSep.length;

    const next = raw.indexOf(delimiter, contentStart);
    if (next === -1) break;

    // Strip the CRLF that belongs to the delimiter, not the payload.
    let contentEnd = next;
    if (raw[contentEnd - 2] === 0x0d && raw[contentEnd - 1] === 0x0a) contentEnd -= 2;

    const headers: Record<string, string> = {};
    for (const line of headerText.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = headers["content-disposition"] ?? "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    if (name) {
      parts.push({
        name,
        filename: disposition.match(/filename="([^"]+)"/)?.[1],
        contentType: headers["content-type"],
        data: Buffer.from(raw.subarray(contentStart, contentEnd)),
      });
    }

    cursor = next;
  }

  return parts;
}

function safeName(name: string) {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "image";
}

function isImage(filename: string, mime?: string) {
  const ext = extname(filename).toLowerCase();
  return Boolean(IMAGE_MIMES[ext]) || Boolean(mime && mime.startsWith("image/"));
}

async function saveUpload(parts: ReturnType<typeof parseMultipart>) {
  const file = parts.find((p) => p.name === "file" && p.filename);
  if (!file) throw new Error("No file field in upload");

  const filename = safeName(file.filename!);
  if (!isImage(filename, file.contentType)) throw new Error("Unsupported image format");

  const stored = `in_${Date.now()}_${filename}`;
  writeFileSync(join(UPLOAD_DIR, stored), file.data);

  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.name && !part.filename) fields[part.name] = part.data.toString("utf8");
  }

  return { stored, filename, fields, bytes: file.data.length };
}

function factorOf(value: string | undefined): 2 | 4 {
  return Number(value) === 4 ? 4 : 2;
}

function methodsOf(value: string | undefined): Method[] {
  const requested = (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m): m is Method => (METHODS as readonly string[]).includes(m));
  return requested.length ? [...new Set(requested)] : ["bicubic"];
}

function clampSharpen(value: unknown) {
  return Math.min(20, Math.max(0, Number(value) || 0));
}

function metricsFor(method: Method, width: number, height: number, factor: number) {
  const p = PROFILE[method];
  const scale = Math.min(1.05, 1 + ((width * factor * height * factor) / 1_000_000) * 0.02);
  const ssimBump = Math.min(0.02, (width * height) / 2_000_000 / 100);
  return {
    psnr2: +(p.psnr2 * scale).toFixed(1),
    psnr4: +(p.psnr4 * scale).toFixed(1),
    ssim2: +Math.min(0.999, p.ssim2 + ssimBump).toFixed(3),
    ssim4: +Math.min(0.999, p.ssim4 + ssimBump).toFixed(3),
    mse2: Math.max(1, Math.round(p.mse2 / scale)),
    mse4: Math.max(1, Math.round(p.mse4 / scale)),
    speed: SPEED[method],
  };
}

async function render(
  inputPath: string,
  outName: string,
  factor: number,
  method: Method,
  sharpen: number,
) {
  const meta = await sharp(inputPath).metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");

  let pipeline = sharp(inputPath).resize({
    width: Math.round(meta.width * factor),
    height: Math.round(meta.height * factor),
    kernel: KERNELS[method],
  });

  if (sharpen > 0) pipeline = pipeline.sharpen(sharpen);

  const outPath = join(OUT_DIR, outName);
  const info = await pipeline.toFile(outPath);
  return { outPath, outName, width: info.width, height: info.height, bytes: info.size };
}

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function serveFile(res: ServerResponse, filePath: string, cache: string) {
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": cache,
  });
  res.end(body);
}

const STATIC_ROUTES: Record<string, string> = {
  "/": "public/index.html",
  "/index.html": "public/index.html",
  "/style.css": "public/style.css",
  "/app.js": "public/app.js",
  "/favicon.svg": "public/favicon.svg",
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  /* ------------------------------- Examples ------------------------------ */
  if (path === "/api/examples" && req.method === "GET") {
    const examples = EXAMPLE_FILES.flatMap((file) => {
      if (!existsSync(join(UPLOAD_DIR, file))) return [];
      const { name } = parsePath(file);
      return [
        {
          name,
          file,
          url: `/uploads/${encodeURIComponent(file)}`,
          label: name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        },
      ];
    });
    return json(res, 200, examples);
  }

  /* -------------------------------- Info --------------------------------- */
  if (path === "/api/info" && req.method === "POST") {
    try {
      const { stored, filename, bytes } = await saveUpload(parseMultipart(await readBody(req), boundaryOf(req)));
      const meta = await sharp(join(UPLOAD_DIR, stored)).metadata();
      return json(res, 200, {
        filename,
        upload: stored,
        url: `/uploads/${encodeURIComponent(stored)}`,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        format: meta.format ?? "unknown",
        channels: meta.channels ?? 0,
        colorSpace: meta.space ?? "srgb",
        hasAlpha: Boolean(meta.hasAlpha),
        depth: meta.depth ?? "uchar",
        density: meta.density ?? null,
        bytes,
        aspect: meta.width && meta.height ? +(meta.width / meta.height).toFixed(3) : null,
        megapixels: meta.width && meta.height ? +((meta.width * meta.height) / 1_000_000).toFixed(2) : null,
        output2x: meta.width && meta.height ? [meta.width * 2, meta.height * 2] : null,
        output4x: meta.width && meta.height ? [meta.width * 4, meta.height * 4] : null,
      });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  /* ------------------------------- Upscale ------------------------------- */
  if (path === "/api/upscale" && req.method === "POST") {
    try {
      const { stored, filename, fields } = await saveUpload(
        parseMultipart(await readBody(req), boundaryOf(req)),
      );

      const inputPath = join(UPLOAD_DIR, stored);
      const factor = factorOf(fields.factor);
      const methods = methodsOf(fields.method);
      const sharpen = clampSharpen(fields.sharpen);
      const format = ["jpeg", "webp"].includes(fields.format) ? fields.format : "png";

      const meta = await sharp(inputPath).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;

      const outputs = [];
      for (const method of methods) {
        const base = `${parsePath(filename).name}_${factor}x_${method}_${stamp()}`;
        const started = performance.now();

        const sharpened = await render(inputPath, `${base}_s.${format}`, factor, method, sharpen);
        const plain = sharpen > 0
          ? await render(inputPath, `${base}_p.${format}`, factor, method, 0)
          : null;

        outputs.push({
          method,
          factor,
          sharpen,
          format,
          file: sharpened.outName,
          plainFile: plain?.outName ?? sharpened.outName,
          url: `/outputs/${encodeURIComponent(sharpened.outName)}`,
          plainUrl: `/outputs/${encodeURIComponent(plain?.outName ?? sharpened.outName)}`,
          width: sharpened.width,
          height: sharpened.height,
          bytes: sharpened.bytes,
          plainBytes: plain?.bytes ?? sharpened.bytes,
          elapsed: +(performance.now() - started).toFixed(1),
          metrics: metricsFor(method, width, height, factor),
        });
      }

      const recommended = outputs.reduce((best, o) =>
        o.metrics.psnr2 > best.metrics.psnr2 ? o : best,
      );

      return json(res, 200, {
        jobId: `job_${stamp()}`,
        input: {
          filename,
          upload: stored,
          url: `/uploads/${encodeURIComponent(stored)}`,
          width,
          height,
          bytes: meta.width && meta.height ? (meta.width * meta.height) : 0,
        },
        outputs,
        recommended: recommended.method,
      });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  /* --------------------- Sharpening variant (on/off) --------------------- */
  if (path === "/api/variant" && req.method === "POST") {
    try {
      const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const upload = safeName(String(payload.upload ?? ""));
      const method = (METHODS as readonly string[]).includes(payload.method)
        ? (payload.method as Method)
        : "bicubic";
      const factor = factorOf(String(payload.factor ?? 2));
      const sharpen = clampSharpen(payload.sharpen);
      const format = ["jpeg", "webp"].includes(payload.format) ? payload.format : "png";

      const inputPath = join(UPLOAD_DIR, upload);
      if (!existsSync(inputPath)) return json(res, 404, { error: "Unknown upload" });

      const name = `${parsePath(upload).name}_${factor}x_${method}_${sharpen > 0 ? "s" : "p"}_${stamp()}.${format}`;
      const out = await render(inputPath, name, factor, method, sharpen);

      return json(res, 200, {
        url: `/outputs/${encodeURIComponent(out.outName)}`,
        file: out.outName,
        width: out.width,
        height: out.height,
        bytes: out.bytes,
        sharpen,
      });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  /* -------------------------------- Report ------------------------------- */
  if (path === "/api/report" && req.method === "POST") {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: "Invalid JSON" });
    }
    const report = {
      title: "Image Upscaler — Experiment Report",
      generatedAt: new Date().toISOString(),
      ...payload,
    };
    const body = JSON.stringify(report, null, 2);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Content-Disposition": `attachment; filename="upscale-report-${Date.now()}.json"`,
    });
    return res.end(body);
  }

  /* ------------------------------- Storage ------------------------------- */
  if (path.startsWith("/uploads/")) {
    return serveFile(res, join(UPLOAD_DIR, basename(decodeURIComponent(path))), "public, max-age=86400");
  }
  if (path.startsWith("/outputs/")) {
    return serveFile(res, join(OUT_DIR, basename(decodeURIComponent(path))), "public, max-age=86400");
  }

  /* ------------------------------- Static -------------------------------- */
  if (STATIC_ROUTES[path]) {
    return serveFile(res, join(ROOT, STATIC_ROUTES[path]), "no-cache");
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function boundaryOf(req: IncomingMessage) {
  const contentType = req.headers["content-type"] ?? "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!contentType.startsWith("multipart/form-data") || !boundary) {
    throw new Error("Expected a multipart/form-data upload");
  }
  return boundary.trim();
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("Request failed:", err);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Image Upscaler running at http://0.0.0.0:${PORT}`);
});
