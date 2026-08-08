// fasteners.js — parametric SVG isometric drawings for common fastener families.
//
// draw(spec, { width, height, color }) -> { svg: <string>, viewBox: [x,y,w,h] }
//
// The SVG is a 3/4 side-view with a small top ellipse on the head to imply
// depth — recognisable, printable, and compact enough for a 12mm label.
//
// spec fields consulted (all optional):
//   category      Screw | Bolt | Nut | Washer | Anchor | Rivet | Nail
//   subtype       free-text (used for tip: 'wood', 'lag', 'self-tapping', 'machine')
//   head          Pan | Flat | Round | Oval | Truss | Button | Hex | Socket cap | Bugle | None
//   drive         Phillips | Slotted | Pozidriv | Torx | Square | Hex | External hex
//   thread        Wood | Machine | Self-tapping | Sheet metal | Coarse | Fine | None
//   diameterMm    numeric shank diameter (metric mm) — inferred if absent
//   lengthMm      numeric shank length under head (metric mm) — inferred if absent
//   color         head/finish color hint (used only if `color` opt not given)

export function draw(spec = {}, opts = {}) {
  const cat = (spec.category || guessCategory(spec)).toLowerCase();
  if (cat.startsWith("nut"))    return drawNut(spec, opts);
  if (cat.startsWith("wash"))   return drawWasher(spec, opts);
  if (cat.startsWith("rivet"))  return drawRivet(spec, opts);
  if (cat.startsWith("nail"))   return drawNail(spec, opts);
  if (cat.startsWith("anchor")) return drawAnchor(spec, opts);
  if (cat.startsWith("bolt"))   return drawBolt(spec, opts);
  return drawScrew(spec, opts);
}

function guessCategory(spec) {
  const t = ((spec.subtype || "") + " " + (spec.notes || "")).toLowerCase();
  if (/\bnut\b/.test(t)) return "Nut";
  if (/wash/.test(t)) return "Washer";
  if (/rivet/.test(t)) return "Rivet";
  if (/nail/.test(t)) return "Nail";
  if (/bolt/.test(t)) return "Bolt";
  return "Screw";
}

