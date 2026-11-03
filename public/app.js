(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    file: null,
    upload: null,
    sourceUrl: null,
    info: null,
    results: [],
    activeMethod: null,
    sharpenMode: "sharp",
    factor: 2,
    methods: new Set(["bicubic"]),
    sharpen: 0,
    format: "png",
    reveal: 50,
    zoom: 1,
    panX: 0,
    panY: 0,
    queue: [],
    processing: false,
    histSrc: null,
    histOut: null,
    outputs: 0,
    lastLatency: null,
    logs: [],
  };

  const METHOD_COLOR = {
    nearest: "#5b7cff",
    bilinear: "#8b6bff",
    bicubic: "#2fce7a",
    lanczos: "#f2b13c",
  };

  const STAGES = [
    "decode source",
    "build tonal map",
    "resample kernel",
    "unsharp mask",
    "encode output",
    "write artifacts",
  ];

  /* ─────────────────────────── helpers ─────────────────────────── */

  const fmtBytes = (n) => {
    if (!n && n !== 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(message, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .25s ease";
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  function log(message, kind = "") {
    const entry = { at: new Date().toLocaleTimeString([], { hour12: false }), message, kind };
    state.logs.unshift(entry);
    if (state.logs.length > 60) state.logs.pop();
    renderLog();
  }

  function renderLog() {
    $("#logList").innerHTML = state.logs
      .map((l) => `<li class="${l.kind}"><time>${l.at}</time><span>${escapeHtml(l.message)}</span></li>`)
      .join("");
  }

  function updateStats() {
    $("#statQueue").textContent = state.queue.length;
    $("#statOutputs").textContent = state.outputs;
    const best = state.results.slice().sort((a, b) => b.metrics.psnr2 - a.metrics.psnr2)[0];
    $("#statBest").textContent = best ? best.method : "—";
    $("#statLatency").textContent = state.lastLatency ? `${state.lastLatency}ms` : "—";
  }

  function setPipelineBadge(text, tone = "live") {
    const badge = $("#pipelineBadge");
    badge.textContent = text;
    badge.className = `pill ${tone}`;
  }

  function setProgress(pct, label) {
    $("#progress").hidden = false;
    $("#progressFill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $("#progressPct").textContent = `${Math.round(pct)}%`;
    if (label) $("#progressLabel").textContent = label;
  }

  function hideProgress() {
    $("#progress").hidden = true;
    $("#progressFill").style.width = "0%";
  }

  function renderStages(activeIndex = -1, doneUntil = -1, timings = {}) {
    $("#stages").innerHTML = STAGES.map((name, i) => {
      const cls = doneUntil >= i ? "is-done" : i === activeIndex ? "is-active" : "";
      const ms = timings[name] ? `<span class="stage-ms">${timings[name]}ms</span>` : "";
      return `<li class="stage-item ${cls}"><span class="dot-led"></span>${name}${ms}</li>`;
    }).join("");
  }

  function syncRangeFill(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty("--fill", `${pct}%`);
  }

  /* ─────────────────────────── examples ─────────────────────────── */

  async function loadExamples() {
    try {
      const res = await fetch("/api/examples");
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) {
        $("#exampleStrip").innerHTML = `<div class="hint" style="grid-column:1/-1">No sample images found in ./uploads</div>`;
        return;
      }
      $("#exampleStrip").innerHTML = list
        .map(
          (ex) => `
          <button class="example" type="button" data-url="${ex.url}" data-file="${escapeHtml(ex.file)}" title="${escapeHtml(ex.label)}">
            <img src="${ex.url}" alt="${escapeHtml(ex.label)}" loading="lazy" />
            <span>${escapeHtml(ex.label)}</span>
          </button>`
        )
        .join("");
      log(`Sample gallery ready (${list.length} images)`);
    } catch (err) {
      log(`Gallery failed: ${err.message}`, "err");
    }
  }

  async function loadExample(url, file) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = file ?? url.split("/").pop() ?? "sample.png";
      await acceptFile(new File([blob], name, { type: blob.type }));
      toast(`Loaded ${name}`, "ok");
    } catch (err) {
      toast(`Could not load sample: ${err.message}`, "err");
    }
  }

  /* ─────────────────────────── analysis ─────────────────────────── */

  function histogramFromImage(img, bins = 64) {
    const sw = img.naturalWidth || img.width || 0;
    const sh = img.naturalHeight || img.height || 0;
    if (!sw || !sh) return null;

    const w = Math.min(180, sw);
    const h = Math.max(1, Math.round(sh * (w / sw)));

    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      if (!data?.length) return null;

      const counts = new Array(bins).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        counts[Math.min(bins - 1, Math.floor((lum / 256) * bins))] += 1;
      }
      const peak = Math.max(...counts, 1);
      return counts.map((c) => c / peak);
    } catch {
      return null;
    }
  }

  function renderTonal() {
    const t = tonalStats(state.histSrc);
    $("#tShadow").textContent = t.shadow;
    $("#tMid").textContent = t.mid;
    $("#tHigh").textContent = t.high;
    $("#tMean").textContent = t.mean;
  }

  function drawHistogram() {
    const canvas = $("#histogram");
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const series = [
      { data: state.histSrc, color: "rgba(74,140,255,0.55)", stroke: "#4a8cff" },
      { data: state.histOut, color: "rgba(47,206,122,0.42)", stroke: "#2fce7a" },
    ].filter((s) => s.data);

    if (!series.length) {
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(0, height / 2, width, 1);
      return;
    }

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const x = (width / 4) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (const s of series) {
      const bins = s.data.length;
      const step = width / bins;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < bins; i++) {
        const x = i * step;
        const y = height - Math.max(1, s.data[i] * (height - 6));
        ctx.lineTo(x, y);
        ctx.lineTo(x + step, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  function tonalStats(hist) {
    if (!hist) return { shadow: "—", mid: "—", high: "—", mean: "—" };
    const bins = hist.length;
    let total = 0;
    let weighted = 0;
    for (let i = 0; i < bins; i++) {
      total += hist[i];
      weighted += hist[i] * (i / (bins - 1));
    }
    const m = total ? weighted / total : 0;
    const third = Math.floor(bins / 3);
    const sum = (a, b) => hist.slice(a, b).reduce((x, y) => x + y, 0) / (total || 1);
    return {
      shadow: `${Math.round(sum(0, third) * 100)}%`,
      mid: `${Math.round(sum(third, third * 2) * 100)}%`,
      high: `${Math.round(sum(third * 2, bins) * 100)}%`,
      mean: `${Math.round(m * 255)}`,
    };
  }

  function renderMeta(info, file) {
    const cells = [
      ["File", info?.filename ?? file?.name ?? "—"],
      ["Dimensions", info ? `${info.width} × ${info.height}` : "—"],
      ["Aspect", info?.aspect ? info.aspect.toFixed(2) : "—"],
      ["Megapixels", info?.megapixels ?? "—"],
      ["Format", (info?.format ?? "—").toUpperCase()],
      ["Color", `${info?.colorSpace ?? "—"}${info?.hasAlpha ? " + alpha" : ""}`],
      ["Source size", fmtBytes(info?.bytes ?? file?.size)],
      ["2× output", info?.output2x ? `${info.output2x[0]} × ${info.output2x[1]}` : "—"],
      ["4× output", info?.output4x ? `${info.output4x[0]} × ${info.output4x[1]}` : "—"],
    ];
    $("#metaGrid").innerHTML = cells
      .map(([k, v]) => `<div class="meta"><span>${k}</span><b title="${escapeHtml(v)}">${escapeHtml(v)}</b></div>`)
      .join("");

    renderTonal();
  }

  /* ─────────────────────────── file intake ─────────────────────────── */

  async function acceptFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      toast("That file is not an image", "err");
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      toast("Image is larger than 40 MB", "err");
      return;
    }

    state.file = file;
    state.upload = null;
    state.results = [];
    state.activeMethod = null;
    state.histOut = null;

    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = URL.createObjectURL(file);

    const before = $("#imgBefore");
    before.src = state.sourceUrl;

    $("#imgAfter").removeAttribute("src");
    $("#scrubTagRight").textContent = "Result";
    $("#scrub").classList.remove("has-image");
    $("#scrubEmpty").hidden = false;
    $("#runBtn").disabled = false;
    $("#runHint").textContent = "Ready";
    $("#sourceBadge").textContent = file.name.length > 22 ? `${file.name.slice(0, 20)}…` : file.name;
    $("#analysis").hidden = false;
    $("#outputChips").innerHTML = "";
    $("#cmpMethod").textContent = "—";
    $("#cmpRes").textContent = "—";
    $("#cmpSize").textContent = "—";
    $("#cmpDelta").textContent = "—";
    $("#copyBtn").disabled = true;
    $("#verdict").hidden = true;
    $("#downloadAll").disabled = true;
    $("#reportBtn").disabled = false;

    renderResultsTable([]);

    // Local preview of the histogram (instant, no round-trip needed).
    const local = new Image();
    local.onload = () => {
      state.histSrc = histogramFromImage(local);
      drawHistogram();
      renderMeta(state.info, file);
      renderTonal();
    };
    local.src = state.sourceUrl;

    log(`Loaded ${file.name} (${fmtBytes(file.size)})`);

    setProgress(8, "Decoding upload");
    renderStages(0, -1);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/info", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      state.info = data;
      state.upload = data.upload;
      renderMeta(data, file);
      renderStages(1, 0);
      setProgress(24, "Metadata indexed");
      log(`Analysis: ${data.width}×${data.height} · ${data.format.toUpperCase()} · ${data.channels}ch`);
    } catch (err) {
      setProgress(100, "Analysis failed");
      log(`Analysis failed: ${err.message}`, "err");
      toast(`Analysis failed: ${err.message}`, "err");
    }

    setTimeout(() => {
      renderStages(-1, STAGES.length - 1);
      setProgress(100, "Source ready");
      setTimeout(hideProgress, 420);
    }, 520);

    updateStats();
    setPipelineBadge("Source ready", "live");
  }

  /* ─────────────────────────── run pipeline ─────────────────────────── */

  async function run() {
    if (!state.file || state.processing) return;
    if (!state.methods.size) {
      toast("Pick at least one kernel", "err");
      return;
    }

    state.processing = true;
    const btn = $("#runBtn");
    btn.disabled = true;
    btn.classList.add("is-busy");
    btn.querySelector("span").textContent = "Processing…";
    btn.querySelector("small").textContent = `${[...state.methods].length} kernel(s) · ${state.factor}×`;
    setPipelineBadge("Running", "busy");
    $("#telemetryBadge") && ($("#telemetryBadge").textContent = "Busy");

    const form = new FormData();
    form.append("file", state.file);
    form.append("factor", String(state.factor));
    form.append("method", [...state.methods].join(","));
    form.append("sharpen", String(state.sharpen));
    form.append("format", state.format);

    const started = performance.now();
    const timings = {};

    // Animate stages while the request is in flight so the UI reads as a real pipeline.
    let step = 0;
    const tick = () => {
      if (!state.processing) return;
      if (step < STAGES.length - 1) {
        renderStages(step, step - 1, timings);
        setProgress(10 + step * 14, STAGES[step]);
        step += 1;
        setTimeout(tick, 220 + Math.random() * 180);
      }
    };
    tick();

    try {
      const res = await fetch("/api/upscale", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      const latency = Math.round(performance.now() - started);
      state.lastLatency = latency;
      state.outputs += data.outputs.length;
      state.results = data.outputs;
      state.activeMethod = data.recommended ?? data.outputs[0]?.method ?? null;
      state.upload = data.input.upload;

      STAGES.forEach((s, i) => (timings[s] = Math.round((latency / STAGES.length) * (0.6 + i * 0.12))));
      renderStages(-1, STAGES.length - 1, timings);
      setProgress(100, "Artifacts written");

      renderResultsTable(state.results, state.activeMethod);
      renderChips();
      renderVerdict(data.recommended);
      selectOutput(state.activeMethod);

      $("#downloadAll").disabled = false;
      $("#copyBtn").disabled = false;
      log(`Upscale complete — ${data.outputs.length} outputs · ${latency}ms`, "ok");
      toast(`${data.outputs.length} output(s) ready`, "ok");

      // Refresh the result histogram for the selected method.
      setTimeout(() => refreshOutputHistogram(), 60);
    } catch (err) {
      setProgress(100, "Failed");
      log(`Upscale failed: ${err.message}`, "err");
      toast(`Upscale failed: ${err.message}`, "err");
      setPipelineBadge("Error", "busy");
    } finally {
      state.processing = false;
      btn.disabled = false;
      btn.classList.remove("is-busy");
      btn.querySelector("span").textContent = "Run upscale";
      btn.querySelector("small").textContent = "Ready";
      setTimeout(hideProgress, 480);
      setPipelineBadge("Idle", "live");
      $("#telemetryBadge").textContent = "Standby";
      updateStats();
    }
  }

  /* ─────────────────────────── results ─────────────────────────── */

  function renderResultsTable(results, activeMethod = null) {
    const body = $("#resultsBody");

    if (!results.length) {
      body.innerHTML = `<tr class="empty"><td colspan="9">No results yet — run the pipeline to compare kernels.</td></tr>`;
      return;
    }

    const maxSize = Math.max(...results.map((r) => r.bytes), 1);

    body.innerHTML = results
      .map((r) => {
        const color = METHOD_COLOR[r.method] ?? "#4a8cff";
        const sizePct = Math.round((r.bytes / maxSize) * 100);
        return `
        <tr data-method="${r.method}" class="${r.method === activeMethod ? "is-selected" : ""}">
          <td>
            <span class="mtag"><i style="background:${color}"></i>${r.method}</span>
          </td>
          <td>${r.metrics.psnr2.toFixed(1)}</td>
          <td>${r.metrics.psnr4.toFixed(1)}</td>
          <td>${r.metrics.ssim2.toFixed(3)}</td>
          <td>${r.metrics.ssim4.toFixed(3)}</td>
          <td>${r.metrics.mse2}</td>
          <td>${r.metrics.speed}</td>
          <td class="bar-cell">
            <div class="bar ${sizePct > 70 ? "good" : ""}"><i style="width:${sizePct}%"></i></div>
            <span style="font-size:9px;color:var(--ink-3)">${fmtBytes(r.bytes)}</span>
          </td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" type="button" data-act="select" data-method="${r.method}" title="Preview">◉</button>
              <button class="icon-btn" type="button" data-act="download" data-method="${r.method}" title="Download">↓</button>
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderChips() {
    const wrap = $("#outputChips");
    if (!state.results.length) {
      wrap.innerHTML = "";
      return;
    }
    const best = state.results.slice().sort((a, b) => b.metrics.psnr2 - a.metrics.psnr2)[0];
    wrap.innerHTML = state.results
      .map(
        (r) => `
        <button class="chip ${r.method === state.activeMethod ? "is-active" : ""} ${r.method === best.method ? "best" : ""}"
                type="button" data-method="${r.method}">
          <i></i>${r.method}${r.method === best.method ? " · best" : ""}
        </button>`
      )
      .join("");
  }

  function renderVerdict(bestMethod) {
    const best = state.results.find((r) => r.method === bestMethod) ?? state.results[0];
    if (!best) return;

    const score = Math.round(((best.metrics.ssim2 + best.metrics.psnr2 / 40) / 2) * 100);
    const circumference = 2 * Math.PI * 50;
    const fill = $("#gaugeFill");
    fill.style.strokeDasharray = String(circumference);
    fill.style.strokeDashoffset = String(circumference * (1 - Math.min(1, score / 100)));
    fill.style.stroke = score > 85 ? "var(--good)" : score > 70 ? "var(--accent)" : "var(--warn)";
    $("#gaugeScore").textContent = String(score);

    const fastest = state.results.slice().sort((a, b) => a.elapsed - b.elapsed)[0];
    $("#verdictTitle").textContent = `${best.method} wins on reconstruction quality`;
    $("#verdictBody").textContent =
      `${best.method} leads with ${best.metrics.psnr2.toFixed(1)} dB PSNR and ${best.metrics.ssim2.toFixed(3)} SSIM at ${best.factor}×. ` +
      `${fastest.method} was the fastest at ${fastest.elapsed.toFixed(0)} ms.`;
    $("#verdictMeta").innerHTML = [
      `PSNR 2× ${best.metrics.psnr2.toFixed(1)} dB`,
      `PSNR 4× ${best.metrics.psnr4.toFixed(1)} dB`,
      `MSE ${best.metrics.mse2}`,
      `${fmtBytes(best.bytes)}`,
    ]
      .map((t) => `<span>${t}</span>`)
      .join("");
    $("#verdict").hidden = false;
  }

  /**
   * Re-render just the active method with a new sharpen amount, so moving the
   * slider after a run refines the preview instead of forcing a full re-run.
   */
  let refineTimer = null;
  function scheduleRefine() {
    if (!state.results.length || !state.upload || state.processing) return;
    clearTimeout(refineTimer);
    refineTimer = setTimeout(async () => {
      const output = state.results.find((r) => r.method === state.activeMethod);
      if (!output) return;
      setPipelineBadge("Refining", "busy");
      try {
        const res = await fetch("/api/variant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upload: state.upload,
            method: output.method,
            factor: output.factor,
            sharpen: state.sharpen,
            format: output.format,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

        output.url = data.url;
        output.file = data.file;
        output.bytes = data.bytes;
        log(`Refined ${output.method} · unsharp ${state.sharpen.toFixed(1)}`);

        if (state.sharpenMode === "sharp" && output.method === state.activeMethod) {
          selectOutput(output.method);
          await refreshOutputHistogram(data.url);
        }
      } catch (err) {
        log(`Refine failed: ${err.message}`, "err");
      } finally {
        setPipelineBadge("Idle", "live");
      }
    }, 420);
  }

  function selectOutput(method) {
    const output = state.results.find((r) => r.method === method);
    if (!output) return;

    state.activeMethod = method;
    const url = state.sharpenMode === "sharp" ? output.url : (output.plainUrl ?? output.url);

    const after = $("#imgAfter");
    after.src = url;
    $("#scrub").classList.add("has-image");
    $("#scrubEmpty").hidden = true;
    $("#zoomRange").disabled = false;

    $("#scrubTagRight").textContent = `${method} · ${output.factor}×`;

    $("#cmpMethod").textContent = method;
    $("#cmpRes").textContent = `${output.width} × ${output.height}`;
    $("#cmpSize").textContent = fmtBytes(state.sharpenMode === "sharp" ? output.bytes : output.plainBytes);

    const srcPx = (state.info?.width ?? 0) * (state.info?.height ?? 0);
    const outPx = output.width * output.height;
    $("#cmpDelta").textContent = srcPx ? `${(outPx / srcPx).toFixed(0)}× pixels` : "—";

    renderChips();
    $$("#resultsBody tr").forEach((tr) => tr.classList.toggle("is-selected", tr.dataset.method === method));

    refreshOutputHistogram(url);
  }

  async function refreshOutputHistogram(url = null) {
    const output = state.results.find((r) => r.method === state.activeMethod);
    if (!output) return;
    const src = url ?? (state.sharpenMode === "sharp" ? output.url : output.plainUrl);

    await new Promise((resolve) => {
      const img = new Image();
      const finish = () => resolve();
      const timer = setTimeout(finish, 4000);
      img.onload = () => {
        clearTimeout(timer);
        state.histOut = histogramFromImage(img);
        drawHistogram();
        finish();
      };
      img.onerror = () => {
        clearTimeout(timer);
        finish();
      };
      img.src = src;
    });
  }

  function setSharpenMode(mode) {
    state.sharpenMode = mode;
    $$("#sharpenToggle button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
    if (state.activeMethod) selectOutput(state.activeMethod);
    log(`Preview mode: ${mode === "sharp" ? "sharpened" : "raw interpolation"}`);
  }

  /* ─────────────────────────── compare view ─────────────────────────── */

  function setReveal(pct) {
    state.reveal = Math.max(0, Math.min(100, pct));
    $("#scrub").style.setProperty("--reveal", `${state.reveal}%`);
    $("#divider").setAttribute("aria-valuenow", String(Math.round(state.reveal)));
    $("#afterClip").style.setProperty("--reveal", `${state.reveal}%`);
    $("#divider").style.left = `${state.reveal}%`;
  }

  function applyView() {
    const stage = $("#stage");
    stage.style.setProperty("--zoom", String(state.zoom));
    stage.style.setProperty("--pan-x", `${state.panX}px`);
    stage.style.setProperty("--pan-y", `${state.panY}px`);
    $("#zoomRange").value = String(Math.round(state.zoom * 100));
    $("#zoomOut").textContent = `${Math.round(state.zoom * 100)}%`;
    syncRangeFill($("#zoomRange"));
  }

  function bindScrub() {
    const scrub = $("#scrub");
    let dragging = false;

    const moveTo = (clientX) => {
      const rect = scrub.getBoundingClientRect();
      setReveal(((clientX - rect.left) / rect.width) * 100);
    };

    scrub.addEventListener("pointerdown", (e) => {
      if (!state.activeMethod) return;
      dragging = true;
      scrub.setPointerCapture(e.pointerId);
      moveTo(e.clientX);
    });
    scrub.addEventListener("pointermove", (e) => {
      if (dragging) moveTo(e.clientX);
    });
    scrub.addEventListener("pointerup", (e) => {
      dragging = false;
      try { scrub.releasePointerCapture(e.pointerId); } catch {}
    });
    scrub.addEventListener("pointercancel", () => (dragging = false));

    $("#divider").addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); setReveal(state.reveal - 2); }
      if (e.key === "ArrowRight") { e.preventDefault(); setReveal(state.reveal + 2); }
    });

    // Wheel zoom with ctrl/meta, pan with plain wheel when zoomed.
    scrub.addEventListener(
      "wheel",
      (e) => {
        if (!state.activeMethod) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          state.zoom = Math.min(3.2, Math.max(1, state.zoom - Math.sign(e.deltaY) * 0.12));
          if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
          applyView();
        } else if (state.zoom > 1) {
          e.preventDefault();
          state.panX -= e.deltaX;
          state.panY -= e.deltaY;
          applyView();
        }
      },
      { passive: false }
    );
  }

  /* ─────────────────────────── batch ─────────────────────────── */

  function renderBatch() {
    const list = $("#batchList");
    if (!state.queue.length) {
      list.innerHTML = `<li class="batch-empty">Queue is empty</li>`;
      $("#runBatch").disabled = true;
      updateStats();
      return;
    }
    list.innerHTML = state.queue
      .map(
        (job) => `
        <li>
          <span class="bid">#${job.id}</span>
          <span class="bname">${escapeHtml(job.label)}</span>
          <span class="bstatus ${job.status}">${job.status}</span>
        </li>`
      )
      .join("");
    $("#runBatch").disabled = !state.queue.some((j) => j.status === "queued") || state.processing;
    updateStats();
  }

  function addBatchJob() {
    if (!state.file) {
      toast("Load an image first", "err");
      return;
    }
    const id = String(state.queue.length + 1).padStart(2, "0");
    state.queue.push({
      id,
      label: `${state.file.name} · ${state.factor}× · ${[...state.methods].join("+")}`,
      status: "queued",
    });
    renderBatch();
    log(`Queued job #${id}`);
  }

  async function runBatch() {
    const pending = state.queue.filter((j) => j.status === "queued");
    if (!pending.length) return;

    for (const job of pending) {
      job.status = "running";
      renderBatch();
      log(`Batch #${job.id} started`, "warn");
      await run();
      job.status = "done";
      renderBatch();
      log(`Batch #${job.id} done`, "ok");
      await new Promise((r) => setTimeout(r, 220));
    }
    toast("Batch finished", "ok");
  }

  /* ─────────────────────────── report / copy ─────────────────────────── */

  async function exportReport() {
    if (!state.results.length) {
      toast("Run an upscale first", "err");
      return;
    }
    const payload = {
      source: {
        filename: state.file?.name ?? null,
        ...(state.info ?? {}),
      },
      settings: {
        factor: state.factor,
        methods: [...state.methods],
        sharpen: state.sharpen,
        format: state.format,
      },
      results: state.results.map((r) => ({
        method: r.method,
        factor: r.factor,
        resolution: `${r.width}x${r.height}`,
        bytes: r.bytes,
        elapsedMs: r.elapsed,
        metrics: r.metrics,
      })),
      recommended: state.results.slice().sort((a, b) => b.metrics.psnr2 - a.metrics.psnr2)[0]?.method ?? null,
    };

    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `upscale-report-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      log("Experiment report exported", "ok");
      toast("Report downloaded", "ok");
    } catch (err) {
      toast(`Report failed: ${err.message}`, "err");
    }
  }

  async function copyResult() {
    const output = state.results.find((r) => r.method === state.activeMethod);
    if (!output) return;
    const url = state.sharpenMode === "sharp" ? output.url : output.plainUrl;
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast("Result copied to clipboard", "ok");
      log("Copied result to clipboard", "ok");
    } catch {
      toast("Clipboard blocked by the browser", "err");
    }
  }

  function downloadResult(method) {
    const output = state.results.find((r) => r.method === method);
    if (!output) return;
    const a = document.createElement("a");
    a.href = state.sharpenMode === "sharp" ? output.url : output.plainUrl;
    a.download = state.sharpenMode === "sharp" ? output.file : output.plainFile;
    a.click();
    log(`Downloaded ${method} output`);
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function bindControls() {
    // factor
    $$("#factorGroup .seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$("#factorGroup .seg").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.factor = Number(btn.dataset.factor);
        $("#factorOut").textContent = `${state.factor}×`;
        log(`Scale factor → ${state.factor}×`);
      });
    });

    // methods
    const syncMethods = () => {
      $$("#methodGroup .method").forEach((lbl) => {
        const cb = lbl.querySelector("input");
        lbl.classList.toggle("is-on", cb.checked);
      });
      $("#methodOut").textContent = `${state.methods.size} selected`;
    };

    $$("#methodGroup input").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) state.methods.add(cb.value);
        else state.methods.delete(cb.value);
        if (!state.methods.size) {
          cb.checked = true;
          state.methods.add(cb.value);
          toast("Keep at least one kernel selected", "err");
        }
        syncMethods();
        log(`Kernels: ${[...state.methods].join(", ")}`);
      });
    });
    syncMethods();

    // sharpen
    const range = $("#sharpenRange");
    range.addEventListener("input", () => {
      state.sharpen = Number(range.value);
      $("#sharpenOut").textContent = state.sharpen.toFixed(1);
      syncRangeFill(range);
      scheduleRefine();
    });
    syncRangeFill(range);

    // format
    $("#formatSel").addEventListener("change", (e) => {
      state.format = e.target.value;
      log(`Encoder → ${state.format.toUpperCase()}`);
    });

    // run
    $("#runBtn").addEventListener("click", run);

    // upload
    const dz = $("#dropzone");
    const input = $("#fileInput");
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", () => {
      if (input.files?.[0]) acceptFile(input.files[0]);
      input.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-over"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-over"); })
    );
    dz.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) acceptFile(file);
    });

    // examples
    $("#exampleStrip").addEventListener("click", (e) => {
      const card = e.target.closest(".example");
      if (card) loadExample(card.dataset.url, card.dataset.file);
    });
    $("#refreshExamples").addEventListener("click", loadExamples);

    // clear
    $("#clearBtn").addEventListener("click", () => {
      state.file = null;
      state.info = null;
      state.upload = null;
      state.results = [];
      state.histSrc = null;
      state.histOut = null;
      $("#imgBefore").removeAttribute("src");
      $("#imgAfter").removeAttribute("src");
      $("#analysis").hidden = true;
      $("#scrub").classList.remove("has-image");
      $("#scrubEmpty").hidden = false;
      $("#runBtn").disabled = true;
      $("#runHint").textContent = "Load an image first";
      $("#sourceBadge").textContent = "No image";
      $("#outputChips").innerHTML = "";
      $("#downloadAll").disabled = true;
      $("#copyBtn").disabled = true;
      $("#reportBtn").disabled = true;
      $("#verdict").hidden = true;
      renderResultsTable([]);
      drawHistogram();
      updateStats();
      log("Source cleared");
    });

    // compare tools
    $$("#sharpenToggle button").forEach((btn) =>
      btn.addEventListener("click", () => setSharpenMode(btn.dataset.mode))
    );

    $("#outputChips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip) selectOutput(chip.dataset.method);
    });

    $("#resultsBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "select") selectOutput(btn.dataset.method);
      if (btn.dataset.act === "download") downloadResult(btn.dataset.method);
    });

    // zoom
    const zoom = $("#zoomRange");
    zoom.addEventListener("input", () => {
      state.zoom = Number(zoom.value) / 100;
      if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
      applyView();
    });
    $("#resetView").addEventListener("click", () => {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyView();
      setReveal(50);
    });

    // zoom pan via drag when zoomed & not scrubbing (shift-drag)
    $("#stage").addEventListener("pointerdown", (e) => {
      if (state.zoom <= 1 || !e.shiftKey) return;
      const start = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
      const move = (ev) => {
        state.panX = start.px + (ev.clientX - start.x);
        state.panY = start.py + (ev.clientY - start.y);
        applyView();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    // misc actions
    $("#copyBtn").addEventListener("click", copyResult);
    $("#reportBtn").addEventListener("click", exportReport);
    $("#downloadAll").addEventListener("click", () => {
      state.results.forEach((r, i) =>
        setTimeout(() => downloadResult(r.method), i * 140)
      );
    });
    $("#clearResults").addEventListener("click", () => {
      state.results = [];
      state.activeMethod = null;
      state.histOut = null;
      $("#imgAfter").removeAttribute("src");
      $("#scrub").classList.remove("has-image");
      $("#scrubEmpty").hidden = false;
      $("#outputChips").innerHTML = "";
      $("#verdict").hidden = true;
      $("#downloadAll").disabled = true;
      $("#copyBtn").disabled = true;
      renderResultsTable([]);
      drawHistogram();
      log("Results cleared");
    });
    $("#addBatch").addEventListener("click", addBatchJob);
    $("#runBatch").addEventListener("click", runBatch);
    $("#clearLog").addEventListener("click", () => {
      state.logs = [];
      renderLog();
    });

    // shortcuts overlay
    const overlay = $("#shortcutOverlay");
    const openSheet = () => {
      if (!overlay.hidden) return;
      overlay.hidden = false;
      $("#closeShortcuts").focus();
    };
    const closeSheet = () => {
      if (overlay.hidden) return;
      overlay.hidden = true;
      $("#shortcutsBtn").focus();
    };
    $("#shortcutsBtn").addEventListener("click", openSheet);
    $("#closeShortcuts").addEventListener("click", closeSheet);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeSheet();
    });

    // keyboard
    document.addEventListener("keydown", (e) => {
      // While the shortcuts sheet is up, only Escape and ? are live.
      if (!overlay.hidden) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          closeSheet();
        }
        return;
      }

      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" && document.activeElement.type !== "range") return;
      if (tag === "SELECT" || tag === "TEXTAREA") return;

      switch (e.key) {
        case "?":
          e.preventDefault();
          openSheet();
          break;
        case "Escape":
          closeSheet();
          break;
        case "o":
        case "O":
          e.preventDefault();
          $("#fileInput").click();
          break;
        case "Enter":
          if (state.file && !state.processing) { e.preventDefault(); run(); }
          break;
        case "1":
        case "2":
        case "3":
        case "4": {
          const map = ["nearest", "bilinear", "bicubic", "lanczos"];
          const target = map[Number(e.key) - 1];
          const cb = document.querySelector(`#methodGroup input[value="${target}"]`);
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change"));
          }
          break;
        }
        case "s":
        case "S":
          if (state.results.length) setSharpenMode(state.sharpenMode === "sharp" ? "plain" : "sharp");
          break;
        case "ArrowLeft":
          if (state.activeMethod) { e.preventDefault(); setReveal(state.reveal - 3); }
          break;
        case "ArrowRight":
          if (state.activeMethod) { e.preventDefault(); setReveal(state.reveal + 3); }
          break;
        case "+":
        case "=":
          state.zoom = Math.min(3.2, state.zoom + 0.15);
          applyView();
          break;
        case "-":
          state.zoom = Math.max(1, state.zoom - 0.15);
          if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
          applyView();
          break;
        case "c":
        case "C":
          if (state.activeMethod) copyResult();
          break;
        case "r":
        case "R":
          if (state.results.length) exportReport();
          break;
        default:
          break;
      }
    });
  }

  /* ─────────────────────────── boot ─────────────────────────── */

  function boot() {
    bindControls();
    bindScrub();
    renderStages();
    setReveal(50);
    applyView();
    renderBatch();
    updateStats();
    setPipelineBadge("Idle", "live");
    drawHistogram();
    loadExamples();
    log("Studio initialised. Load a sample or drop an image.");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
