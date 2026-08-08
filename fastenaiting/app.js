// fastenAIting main app — capture, identify, label, buy.
// Vanilla ESM, no build.

import { draw as drawFastener } from "/fastenaiting/fasteners.js";
import { buildLinks } from "/fastenaiting/affiliate.js";

// ---- service worker ----------------------------------------------------
// Registered lazily so it never blocks first paint. `file://` and non-HTTPS
// dev servers are skipped so DevTools stays clean.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/fastenaiting/sw.js", { scope: "/fastenaiting/" })
      .catch(() => { /* offline caching is a nice-to-have; failure is fine */ });
  });
}

// ---- persisted settings ------------------------------------------------
const SETTINGS_KEY = "fastenaiting:settings:v1";
const DEFAULT_SETTINGS = {
  apiKey: "",
  amazonTag: "",
  homeDepotTag: "",
  lowesTag: "",
  showIso: true,
  showBrand: true,
};
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
let settings = loadSettings();

// ---- element refs ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const video = $("video");
const cameraPlaceholder = $("cameraPlaceholder");
const startCamBtn = $("startCam");     // doubles as shutter when stream is live
const switchCamBtn = $("switchCam");
const stopCamBtn = $("stopCam");
const drop = $("drop");
const fileInput = $("fileInput");
const manualText = $("manualText");
const manualAnalyze = $("manualAnalyze");
const photo = $("photo");
const photoEmpty = $("photoEmpty");
const identifyBtn = $("identifyBtn");
const aiStatus = $("aiStatus");
const specForm = $("specForm");
const labelCanvas = $("labelCanvas");
const labelStyle = $("labelStyle");
const labelLen = $("labelLen");
const downloadBtn = $("downloadLabel");
const printBtn = $("printLabel");
const buyLinks = $("buyLinks");
const settingsBtn = $("settingsBtn");
const resetBtn = $("resetBtn");
const settingsDialog = $("settings");
const installBtn = $("installBtn");
const ctaBtn = $("ctaBtn");
const offlinePill = $("offlinePill");

// ---- state -------------------------------------------------------------
let currentImageDataUrl = null;   // last captured/uploaded image
let currentImageMime = "image/jpeg";
let stream = null;
let facingMode = "environment";
let devicesChecked = false;
let identifiedOnce = false;       // has the AI (or manual) filled anything?
let activeTab = "camera";
let deferredInstall = null;       // beforeinstallprompt event, if fired

// ---- status ------------------------------------------------------------
function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// ---- tabs --------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t === btn;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("on"));
    document.getElementById("tab-" + btn.dataset.tab).classList.add("on");
    activeTab = btn.dataset.tab;
    updateCta();
  });
});

