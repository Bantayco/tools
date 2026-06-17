// cache-bust: served with no-long-cache headers (see /_headers)
// Paper Doomscroll — paste a paper, scroll a card feed, get a little
// dopamine on every flick. Document-tool pattern: autosave + ?id/?f loading.
import { getAssetParam, setAssetParam } from "/_shared/util.js";
import { getAsset } from "/_shared/api.js";
import { createStore, slugify } from "/_shared/autosave.js";

const TOOL = "doomscroll";
const DRAFT_KEY = "bantay-doomscroll-draft";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- Elements ----
const setupEl = document.querySelector("#setup");
const feedEl = document.querySelector("#feed");
const titleInput = document.querySelector("#title");
const sourceInput = document.querySelector("#source");
const myPapers = document.querySelector("#myPapers");
const status = document.querySelector("#status");
const loadSample = document.querySelector("#loadSample");
const startBtn = document.querySelector("#start");
const exitBtn = document.querySelector("#exit");
const cardsEl = document.querySelector("#cards");
const progressBar = document.querySelector("#progressBar");
const streakChip = document.querySelector("#streak");
const levelChip = document.querySelector("#level");
const soundToggle = document.querySelector("#soundToggle");
const popsEl = document.querySelector("#pops");
const confettiCanvas = document.querySelector("#confetti");

const store = createStore({
  tool: TOOL,
  draftKey: DRAFT_KEY,
  getTitle: () => titleInput.value,
  getPayload: () => ({ source: sourceInput.value }),
  onStatus: showStatus,
  onSaved: () => store.init().then(fillSwitcher),
});

init();

async function init() {
  bindEvents();
  const params = new URLSearchParams(location.search);

  // Restore the working draft unless ?new asks for a clean start.
  const draft = !params.has("new") && store.loadLocal();
  if (draft) {
    sourceInput.value = draft.source || "";
    titleInput.value = draft.title || "";
    if (draft.slug) store.setSlug(draft.slug);
  }

  fillSwitcher(await store.init());

  // Precedence: ?id=<saved> > ?f=<shipped sample>.
  const id = params.get("id");
  const sample = getAssetParam("f");
  try {
    if (id) await openSaved(slugify(id));
    else if (sample) await loadSampleFile(sample);
  } catch (err) {
    showStatus(err.message);
  }
}

function bindEvents() {
  sourceInput.addEventListener("input", () => store.change());
  titleInput.addEventListener("input", () => store.change());
  titleInput.addEventListener("change", () => store.rename());
  myPapers.addEventListener("change", loadSelected);
  loadSample.addEventListener("click", () => loadSampleFile("dopamine"));
  startBtn.addEventListener("click", startScrolling);
  exitBtn.addEventListener("click", exitFeed);
  soundToggle.addEventListener("click", toggleSound);

  // Keyboard: arrows / space / j-k page through the feed.
  cardsEl.addEventListener("keydown", (e) => {
    const step = cardsEl.clientHeight;
    if (["ArrowDown", "PageDown", "j", " "].includes(e.key)) {
      cardsEl.scrollBy({ top: step, behavior: "smooth" });
      e.preventDefault();
    } else if (["ArrowUp", "PageUp", "k"].includes(e.key)) {
      cardsEl.scrollBy({ top: -step, behavior: "smooth" });
      e.preventDefault();
    }
  });

  window.addEventListener("resize", sizeConfetti);
}

// ============================================================
//  Chunking — turn a wall of text into scrollable bite-size cards
// ============================================================
const TARGET = 320; // ~chars per text card
const HYPE_EVERY = 4; // a hype interstitial every N content cards