// ---- dimensions ---------------------------------------------------------
function dims(spec) {
  const d = num(spec.diameterMm) || inferDiameterMm(spec);
  const l = num(spec.lengthMm) || inferLengthMm(spec, d);
  return { d, l };
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function inferDiameterMm(spec) {
  const size = String(spec.size || "").trim();
  // metric M-prefix
  const m = size.match(/^M\s*([\d.]+)/i);
  if (m) return parseFloat(m[1]);
  // gauge #N -> approx (Unified thread minor diameter in mm)
  const g = size.match(/^#?\s*(\d{1,2})\b/);
  if (g) {
    const gauge = parseInt(g[1], 10);
    // US gauge -> approx mm major diameter
    return +(1.524 + gauge * 0.815).toFixed(2);
  }
  // fractional inch
  const f = size.match(/(\d+)\s*\/\s*(\d+)/);
  if (f) return (parseInt(f[1],10) / parseInt(f[2],10)) * 25.4;
  // plain inch
  const p = size.match(/^([\d.]+)\s*("|in|inch)/i);
  if (p) return parseFloat(p[1]) * 25.4;
  return 4.5;
}

function inferLengthMm(spec) {
  const s = String(spec.length || "").trim();
  const mm = s.match(/([\d.]+)\s*mm/i);
  if (mm) return parseFloat(mm[1]);
  const f = s.match(/(\d+)\s*(\d+)\s*\/\s*(\d+)/); // 1 1/4
  if (f) return (parseInt(f[1],10) + parseInt(f[2],10)/parseInt(f[3],10)) * 25.4;
  const g = s.match(/(\d+)\s*\/\s*(\d+)/); // 3/4
  if (g) return (parseInt(g[1],10) / parseInt(g[2],10)) * 25.4;
  const p = s.match(/^([\d.]+)/);
  if (p) {
    const n = parseFloat(p[1]);
    if (/mm/i.test(s)) return n;
    // treat plain numbers > 12 as mm, otherwise inches
    if (n > 12) return n;
    return n * 25.4;
  }
  return 25;
}

// ---- palette ------------------------------------------------------------
function palette(spec, opts) {
  const c = (opts.color || spec.color || inferColor(spec)).toLowerCase();
  const map = {
    silver:  { body: "#c8cbcf", edge: "#8b9096", shine: "#f0f2f4" },
    zinc:    { body: "#c8cbcf", edge: "#8b9096", shine: "#f0f2f4" },
    steel:   { body: "#b0b4b9", edge: "#7a7f85", shine: "#e2e5e8" },
    stainless:{body: "#c8cbcf", edge: "#8b9096", shine: "#f0f2f4" },
    black:   { body: "#2a2c2e", edge: "#0e0f10", shine: "#4b4e51" },
    "black oxide":{body:"#2a2c2e", edge:"#0e0f10", shine:"#4b4e51" },
    brass:   { body: "#c69a4a", edge: "#7a5a25", shine: "#e6c374" },
    gold:    { body: "#d4a44a", edge: "#8c6a1e", shine: "#f0cd6a" },
    copper:  { body: "#b87333", edge: "#6f451c", shine: "#dd9959" },
    bronze:  { body: "#8a5a2b", edge: "#553815", shine: "#a6743c" },
    chrome:  { body: "#dfe2e6", edge: "#8f9599", shine: "#ffffff" },
    white:   { body: "#f2f3f4", edge: "#a9adb1", shine: "#ffffff" },
    green:   { body: "#3f8f5b", edge: "#255435", shine: "#5aa976" },
    red:     { body: "#c33a3a", edge: "#7b1f1f", shine: "#e26060" },
    blue:    { body: "#3661a6", edge: "#20406d", shine: "#5580c9" },
    yellow:  { body: "#e2b73c", edge: "#8d6f1c", shine: "#f2cf6a" },
    galvanized: { body:"#a7abb0", edge:"#6d7176", shine:"#c9cdd2" },
    unfinished: { body:"#b7bbc0", edge:"#7c8085", shine:"#dee1e4" },
  };
  if (map[c]) return map[c];
  // try to key on finish text
  const f = (spec.finish || "").toLowerCase();
  for (const k of Object.keys(map)) if (f.includes(k)) return map[k];
  return map.silver;
}
function inferColor(spec) {
  const f = (spec.finish || "").toLowerCase();
  if (f.includes("black")) return "black";
  if (f.includes("brass")) return "brass";
  if (f.includes("chrome")) return "chrome";
  if (f.includes("galvan")) return "galvanized";
  if (f.includes("zinc")) return "zinc";
  const m = (spec.material || "").toLowerCase();
  if (m.includes("brass")) return "brass";
  if (m.includes("copper")) return "copper";
  if (m.includes("stain")) return "stainless";
  if (m.includes("nylon")) return "white";
  return "silver";
}

// ---- helpers -----------------------------------------------------------
function svgWrap(inner, viewBox) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(" ")}" ` +
         `preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}
function grad(id, c) {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0"  stop-color="${c.shine}"/>
    <stop offset="0.5" stop-color="${c.body}"/>
    <stop offset="1"  stop-color="${c.edge}"/>
  </linearGradient>`;
}

// ---- SCREW --------------------------------------------------------------
function drawScrew(spec, opts) {
  const { d, l } = dims(spec);
  const c = palette(spec, opts);
  // scale to viewBox 200 wide
  const HEAD_W = Math.max(14, Math.min(46, d * 3.6));
  const SHANK_W = Math.max(6, d * 1.8);
  // Fit shank length to remaining width
  const MAX_W = 200;
  const MARGIN = 6;
  const shankLen = Math.min(MAX_W - HEAD_W - MARGIN * 2, Math.max(30, l * 1.4));

  const head = (spec.head || "").toLowerCase();
  const drive = (spec.drive || "").toLowerCase();
  const isTapered = /wood|self|sheet|lag|deck|drywall|tap/.test(
    ((spec.subtype || "") + " " + (spec.thread || "")).toLowerCase()
  );

  const cy = 50;
  const shankTop = cy - SHANK_W / 2;
  const shankBot = cy + SHANK_W / 2;
  const headRight = MARGIN + HEAD_W;
  const shankStart = headRight;
  const tipEnd = shankStart + shankLen;
  const tipLen = isTapered ? SHANK_W * 1.6 : 0;
  const shankEnd = tipEnd - tipLen;

  // head shape
  const headSvg = renderHead(head, MARGIN, cy, HEAD_W, SHANK_W, c);
  const driveSvg = renderDrive(drive, MARGIN + HEAD_W * 0.35, cy, HEAD_W * 0.5, c);

  // shank
  const shankSvg = `<rect x="${shankStart}" y="${shankTop}" width="${shankEnd - shankStart}" height="${SHANK_W}" fill="url(#g1)"/>`;

  // tip
  const tipSvg = isTapered
    ? `<polygon points="${shankEnd},${shankTop} ${tipEnd},${cy} ${shankEnd},${shankBot}" fill="url(#g1)"/>`
    : `<rect x="${shankEnd}" y="${shankTop}" width="${tipEnd - shankEnd}" height="${SHANK_W}" fill="url(#g1)"/>`;

  // threads — chevron pattern across the shank
  const threadsSvg = renderThreads(shankStart + 2, cy, shankEnd - shankStart - 2, SHANK_W, c);

  const inner = `<defs>${grad("g1", c)}</defs>${headSvg}${driveSvg}${shankSvg}${threadsSvg}${tipSvg}`;
  return { svg: svgWrap(inner, [0, 0, 200, 100]), viewBox: [0, 0, 200, 100] };
}

function renderHead(head, x, cy, w, shankW, c) {
  const top = cy - w * 0.55;
  const bot = cy + w * 0.55;
  switch (head) {
    case "flat (countersunk)":
    case "flat":
    case "bugle":
      // taper into the shank
      return `<polygon points="${x},${cy - w*0.55} ${x + w},${cy - shankW/2} ${x + w},${cy + shankW/2} ${x},${cy + w*0.55}" fill="url(#g1)"/>` +
             `<line x1="${x}" y1="${cy}" x2="${x + w}" y2="${cy}" stroke="${c.edge}" stroke-width="0.6" opacity="0.4"/>`;
    case "hex":
    case "external hex": {
      // hex prism: front face is a rectangle with cut corners
      const h = w * 0.55;
      const t = w * 0.28;
      const pts = `${x + t},${cy - h} ${x + w - t},${cy - h} ${x + w},${cy - h/2} ${x + w},${cy + h/2} ${x + w - t},${cy + h} ${x + t},${cy + h} ${x},${cy + h/2} ${x},${cy - h/2}`;
      return `<polygon points="${pts}" fill="url(#g1)"/>` +
             `<line x1="${x + t}" y1="${cy - h}" x2="${x + w - t}" y2="${cy - h}" stroke="${c.shine}" stroke-width="0.6" opacity="0.7"/>`;
    }
    case "socket cap": {
      // cylinder viewed from the side + hex hole (drawn in drive)
      const h = w * 0.6;
      return `<rect x="${x}" y="${cy - h}" width="${w}" height="${h*2}" rx="2" fill="url(#g1)"/>`;
    }
    case "button":
    case "round":
    case "oval":
    case "truss":
    case "pan":
    default: {
      // rounded head
      const h = head === "truss" ? w * 0.35 : w * 0.5;
      // ellipse-ish
      return `<path d="M ${x} ${cy - h*0.5} ` +
             `Q ${x + w*0.02} ${cy - h} ${x + w*0.5} ${cy - h} ` +
             `Q ${x + w - w*0.02} ${cy - h} ${x + w} ${cy - h*0.5} ` +
             `L ${x + w} ${cy + h*0.5} ` +
             `Q ${x + w - w*0.02} ${cy + h} ${x + w*0.5} ${cy + h} ` +
             `Q ${x + w*0.02} ${cy + h} ${x} ${cy + h*0.5} Z" ` +
             `fill="url(#g1)"/>`;
    }
  }
}

function renderDrive(drive, x, cy, w, c) {
  const stroke = c.edge;
  const sw = Math.max(1, w * 0.08);
  const half = w / 2;
  switch (drive) {
    case "slotted":
      return `<line x1="${x - w*0.9}" y1="${cy}" x2="${x + w*0.9}" y2="${cy}" stroke="${stroke}" stroke-width="${sw*1.4}"/>`;
    case "phillips":
      return `<line x1="${x - w*0.7}" y1="${cy}" x2="${x + w*0.7}" y2="${cy}" stroke="${stroke}" stroke-width="${sw}"/>` +
             `<line x1="${x}" y1="${cy - w*0.7}" x2="${x}" y2="${cy + w*0.7}" stroke="${stroke}" stroke-width="${sw}"/>`;
    case "pozidriv":
      return `<line x1="${x - w*0.7}" y1="${cy}" x2="${x + w*0.7}" y2="${cy}" stroke="${stroke}" stroke-width="${sw}"/>` +
             `<line x1="${x}" y1="${cy - w*0.7}" x2="${x}" y2="${cy + w*0.7}" stroke="${stroke}" stroke-width="${sw}"/>` +
             `<line x1="${x - w*0.55}" y1="${cy - w*0.55}" x2="${x + w*0.55}" y2="${cy + w*0.55}" stroke="${stroke}" stroke-width="${sw*0.6}"/>` +
             `<line x1="${x - w*0.55}" y1="${cy + w*0.55}" x2="${x + w*0.55}" y2="${cy - w*0.55}" stroke="${stroke}" stroke-width="${sw*0.6}"/>`;
    case "square (robertson)":
    case "square":
      return `<rect x="${x - half*0.55}" y="${cy - half*0.55}" width="${half*1.1}" height="${half*1.1}" fill="${stroke}"/>`;
    case "hex (allen)":
    case "hex": {
      const r = half * 0.7;
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        pts.push(`${(x + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
      }
      return `<polygon points="${pts.join(" ")}" fill="${stroke}"/>`;
    }
    case "torx": {
      const r1 = half * 0.75;
      const r2 = half * 0.42;
      const pts = [];
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const r = i % 2 ? r2 : r1;
        pts.push(`${(x + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
      }
      return `<polygon points="${pts.join(" ")}" fill="${stroke}"/>`;
    }
    case "external hex":
      return "";
    default:
      return "";
  }
}

function renderThreads(x, cy, w, h, c) {
  if (w < 8) return "";
  const pitch = Math.max(3, h * 0.55);
  const half = h / 2;
  const paths = [];
  for (let px = x; px < x + w - pitch; px += pitch) {
    paths.push(`M ${px} ${cy - half} L ${px + pitch/2} ${cy - half + 1.2}`);
    paths.push(`M ${px + pitch/2} ${cy + half - 1.2} L ${px + pitch} ${cy + half}`);
  }
  return `<path d="${paths.join(" ")}" stroke="${c.edge}" stroke-width="0.8" fill="none" opacity="0.55"/>`;
}

// ---- BOLT (hex bolt) ---------------------------------------------------
function drawBolt(spec, opts) {
  // use the screw renderer with a hex head + machine threads
  const s = { ...spec, head: spec.head || "Hex", drive: spec.drive || "External hex", thread: spec.thread || "Machine" };
  return drawScrew(s, opts);
}

// ---- NUT ---------------------------------------------------------------
function drawNut(spec, opts) {
  const { d } = dims(spec);
  const c = palette(spec, opts);
  const size = Math.max(30, Math.min(70, d * 5));
  const cx = 100, cy = 50;
  const r = size / 2;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
  }
  // subtle top ellipse for isometric hint
  const hole = Math.max(6, r * 0.42);
  const inner = `<defs>${grad("g1", c)}</defs>
    <polygon points="${pts.join(" ")}" fill="url(#g1)" stroke="${c.edge}" stroke-width="0.8"/>
    <circle cx="${cx}" cy="${cy}" r="${hole}" fill="#111" opacity="0.85"/>
    <circle cx="${cx}" cy="${cy}" r="${hole * 0.85}" fill="none" stroke="${c.shine}" stroke-width="0.6" opacity="0.3"/>`;
  return { svg: svgWrap(inner, [0, 0, 200, 100]), viewBox: [0, 0, 200, 100] };
}

// ---- WASHER ------------------------------------------------------------
function drawWasher(spec, opts) {
  const { d } = dims(spec);
  const c = palette(spec, opts);
  const rOuter = Math.max(18, Math.min(38, d * 3.2));
  const rInner = Math.max(5, rOuter * 0.42);
  const cx = 100, cy = 50;
  // isometric: viewed at a shallow angle, so ellipse
  const rx = rOuter, ry = rOuter * 0.55;
  const irx = rInner, iry = rInner * 0.55;
  const inner = `<defs>${grad("g1", c)}</defs>
    <ellipse cx="${cx}" cy="${cy + 3}" rx="${rx}" ry="${ry}" fill="${c.edge}" opacity="0.4"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#g1)" stroke="${c.edge}" stroke-width="0.6"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${irx}" ry="${iry}" fill="#111" opacity="0.85"/>`;
  return { svg: svgWrap(inner, [0, 0, 200, 100]), viewBox: [0, 0, 200, 100] };
}

// ---- RIVET / NAIL / ANCHOR fallbacks -----------------------------------
function drawRivet(spec, opts) {
  // dome head + thin shank
  const s = { ...spec, head: "Round", drive: "None", thread: "None" };
  return drawScrew(s, opts);
}
function drawNail(spec, opts) {
  const s = { ...spec, head: "Round", drive: "None", thread: "None", subtype: (spec.subtype||"") + " tapered" };
  return drawScrew(s, opts);
}
function drawAnchor(spec, opts) {
  const s = { ...spec, head: spec.head || "Pan", thread: "Wood" };
  return drawScrew(s, opts);
}