// ---- camera ------------------------------------------------------------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera not supported in this browser.", "error");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    video.srcObject = stream;
    video.dataset.active = "1";
    cameraPlaceholder.style.display = "none";
    stopCamBtn.disabled = false;
    if (!devicesChecked) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter((d) => d.kind === "videoinput");
      if (cams.length > 1) switchCamBtn.disabled = false;
      devicesChecked = true;
    }
    setStatus("Camera ready — tap the shutter.", "ok");
    refreshShutter();
    updateCta();
  } catch (err) {
    setStatus("Camera error: " + (err.message || err), "error");
  }
}
function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  delete video.dataset.active;
  cameraPlaceholder.style.display = "";
  stopCamBtn.disabled = true;
  switchCamBtn.disabled = true;
  refreshShutter();
  updateCta();
}
async function switchCamera() {
  facingMode = facingMode === "environment" ? "user" : "environment";
  stopCamera();
  await startCamera();
}
function snap() {
  if (!stream) return;
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 960;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(video, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  setImage(dataUrl, "image/jpeg");
  setStatus("Snapped. Hit “Identify with AI”.", "ok");
  if ("vibrate" in navigator) navigator.vibrate(20);
}

// The shutter button doubles as start-camera when the stream is off, and
// snap-photo when it's live — one big thumb-friendly button.
startCamBtn.addEventListener("click", () => {
  if (stream) snap();
  else startCamera();
});
stopCamBtn.addEventListener("click", stopCamera);
switchCamBtn.addEventListener("click", switchCamera);
function refreshShutter() {
  startCamBtn.textContent = stream ? "●" : "▶︎";
  startCamBtn.title = stream ? "Take photo" : "Start camera";
  startCamBtn.setAttribute("aria-label", stream ? "Take photo" : "Start camera");
}

// ---- upload / drop -----------------------------------------------------
drop.addEventListener("click", () => fileInput.click());
["dragover", "dragenter"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hover"); })
);
["dragleave", "dragend", "drop"].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.remove("hover"))
);
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  if (!file.type.startsWith("image/")) {
    setStatus("That's not an image.", "error");
    return;
  }
  const dataUrl = await readFileAsDataURL(file);
  setImage(dataUrl, file.type || "image/jpeg");
  setStatus("Loaded. Hit “Identify with AI”.", "ok");
}
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function setImage(dataUrl, mime) {
  currentImageDataUrl = dataUrl;
  currentImageMime = mime;
  photo.src = dataUrl;
  photo.hidden = false;
  photoEmpty.style.display = "none";
  identifyBtn.disabled = false;
  identifiedOnce = false;
  updateCta();
}