function chunk(text) {
  const blocks = String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const cards = [];
  for (const block of blocks) {
    if (isHeading(block)) {
      cards.push({ type: "heading", text: block.replace(/^#+\s*/, "") });
      continue;
    }
    for (const piece of packSentences(block)) {
      cards.push({ type: "text", text: piece });
    }
  }
  return cards;
}

// A short line with no sentence-ending punctuation reads like a heading
// (also explicit markdown "# " headings).
function isHeading(block) {
  if (/^#{1,6}\s/.test(block)) return true;
  return block.length <= 70 && !/[.?!:]$/.test(block) && block.split(" ").length <= 10;
}

// Greedily pack whole sentences up to ~TARGET chars so no card is a lonely
// fragment and none is a wall of text.
function packSentences(block) {
  // Whole sentences, plus a final clause that has no terminal punctuation
  // (otherwise a period-less paragraph would lose everything but its last word).
  const sentences = block.match(/[^.?!]+[.?!]+["')\]]*|[^.?!]+$/g) || [block];
  const out = [];
  let buf = "";
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (buf && (buf.length + t.length + 1) > TARGET) {
      out.push(buf);
      buf = t;
    } else {
      buf = buf ? `${buf} ${t}` : t;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Phrases sprinkled onto hype cards + pops. Pure dopamine, zero nutrition.
const HYPE = [
  { e: "🔥", t: "You're on FIRE. Don't stop now." },
  { e: "🧠", t: "Big brain energy detected." },
  { e: "📈", t: "Knowledge stonks only go up." },
  { e: "⚡", t: "Certified galaxy-brain moment." },
  { e: "🚀", t: "To the moon. Keep scrolling." },
  { e: "💎", t: "Diamond focus. Hold the line." },
  { e: "🏆", t: "Smarter than 99% of scrollers." },
  { e: "✨", t: "This part? Iconic. Keep going." },
];
const POP_CHEERS = ["nice!", "+1 IQ", "smart!", "🔥 combo", "genius", "ooh", "big brain", "yesss"];

// ============================================================
//  Build the feed DOM
// ============================================================
let cardEls = [];
let total = 0;

function buildFeed(text) {
  const items = chunk(text);
  cardsEl.innerHTML = "";

  if (!items.length) {
    showStatus("Nothing to scroll — paste some text first.");
    return false;
  }

  let contentSeen = 0;
  let hypeIdx = 0;
  for (const item of items) {
    cardsEl.appendChild(renderCard(item));
    if (item.type !== "heading") {
      contentSeen++;
      if (contentSeen % HYPE_EVERY === 0) {
        cardsEl.appendChild(renderHype(HYPE[hypeIdx++ % HYPE.length]));
      }
    }
  }
  cardsEl.appendChild(renderEnd());

  cardEls = Array.from(cardsEl.children);
  total = cardEls.length;
  return true;
}

function renderCard(item) {
  const el = document.createElement("section");
  el.className = "card" + (item.type === "heading" ? " is-heading" : "");
  const kicker = item.type === "heading" ? "section" : "keep going";
  el.innerHTML =
    `<p class="kicker">${kicker}</p>` +
    `<div class="body">${highlight(esc(item.text))}</div>` +
    rail();
  return el;
}

function renderHype({ e, t }) {
  const el = document.createElement("section");
  el.className = "card is-hype";
  el.dataset.hype = "1";
  el.innerHTML =
    `<div class="hype-emoji">${e}</div>` +
    `<p class="kicker">milestone</p>` +
    `<div class="body">${esc(t)}</div>`;
  return el;
}

function renderEnd() {
  const el = document.createElement("section");
  el.className = "card is-end";
  el.dataset.end = "1";
  el.innerHTML =
    `<div class="hype-emoji">🎉</div>` +
    `<div class="body">You finished the whole thing.</div>` +
    `<div class="stat-grid">` +
    `<div class="stat"><b id="endXp">0</b><span>XP earned</span></div>` +
    `<div class="stat"><b id="endLevel">1</b><span>level</span></div>` +
    `<div class="stat"><b id="endStreak">0</b><span>best streak</span></div>` +
    `</div>` +
    `<p class="kicker">touch grass? or scroll up and do it again.</p>`;
  return el;
}

// One "like" button per card — the cheapest dopamine of all.
function rail() {
  return (
    `<div class="rail">` +
    `<button type="button" data-like aria-label="Like"><span class="ico">🤍</span><span data-count>0</span></button>` +
    `</div>`
  );
}

// Underline a few of the longest words so each card has a "highlighted" beat.
function highlight(safeHtml) {
  let n = 0;
  return safeHtml.replace(/\b([A-Za-z]{9,})\b/g, (m) =>
    n++ % 3 === 0 ? `<em class="spark">${m}</em>` : m
  );
}

// ============================================================
//  Dopamine engine
// ============================================================
let xp = 0;
let level = 1;
let streak = 0;
let bestStreak = 0;
let maxReached = -1;
let likes = 0;
let observer = null;

function startScrolling() {
  if (!buildFeed(sourceInput.value)) return;
  resetGame();
  setupEl.hidden = true;
  feedEl.hidden = false;
  sizeConfetti();
  observeCards();
  cardsEl.scrollTo({ top: 0 });
  cardsEl.focus({ preventScroll: true });
  // Award the first card immediately (the observer may not fire on the
  // already-visible top card).
  reachCard(0);
}

function exitFeed() {
  if (observer) observer.disconnect();
  feedEl.hidden = true;
  setupEl.hidden = false;
  showStatus("Back to the paste board. Try another paper?");
}

function resetGame() {
  xp = 0;
  level = 1;
  streak = 0;
  bestStreak = 0;
  maxReached = -1;
  likes = 0;
  lastMilestone = 0;
  updateHud();
  progressBar.style.width = "0%";
}

function observeCards() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(onIntersect, {
    root: cardsEl,
    threshold: reduceMotion ? 0.4 : 0.6,
  });
  cardEls.forEach((el) => observer.observe(el));

  // Like buttons (delegated).
  cardsEl.addEventListener("click", onCardClick);
}

function onIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("seen");
    reachCard(cardEls.indexOf(entry.target));
  }
}

// Reaching a new, deeper card is the core reward loop.
function reachCard(idx) {
  if (idx < 0) return;
  progressBar.style.width = `${Math.round(((idx + 1) / total) * 100)}%`;

  if (idx <= maxReached) return; // scrolling back up doesn't re-pay
  const firstTime = maxReached === -1;
  maxReached = idx;

  streak += 1;
  bestStreak = Math.max(bestStreak, streak);

  const el = cardEls[idx];
  const isHype = el?.dataset.hype === "1";
  const isEnd = el?.dataset.end === "1";

  if (isEnd) {
    finish();
    return;
  }

  // XP grows with streak so a long uninterrupted scroll feels great.
  const gain = 10 + Math.min(streak, 12) * 2 + (isHype ? 25 : 0);
  addXp(gain, isHype);

  if (isHype) {
    burst(60);
    haptic([12, 30, 12]);
  } else if (!firstTime && Math.random() < 0.45) {
    // Surprise micro-reward — variable rewards are the sticky kind.
    pop(pick(POP_CHEERS), true);
    blip(660);
  }

  // Progress milestones.
  const pct = ((idx + 1) / total) * 100;
  checkMilestone(pct);
}

let lastMilestone = 0;
function checkMilestone(pct) {
  for (const m of [25, 50, 75]) {
    if (pct >= m && lastMilestone < m) {
      lastMilestone = m;
      pop(`${m}% 🎯`, false);
      burst(40);
      haptic(20);
    }
  }
}

function addXp(gain, big) {
  xp += gain;
  pop(`+${gain} XP`, big);
  blip(big ? 880 : 740);
  haptic(big ? 18 : 8);

  const newLevel = Math.floor(xp / 100) + 1;
  if (newLevel > level) {
    level = newLevel;
    levelUp();
  }
  updateHud();
}

function levelUp() {
  pop(`LEVEL ${level}! 🆙`, true);
  bump(levelChip);
  burst(90);
  haptic([0, 40, 40, 40]);
  blip(1040);
}

function finish() {
  burst(140);
  haptic([0, 60, 40, 60, 40, 80]);
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  set("endXp", xp);
  set("endLevel", level);
  set("endStreak", bestStreak);
  updateHud();
}

function onCardClick(e) {
  const likeBtn = e.target.closest("button[data-like]");
  if (!likeBtn) return;
  const ico = likeBtn.querySelector(".ico");
  const count = likeBtn.querySelector("[data-count]");
  const on = likeBtn.classList.toggle("on");
  ico.textContent = on ? "❤️" : "🤍";
  count.textContent = String((parseInt(count.textContent, 10) || 0) + (on ? 1 : -1));
  likeBtn.classList.remove("pop");
  void likeBtn.offsetWidth; // restart the pop animation
  likeBtn.classList.add("pop");
  if (on) {
    likes += 1;
    addXp(5, false);
    haptic(10);
  }
}

function updateHud() {
  streakChip.textContent = `🔥 ${streak}`;
  levelChip.textContent = `Lv ${level}`;
}

function bump(el) {
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

// ---- Floating "+XP" / cheer pops ----
function pop(text, alt) {
  const el = document.createElement("div");
  el.className = "pop" + (alt ? " alt" : "");
  el.textContent = text;
  el.style.left = `${42 + Math.random() * 16}%`;
  el.style.top = `${48 + Math.random() * 8}%`;
  popsEl.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Canvas confetti ----
let confettiParticles = [];
let confettiRAF = 0;
const ctx = confettiCanvas.getContext("2d");
const COLORS = ["#0f766e", "#1e1c1a", "#c0573f", "#2f6f95", "#b3701c", "#2f7d52", "#8a4f8a"];

function sizeConfetti() {
  const dpr = window.devicePixelRatio || 1;
  confettiCanvas.width = confettiCanvas.clientWidth * dpr;
  confettiCanvas.height = confettiCanvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function burst(count) {
  if (reduceMotion) return;
  const w = confettiCanvas.clientWidth;
  for (let i = 0; i < count; i++) {
    confettiParticles.push({
      x: w / 2 + (Math.random() - 0.5) * w * 0.5,
      y: confettiCanvas.clientHeight * 0.35,
      vx: (Math.random() - 0.5) * 8,
      vy: -6 - Math.random() * 7,
      g: 0.28 + Math.random() * 0.12,
      size: 4 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: pick(COLORS),
      life: 90 + Math.random() * 40,
    });
  }
  if (!confettiRAF) confettiRAF = requestAnimationFrame(tickConfetti);
}

function tickConfetti() {
  ctx.clearRect(0, 0, confettiCanvas.clientWidth, confettiCanvas.clientHeight);
  confettiParticles = confettiParticles.filter((p) => p.life > 0);
  for (const p of confettiParticles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.g;
    p.rot += p.vr;
    p.life -= 1;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 30));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    ctx.restore();
  }
  if (confettiParticles.length) {
    confettiRAF = requestAnimationFrame(tickConfetti);
  } else {
    confettiRAF = 0;
    ctx.clearRect(0, 0, confettiCanvas.clientWidth, confettiCanvas.clientHeight);
  }
}

// ---- Haptics + sound (sound off by default; it's a courtesy) ----
function haptic(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
}

let soundOn = false;
let audioCtx = null;
function toggleSound() {
  soundOn = !soundOn;
  soundToggle.textContent = soundOn ? "🔊" : "🔇";
  soundToggle.setAttribute("aria-pressed", String(soundOn));
  if (soundOn && !audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (soundOn) blip(720);
}

function blip(freq) {
  if (!soundOn || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.08);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}

// ============================================================
//  Saved / shipped papers (document-tool plumbing)
// ============================================================
async function loadSelected() {
  const slug = myPapers.value;
  if (!slug) return;
  try {
    await openSaved(slug);
  } catch (err) {
    showStatus(err.message);
  }
}

async function openSaved(slug) {
  const saved = await getAsset(TOOL, slug);
  sourceInput.value = saved.source || "";
  titleInput.value = saved.title || slug;
  store.setSlug(slug);
  setAssetParam(null, "f");
  store.saveLocal();
  myPapers.value = slug;
  showStatus(`Loaded "${saved.title || slug}"`);
}

// ?f=<name> loads a shipped sample from /doomscroll/papers/<name>.txt
async function loadSampleFile(name) {
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "") || "dopamine";
  try {
    const res = await fetch(`/doomscroll/papers/${safe}.txt`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Sample "${safe}" not found`);
    const text = await res.text();
    const firstLine = text.split("\n").find((l) => l.trim());
    sourceInput.value = text;
    titleInput.value = (firstLine || safe).replace(/^#+\s*/, "").trim();
    store.setSlug(slugify(titleInput.value) || safe);
    store.saveLocal();
    showStatus(`Loaded sample "${titleInput.value}" — hit Start.`);
  } catch (err) {
    showStatus(err.message);
    setAssetParam(null, "f");
  }
}

function fillSwitcher(items) {
  const current = store.slug;
  myPapers.innerHTML =
    '<option value="">My papers…</option>' +
    items.map((it) => `<option value="${esc(it.slug)}">${esc(it.title || it.slug)}</option>`).join("");
  if (items.some((it) => it.slug === current)) myPapers.value = current;
}

function showStatus(message) {
  status.textContent = message;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