// ---- manual analyze (text only) ----------------------------------------
manualAnalyze.addEventListener("click", async () => {
  const text = manualText.value.trim();
  if (!text) { setStatus("Type a description first.", "error"); return; }
  aiStatus.textContent = "thinking…";
  try {
    const parsed = await identify({ text });
    applySpec(parsed);
    setStatus("Filled from description.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    aiStatus.textContent = "";
  }
});

// ---- identify (image or text) ------------------------------------------
identifyBtn.addEventListener("click", async () => {
  if (!currentImageDataUrl) return;
  aiStatus.textContent = "thinking…";
  identifyBtn.disabled = true;
  try {
    const parsed = await identify({ imageDataUrl: currentImageDataUrl, mime: currentImageMime });
    applySpec(parsed);
    setStatus("Identified. Tweak anything below if needed.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    aiStatus.textContent = "";
    identifyBtn.disabled = false;
  }
});

async function identify({ imageDataUrl, mime, text }) {
  // Body: either image (base64 payload extracted) or text.
  const body = {};
  if (imageDataUrl) {
    body.image = imageDataUrl.replace(/^data:[^;]+;base64,/, "");
    body.mediaType = mime || "image/jpeg";
  }
  if (text) body.text = text;

  const headers = { "content-type": "application/json" };
  if (settings.apiKey) headers["x-user-api-key"] = settings.apiKey;

  const res = await fetch("/api/fastenaiting/identify", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 501) {
    throw new Error("The identifier isn't configured on the server. Add your Anthropic key in Settings.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch {}
    throw new Error(detail || `Identify failed (${res.status})`);
  }
  return res.json();
}

// ---- spec form -> state ------------------------------------------------
function readSpec() {
  const data = Object.fromEntries(new FormData(specForm).entries());
  // trim
  Object.keys(data).forEach((k) => (data[k] = String(data[k] || "").trim()));
  // helpful derived numeric mm dimensions for the SVG
  data.diameterMm = mmDiameter(data);
  data.lengthMm = mmLength(data);
  return data;
}
function applySpec(spec) {
  // populate form
  for (const el of specForm.elements) {
    if (!el.name) continue;
    if (spec[el.name] != null && spec[el.name] !== "") el.value = spec[el.name];
  }
  identifiedOnce = true;
  renderAll();
  updateCta();
}

specForm.addEventListener("input", renderAll);
specForm.addEventListener("change", renderAll);
labelStyle.addEventListener("change", renderAll);
labelLen.addEventListener("change", renderAll);

// ---- rendering pipeline ------------------------------------------------
function renderAll() {
  const spec = readSpec();
  renderLabel(spec);
  updateBuyLinks(spec);
}

function updateBuyLinks(spec) {
  const links = buildLinks(spec, settings);
  const map = { "home-depot": "homeDepot", "lowes": "lowes", "amazon": "amazon" };
  buyLinks.querySelectorAll("a.buy").forEach((a) => {
    for (const cls of Object.keys(map)) {
      if (a.classList.contains(cls)) {
        const href = links[map[cls]];
        if (href) { a.href = href; a.classList.add("ready"); }
        else { a.removeAttribute("href"); a.classList.remove("ready"); }
      }
    }
  });
}

// ---- LABEL RENDERING ---------------------------------------------------
// 12mm at 360dpi target = ~170 px tall.
const DPI = 360;
const MM_PER_INCH = 25.4;
function mmToPx(mm) { return Math.round((mm / MM_PER_INCH) * DPI); }

async function renderLabel(spec) {
  const heightMm = 12;
  const style = labelStyle.value;
  const lengthMm = style === "square" ? 24 : parseInt(labelLen.value, 10);
  const w = mmToPx(lengthMm);
  const h = mmToPx(heightMm);
  labelCanvas.width = w;
  labelCanvas.height = h;
  const displayCap = 640;
  const scale = Math.min(1, displayCap / w);
  labelCanvas.style.width = Math.round(w * scale) + "px";
  labelCanvas.style.height = Math.round(h * scale) + "px";

  const ctx = labelCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  // safe margins — a little inset so the tape shears don't clip the print
  const pad = Math.round(h * 0.06);
  const inner = { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 };

  // isometric on the left
  let textX = inner.x;
  if (settings.showIso) {
    const iconW = Math.round(inner.h * (style === "square" ? 1.4 : 1.6));
    const iconH = inner.h;
    const { svg } = drawFastener(spec, { width: iconW, height: iconH, color: spec.color });
    await drawSvg(ctx, svg, inner.x, inner.y, iconW, iconH);
    textX = inner.x + iconW + Math.round(inner.h * 0.15);
  }

  const textArea = { x: textX, y: inner.y, w: inner.x + inner.w - textX, h: inner.h };
  drawLabelText(ctx, spec, textArea, { compact: style === "square" });
}

function drawSvg(ctx, svg, x, y, w, h) {
  return new Promise((resolve) => {
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, x, y, w, h); resolve(); };
    img.onerror = resolve;
    img.src = url;
  });
}

function drawLabelText(ctx, spec, area, { compact }) {
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  const primary = titleLine(spec);
  const secondary = subLine(spec);
  const tertiary = finishLine(spec);

  const lines = [
    { text: primary, weight: 700, size: compact ? area.h * 0.24 : area.h * 0.32 },
    { text: secondary, weight: 500, size: area.h * 0.17 },
  ];
  if (!compact && tertiary) {
    lines.push({ text: tertiary, weight: 400, size: area.h * 0.14 });
  }
  // brand wordmark: bottom-right corner (optional)
  const gap = area.h * 0.04;

  // shrink main line to fit
  const family = 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  ctx.font = `${lines[0].weight} ${lines[0].size}px ${family}`;
  while (ctx.measureText(primary).width > area.w && lines[0].size > 12) {
    lines[0].size -= 1;
    ctx.font = `${lines[0].weight} ${lines[0].size}px ${family}`;
  }

  let y = area.y;
  for (const line of lines) {
    if (!line.text) continue;
    ctx.font = `${line.weight} ${line.size}px ${family}`;
    // fit width
    let text = line.text;
    let sz = line.size;
    while (ctx.measureText(text).width > area.w && sz > 10) {
      sz -= 1;
      ctx.font = `${line.weight} ${sz}px ${family}`;
    }
    while (ctx.measureText(text).width > area.w && text.length > 6) {
      text = text.slice(0, -2) + "…";
    }
    ctx.fillText(text, area.x, y);
    y += Math.round(sz + gap);
  }

  if (settings.showBrand) {
    const bs = area.h * 0.11;
    ctx.font = `400 ${bs}px ${family}`;
    ctx.fillStyle = "#999";
    const brand = "fastenAIting.com";
    const bw = ctx.measureText(brand).width;
    if (bw + 6 < area.w) {
      ctx.fillText(brand, area.x + area.w - bw, area.y + area.h - bs - 2);
    }
    ctx.fillStyle = "#111111";
  }
}

// ---- text composition --------------------------------------------------
function titleLine(s) {
  const size = s.size ? s.size.trim() : "";
  const length = s.length ? s.length.trim() : "";
  if (size && length) return `${size} × ${length}`;
  return size || length || s.subtype || s.category || "Fastener";
}
function subLine(s) {
  const bits = [];
  if (s.subtype) bits.push(s.subtype);
  else if (s.category) bits.push(s.category);
  if (s.head && s.head.toLowerCase() !== "none") bits.push(s.head + " head");
  if (s.drive && s.drive.toLowerCase() !== "none") bits.push(s.drive);
  return bits.join(" · ");
}
function finishLine(s) {
  const bits = [];
  if (s.material) bits.push(s.material);
  if (s.finish && s.finish.toLowerCase() !== "unfinished") bits.push(s.finish);
  else if (s.color) bits.push(s.color);
  if (s.pitch) bits.push(s.pitch);
  return bits.join(" · ");
}

// ---- unit helpers for SVG ----------------------------------------------
function mmDiameter(s) {
  const size = String(s.size || "").trim();
  const m = size.match(/^M\s*([\d.]+)/i);
  if (m) return parseFloat(m[1]);
  const g = size.match(/^#?\s*(\d{1,2})\b/);
  if (g) return +(1.524 + parseInt(g[1], 10) * 0.815).toFixed(2);
  const f = size.match(/(\d+)\s*\/\s*(\d+)/);
  if (f) return (parseInt(f[1], 10) / parseInt(f[2], 10)) * 25.4;
  const p = size.match(/^([\d.]+)/);
  if (p) return parseFloat(p[1]) * (/mm/i.test(size) ? 1 : 25.4);
  return 0;
}
function mmLength(s) {
  const l = String(s.length || "").trim();
  if (/mm/i.test(l)) { const n = parseFloat(l); if (Number.isFinite(n)) return n; }
  const mixed = l.match(/(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) return (parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10)) * 25.4;
  const frac = l.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return (parseInt(frac[1], 10) / parseInt(frac[2], 10)) * 25.4;
  const p = l.match(/^([\d.]+)/);
  if (p) { const n = parseFloat(p[1]); return n > 12 ? n : n * 25.4; }
  return 0;
}

// ---- download / print --------------------------------------------------
downloadBtn.addEventListener("click", () => {
  const spec = readSpec();
  const name = fileSafe(titleLine(spec)) || "fastener";
  const a = document.createElement("a");
  a.download = `${name}-12mm.png`;
  a.href = labelCanvas.toDataURL("image/png");
  a.click();
});
function fileSafe(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
}
printBtn.addEventListener("click", () => {
  const dataUrl = labelCanvas.toDataURL("image/png");
  const win = window.open("", "_blank", "width=800,height=300");
  if (!win) return;
  win.document.write(`<!doctype html><html><head><title>Print label</title>
    <style>
      @page { margin: 0; size: auto; }
      body { margin: 0; display: grid; place-items: center; background: #eee; }
      img { display: block; height: 12mm; image-rendering: pixelated; }
      @media print { body { background: #fff; } }
    </style></head><body>
    <img src="${dataUrl}" onload="setTimeout(()=>window.print(), 60)">
    </body></html>`);
  win.document.close();
});

// ---- reset -------------------------------------------------------------
resetBtn.addEventListener("click", () => {
  specForm.reset();
  photo.hidden = true;
  photo.removeAttribute("src");
  photoEmpty.style.display = "";
  currentImageDataUrl = null;
  identifyBtn.disabled = true;
  identifiedOnce = false;
  manualText.value = "";
  renderAll();
  updateCta();
  setStatus("Cleared. Show me another one.");
});

// ---- settings dialog ---------------------------------------------------
function fillSettingsUI() {
  $("setApiKey").value = settings.apiKey || "";
  $("setAmazonTag").value = settings.amazonTag || "";
  $("setHomeDepotTag").value = settings.homeDepotTag || "";
  $("setLowesTag").value = settings.lowesTag || "";
  $("setShowIso").checked = !!settings.showIso;
  $("setShowBrand").checked = !!settings.showBrand;
}
settingsBtn.addEventListener("click", () => {
  fillSettingsUI();
  settingsDialog.showModal();
});
settingsDialog.addEventListener("close", () => {
  if (settingsDialog.returnValue === "save") {
    settings = {
      apiKey: $("setApiKey").value.trim(),
      amazonTag: $("setAmazonTag").value.trim(),
      homeDepotTag: $("setHomeDepotTag").value.trim(),
      lowesTag: $("setLowesTag").value.trim(),
      showIso: $("setShowIso").checked,
      showBrand: $("setShowBrand").checked,
    };
    saveSettings(settings);
    renderAll();
    setStatus("Settings saved.", "ok");
  }
});

// ---- install prompt (PWA) ---------------------------------------------
// Chrome/Edge/Android fire beforeinstallprompt when the app is installable.
// We stash it, reveal the button, and call prompt() on click. iOS Safari
// doesn't fire this event — installation there is "Share > Add to Home
// Screen"; we surface a hint in Settings for those users.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  installBtn.disabled = true;
  try {
    deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    setStatus(outcome === "accepted" ? "Installed — check your home screen." : "Install skipped.", "ok");
  } finally {
    deferredInstall = null;
    installBtn.hidden = true;
    installBtn.disabled = false;
  }
});
window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
  setStatus("Installed. Look for the fastenAIting icon.", "ok");
});

// ---- offline indicator -------------------------------------------------
function reflectOnline() {
  const on = navigator.onLine;
  offlinePill.hidden = on;
  if (!on) offlinePill.textContent = "Offline — the identifier needs the network";
}
window.addEventListener("online", reflectOnline);
window.addEventListener("offline", reflectOnline);
reflectOnline();

// ---- contextual CTA (sticky bottom bar, mobile only) -------------------
// The bar shows the single "next thing to do" so the user's thumb is always
// near the right button. States, in order:
//   1. Camera tab, no stream           -> Take a photo   (starts camera)
//   2. Camera tab, stream, no image    -> Snap           (snaps)
//   3. Image loaded, no ID yet         -> Identify       (calls AI)
//   4. Form has meaningful data        -> Download label (downloads PNG)
function updateCta() {
  if (!ctaBtn) return;
  const hasImage = !!currentImageDataUrl;
  const hasSpec = formHasSpec();

  let label, action;
  if (activeTab === "camera" && !hasImage && !stream) {
    label = "Take a photo";
    action = () => startCamera();
  } else if (activeTab === "camera" && !hasImage && stream) {
    label = "Snap ●";
    action = () => snap();
  } else if (hasImage && !identifiedOnce) {
    label = "Identify with AI";
    action = () => identifyBtn.click();
  } else if (hasSpec) {
    label = "⬇ Download label";
    action = () => downloadBtn.click();
  } else if (activeTab === "manual") {
    label = "Analyze description";
    action = () => manualAnalyze.click();
  } else if (activeTab === "upload") {
    label = "Pick a photo";
    action = () => fileInput.click();
  } else {
    label = "Take a photo";
    action = () => startCamera();
  }
  ctaBtn.textContent = label;
  ctaBtn.onclick = action;
}
function formHasSpec() {
  const s = readSpec();
  return !!(s.size || s.length || s.subtype || s.category);
}

// Recompute CTA whenever the form changes so "Download label" appears at
// the right moment.
specForm.addEventListener("input", updateCta);
specForm.addEventListener("change", updateCta);

// initial paint
renderAll();
refreshShutter();
updateCta();
