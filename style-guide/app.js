// cache-bust: served with no-long-cache headers (see /_headers)
import { getAssetParam, loadTokenSet, setAssetParam } from "/_shared/util.js";
import { getAsset } from "/_shared/api.js";
import { createStore } from "/_shared/autosave.js";

const TOOL = "style-guide";
const STORAGE_KEY = "bantay-style-guide-state";

const fontStacks = {
  // Sans-serif
  Inter: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "Avenir Next": '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif',
  "SF Pro": '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
  "Source Sans": '"Source Sans 3", "Source Sans Pro", ui-sans-serif, system-ui, sans-serif',
  "IBM Plex Sans": '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "Public Sans": '"Public Sans", ui-sans-serif, system-ui, sans-serif',
  "Work Sans": '"Work Sans", ui-sans-serif, system-ui, sans-serif',
  // Serif
  Georgia: 'Georgia, "Times New Roman", serif',
  "Times New Roman": '"Times New Roman", Times, serif',
  "Source Serif 4": '"Source Serif 4", Georgia, "Times New Roman", serif',
  "IBM Plex Serif": '"IBM Plex Serif", Georgia, "Times New Roman", serif',
  Lora: 'Lora, Georgia, "Times New Roman", serif',
  Merriweather: 'Merriweather, Georgia, "Times New Roman", serif',
  "Playfair Display": '"Playfair Display", Georgia, "Times New Roman", serif',
  "PT Serif": '"PT Serif", Georgia, "Times New Roman", serif',
  Bitter: 'Bitter, Georgia, "Times New Roman", serif',
  Spectral: 'Spectral, Georgia, "Times New Roman", serif',
  // Display
  "Space Grotesk": '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  Sora: 'Sora, ui-sans-serif, system-ui, sans-serif',
  Syne: 'Syne, ui-sans-serif, system-ui, sans-serif',
  Oswald: 'Oswald, ui-sans-serif, system-ui, sans-serif',
  "Bebas Neue": '"Bebas Neue", ui-sans-serif, system-ui, sans-serif',
  Anton: 'Anton, ui-sans-serif, system-ui, sans-serif',
  "Abril Fatface": '"Abril Fatface", Georgia, "Times New Roman", serif',
  "DM Serif Display": '"DM Serif Display", Georgia, "Times New Roman", serif',
  // Monospace
  "JetBrains Mono": '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "IBM Plex Mono": '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "Space Mono": '"Space Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "Source Code Pro": '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "Fira Code": '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "Roboto Mono": '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  Inconsolata: 'Inconsolata, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "DM Mono": '"DM Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "System Mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
};

// Font categories (for grouping the font pickers).
const serifFonts = new Set([
  "Georgia", "Times New Roman", "Source Serif 4", "IBM Plex Serif",
  "Lora", "Merriweather", "Playfair Display", "PT Serif", "Bitter", "Spectral"
]);
const displayFonts = new Set([
  "Space Grotesk", "Sora", "Syne", "Oswald", "Bebas Neue", "Anton",
  "Abril Fatface", "DM Serif Display"
]);
const monoFonts = new Set([
  "JetBrains Mono", "IBM Plex Mono", "Space Mono", "Source Code Pro",
  "Fira Code", "Roboto Mono", "Inconsolata", "DM Mono", "System Mono"
]);

// Google Fonts family specs (name -> css2 `family=` value). Fonts NOT listed
// here are system fonts (Avenir Next, SF Pro, Georgia, Times New Roman, System
// Mono) and need no web load. Used to auto-build the @import for published CSS.
const googleFontSpecs = {
  Inter: "Inter:wght@400..900",
  "Source Sans": "Source+Sans+3:wght@400..900",
  "IBM Plex Sans": "IBM+Plex+Sans:wght@400;500;600;700",
  "Public Sans": "Public+Sans:wght@400..900",
  "Work Sans": "Work+Sans:wght@400..900",
  "Source Serif 4": "Source+Serif+4:wght@400..900",
  "IBM Plex Serif": "IBM+Plex+Serif:wght@400;500;600;700",
  Lora: "Lora:wght@400..700",
  Merriweather: "Merriweather:wght@400;700;900",
  "Playfair Display": "Playfair+Display:wght@400..900",
  "PT Serif": "PT+Serif:wght@400;700",
  Bitter: "Bitter:wght@400..900",
  Spectral: "Spectral:wght@400;500;600;700;800",
  "Space Grotesk": "Space+Grotesk:wght@400..700",
  Sora: "Sora:wght@400..800",
  Syne: "Syne:wght@400..800",
  Oswald: "Oswald:wght@400..700",
  "Bebas Neue": "Bebas+Neue",
  Anton: "Anton",
  "Abril Fatface": "Abril+Fatface",
  "DM Serif Display": "DM+Serif+Display",
  "JetBrains Mono": "JetBrains+Mono:wght@400..700",
  "IBM Plex Mono": "IBM+Plex+Mono:wght@400;500;600;700",
  "Space Mono": "Space+Mono:wght@400;700",
  "Source Code Pro": "Source+Code+Pro:wght@400..700",
  "Fira Code": "Fira+Code:wght@400..700",
  "Roboto Mono": "Roboto+Mono:wght@400..700",
  Inconsolata: "Inconsolata:wght@400..700",
  "DM Mono": "DM+Mono:wght@400;500"
};

const defaults = {
  brandName: "Bantay",
  skillName: "bantay-brand",
  voice: "Calm, direct, protective",
  displayFont: "Inter",
  bodyFont: "Inter",
  baseSize: 16,
  lineHeight: 1.55,
  headlineWeight: 750,
  headlineScale: 1.26,
  ink: "#142026",
  muted: "#61717d",
  background: "#f5f7f8",
  surface: "#ffffff",
  primary: "#0f766e",
  accent: "#d97706",
  radius: 8,
  spacing: 10,
  buttonStyle: "solid",
  success: "#0f766e",
  emphasis: "#c0573f",
  cat1: "#2f6f95",
  cat2: "#b3701c",
  cat3: "#2f7d52",
  cat4: "#8a4f8a",
  customDark: false,
  darkBackground: "#11131a",
  darkSurface: "#1a1e27",
  darkInk: "#e8e6dd",
  darkMuted: "#9aa298",
  darkPrimary: "#34b3a2",
  darkAccent: "#d8a07a",
  darkSuccess: "#5fa37a",
  darkEmphasis: "#e08a76",
  darkCat1: "#6fb1d6",
  darkCat2: "#e0a35f",
  darkCat3: "#8ccf97",
  darkCat4: "#c98ec9"
};

// The 12 authored dark-palette fields (a guide's "Override" set).
const DARK_KEYS = [
  "darkBackground", "darkSurface", "darkInk", "darkMuted", "darkPrimary", "darkAccent",
  "darkSuccess", "darkEmphasis", "darkCat1", "darkCat2", "darkCat3", "darkCat4"
];

const controls = {};
const controlIds = [
  "brandName",
  "skillName",
  "voice",
  "displayFont",
  "bodyFont",
  "baseSize",
  "lineHeight",
  "headlineWeight",
  "headlineScale",
  "ink",
  "muted",
  "background",
  "surface",
  "primary",
  "accent",
  "radius",
  "spacing",
  "buttonStyle",
  "success",
  "emphasis",
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "darkBackground",
  "darkSurface",
  "darkInk",
  "darkMuted",
  "darkPrimary",
  "darkAccent",
  "darkSuccess",
  "darkEmphasis",
  "darkCat1",
  "darkCat2",
  "darkCat3",
  "darkCat4"
];

const status = document.querySelector("#status");
const brandPreview = document.querySelector("#brandPreview");
const skillOutput = document.querySelector("#skillOutput");
const tokensOutput = document.querySelector("#tokensOutput");
const cssOutput = document.querySelector("#cssOutput");
const sharedCssOutput = document.querySelector("#sharedCssOutput");
const extendedCssOutput = document.querySelector("#extendedCssOutput");
const bantayJsonOutput = document.querySelector("#bantayJsonOutput");
const customDark = document.querySelector("#customDark");
const darkFields = document.querySelector("#darkFields");
const darkCssOutput = document.querySelector("#darkCssOutput");
const darkPublishFile = document.querySelector("#darkPublishFile");
const copyDarkCss = document.querySelector("#copyDarkCss");
const downloadDarkCss = document.querySelector("#downloadDarkCss");
const copyExtendedCss = document.querySelector("#copyExtendedCss");
const downloadExtendedCss = document.querySelector("#downloadExtendedCss");
const copySharedCss = document.querySelector("#copySharedCss");
const downloadSharedCss = document.querySelector("#downloadSharedCss");
const copyBantayJson = document.querySelector("#copyBantayJson");
const downloadBantayJson = document.querySelector("#downloadBantayJson");
const resetGuide = document.querySelector("#resetGuide");
const resetModal = document.querySelector("#resetModal");
const resetTargetEl = document.querySelector("#resetTarget");
const resetConfirm = document.querySelector("#resetConfirm");
const resetConfirmBtn = document.querySelector("#resetConfirmBtn");
const resetCancel = document.querySelector("#resetCancel");
const guideName = document.querySelector("#guideName");
const myGuides = document.querySelector("#myGuides");
const importGuide = document.querySelector("#importGuide");
const importModal = document.querySelector("#importModal");
const importText = document.querySelector("#importText");
const importError = document.querySelector("#importError");
const importConfirmBtn = document.querySelector("#importConfirmBtn");
const importCancel = document.querySelector("#importCancel");
const copyCurrent = document.querySelector("#copyCurrent");
const downloadCurrent = document.querySelector("#downloadCurrent");
const headlineWeightValue = document.querySelector("#headlineWeightValue");
const headlineScaleValue = document.querySelector("#headlineScaleValue");
const schemeToggle = document.querySelector("#schemeToggle");
const schemeLight = document.querySelector("#schemeLight");
const schemeDark = document.querySelector("#schemeDark");

const tabs = {
  preview: {
    button: document.querySelector("#tabPreview"),
    panel: document.querySelector("#previewPanel")
  },
  skill: {
    button: document.querySelector("#tabSkill"),
    panel: document.querySelector("#skillPanel"),
    output: skillOutput,
    filename: "SKILL.md",
    type: "text/markdown"
  },
  tokens: {
    button: document.querySelector("#tabTokens"),
    panel: document.querySelector("#tokensPanel"),
    output: tokensOutput,
    filename: "brand-tokens.json",
    type: "application/json"
  },
  css: {
    button: document.querySelector("#tabCss"),
    panel: document.querySelector("#cssPanel"),
    output: cssOutput,
    filename: "brand.css",
    type: "text/css"
  },
  publish: {
    button: document.querySelector("#tabPublish"),
    panel: document.querySelector("#publishPanel")
  }
};

let activeTab = "preview";

const store = createStore({
  tool: TOOL,
  draftKey: STORAGE_KEY,
  getTitle: () => guideName.value,
  getPayload: () => getState(),
  onStatus: showStatus,
  onSaved: () => store.init().then(fillSwitcher),
});

setupFontOptions();
bindControls();

const appEl = document.querySelector(".app");
const params = new URLSearchParams(location.search);
// A targeted load (?f=preset or ?id=saved) resolves async — hide the preview
// until it paints so it doesn't flash the default/previous brand first.
const targeted = params.has("f") || params.has("id");
if (targeted) appEl.classList.add("loading");
if (!params.has("new") && store.loadLocal()) {
  const draft = store.loadLocal();
  applyState({ ...defaults, ...draft });
  guideName.value = draft.title || "";
  if (draft.slug) store.setSlug(draft.slug);
} else {
  applyState(defaults);
  guideName.value = "";
}
render();
boot();

async function boot() {
  fillSwitcher(await store.init());
  // Precedence: ?id=<slug> (a saved guide) > ?f=<name> (a shipped set).
  const id = params.get("id");
  try {
    if (id) await openSaved(slugify(id));
    else await loadFromAssetParam();
  } catch (error) {
    showStatus(error.message);
  } finally {
    appEl.classList.remove("loading"); // reveal the preview (loaded or fell back)
  }
}

// Load one of the user's saved guides (from KV) and make it the autosave target.
async function openSaved(slug) {
  const set = await getAsset(TOOL, slug);
  applyState({ ...defaults, ...set });
  guideName.value = set.title || slug;
  store.setSlug(slug);
  store.saveLocal();
  render();
  setAssetParam(null, "f");
  myGuides.value = slug;
  showStatus(`Loaded "${set.title || slug}"`);
}

// If the URL carries ?f=<name>, load that shipped set from /_shared/tokens/.
async function loadFromAssetParam() {
  const name = getAssetParam("f");
  if (!name) return;
  try {
    const set = await loadTokenSet(name);
    applyState({ ...defaults, ...set });
    guideName.value = name;
    store.setSlug(slugify(name));
    store.saveLocal();
    render();
    showStatus(`Loaded "${name}"`);
  } catch (error) {
    showStatus(error.message);
    setAssetParam(null, "f");
  }
}

Object.entries(tabs).forEach(([name, tab]) => {
  tab.button.addEventListener("click", () => setActiveTab(name));
});

// Preview light/dark toggle. A view preference (local only), and only the
// preview pane is affected — the editor chrome follows the dashboard theme.
const PREVIEW_SCHEME_KEY = "bantay-style-preview-scheme";
let previewScheme = readPreviewScheme();
applyScheme(previewScheme);
schemeLight.addEventListener("click", () => setScheme("light"));
schemeDark.addEventListener("click", () => setScheme("dark"));

// Toggling the per-guide dark override. The currently-shown (derived) values
// become the editable starting point; jump the preview to dark so it's visible.
customDark.addEventListener("change", () => {
  render();
  store.change();
  if (customDark.checked) setScheme("dark");
});

function readPreviewScheme() {
  try {
    return localStorage.getItem(PREVIEW_SCHEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function setScheme(scheme) {
  previewScheme = scheme === "dark" ? "dark" : "light";
  try {
    localStorage.setItem(PREVIEW_SCHEME_KEY, previewScheme);
  } catch {
    /* storage disabled — ignore */
  }
  applyScheme(previewScheme);
}

function applyScheme(scheme) {
  brandPreview.dataset.scheme = scheme;
  const dark = scheme === "dark";
  schemeDark.classList.toggle("active", dark);
  schemeLight.classList.toggle("active", !dark);
  schemeDark.setAttribute("aria-pressed", String(dark));
  schemeLight.setAttribute("aria-pressed", String(!dark));
}

copyCurrent.addEventListener("click", () => {
  const current = currentExport();
  if (!current) {
    showStatus("Switch to Skill, Tokens, or CSS to copy");
    return;
  }
  copyText(current.output.textContent, `${current.label} copied`);
});

downloadCurrent.addEventListener("click", () => {
  const current = currentExport();
  if (!current) {
    showStatus("Switch to Skill, Tokens, or CSS to download");
    return;
  }
  downloadText(current.filename, current.output.textContent, current.type);
});

// Publish tab — each shared file copies/downloads on its own.
copySharedCss.addEventListener("click", () => copyText(sharedCssOutput.textContent, "tokens.css copied"));
downloadSharedCss.addEventListener("click", () => downloadText("tokens.css", sharedCssOutput.textContent, "text/css"));
copyExtendedCss.addEventListener("click", () => copyText(extendedCssOutput.textContent, "tokens-extended.css copied"));
downloadExtendedCss.addEventListener("click", () => downloadText("tokens-extended.css", extendedCssOutput.textContent, "text/css"));
copyDarkCss.addEventListener("click", () => copyText(darkCssOutput.textContent, "dark.css copied"));
downloadDarkCss.addEventListener("click", () => downloadText("dark.css", darkCssOutput.textContent, "text/css"));
copyBantayJson.addEventListener("click", () => copyText(bantayJsonOutput.textContent, "bantay.json copied"));
downloadBantayJson.addEventListener("click", () => downloadText("bantay.json", bantayJsonOutput.textContent, "application/json"));

// Reset is destructive (autosave overwrites the current guide), so require the
// user to type the file name to confirm.
resetGuide.addEventListener("click", openResetModal);
resetCancel.addEventListener("click", closeResetModal);
resetModal.addEventListener("click", (event) => {
  if (event.target === resetModal) closeResetModal();
});
resetConfirm.addEventListener("input", () => {
  resetConfirmBtn.disabled = resetConfirm.value.trim() !== resetTarget();
});
resetConfirmBtn.addEventListener("click", () => {
  applyState(defaults);
  render();
  store.change();
  closeResetModal();
  showStatus("Reset to defaults");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!resetModal.hidden) closeResetModal();
  if (!importModal.hidden) closeImportModal();
});

// Import — paste a token JSON to overwrite the current guide's values. Autosave
// then persists them under the current guide (a fresh guide gets named from the
// imported brand, so it lands as a new file in your account).
importGuide.addEventListener("click", openImportModal);
importCancel.addEventListener("click", closeImportModal);
importModal.addEventListener("click", (event) => {
  if (event.target === importModal) closeImportModal();
});
importConfirmBtn.addEventListener("click", doImport);

function openImportModal() {
  importText.value = "";
  importError.hidden = true;
  importModal.hidden = false;
  importText.focus();
}

function closeImportModal() {
  importModal.hidden = true;
}

function doImport() {
  let parsed;
  try {
    parsed = JSON.parse(importText.value);
  } catch {
    importError.textContent = "That isn't valid JSON.";
    importError.hidden = false;
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    importError.textContent = "Expected a JSON object of token values.";
    importError.hidden = false;
    return;
  }

  applyState({ ...defaults, ...parsed });
  render();

  // A fresh, unnamed guide: name it from the imported brand so it saves as a new
  // file. An already-named guide: just overwrite its values in place.
  if (!guideName.value.trim() && parsed.brandName) {
    guideName.value = parsed.brandName;
    store.rename();
  } else {
    store.change();
  }
  closeImportModal();
  showStatus("Imported");
}

function resetTarget() {
  return guideName.value.trim() || "untitled";
}

function openResetModal() {
  resetTargetEl.textContent = resetTarget();
  resetConfirm.value = "";
  resetConfirmBtn.disabled = true;
  resetModal.hidden = false;
  resetConfirm.focus();
}

function closeResetModal() {
  resetModal.hidden = true;
}

myGuides.addEventListener("change", async () => {
  const slug = myGuides.value;
  if (!slug) return;
  try {
    await openSaved(slug);
  } catch (error) {
    showStatus(error.message);
  }
});

// The guide name is the document title — typing autosaves, committing renames.
guideName.addEventListener("input", () => store.change());
guideName.addEventListener("change", () => store.rename());

// Populate the "open a saved guide" switcher. Empty when signed out.
function fillSwitcher(items) {
  const current = store.slug;
  myGuides.innerHTML =
    '<option value="">My guides…</option>' +
    items
      .map(
        (it) =>
          `<option value="${escapeHtml(it.slug)}">${escapeHtml(it.title || it.slug)}</option>`
      )
      .join("");
  if (items.some((it) => it.slug === current)) myGuides.value = current;
}

function setupFontOptions() {
  const opt = (font) => `<option value="${escapeHtml(font)}">${escapeHtml(font)}</option>`;
  const inGroup = (set) => Object.keys(fontStacks).filter((f) => set.has(f)).map(opt).join("");
  const sans = Object.keys(fontStacks)
    .filter((f) => !serifFonts.has(f) && !displayFonts.has(f) && !monoFonts.has(f))
    .map(opt)
    .join("");
  const html =
    `<optgroup label="Sans-serif">${sans}</optgroup>` +
    `<optgroup label="Serif">${inGroup(serifFonts)}</optgroup>` +
    `<optgroup label="Display">${inGroup(displayFonts)}</optgroup>` +
    `<optgroup label="Monospace">${inGroup(monoFonts)}</optgroup>`;

  document.querySelector("#displayFont").innerHTML = html;
  document.querySelector("#bodyFont").innerHTML = html;
}

function bindControls() {
  controlIds.forEach((id) => {
    controls[id] = document.querySelector(`#${id}`);
    controls[id].addEventListener("input", () => {
      if (id === "brandName") {
        controls.skillName.value = slugify(controls.brandName.value || defaults.brandName);
      }
      render();
      store.change();
    });
  });
}

function applyState(state) {
  controlIds.forEach((id) => {
    controls[id].value = state[id] ?? defaults[id];
  });
  customDark.checked = state.customDark ?? defaults.customDark;
}

function getState() {
  return {
    brandName: controls.brandName.value.trim() || defaults.brandName,
    skillName: slugify(controls.skillName.value || controls.brandName.value || defaults.skillName),
    voice: controls.voice.value,
    displayFont: controls.displayFont.value,
    bodyFont: controls.bodyFont.value,
    baseSize: Number(controls.baseSize.value),
    lineHeight: Number(controls.lineHeight.value),
    headlineWeight: Number(controls.headlineWeight.value),
    headlineScale: Number(controls.headlineScale.value),
    ink: controls.ink.value,
    muted: controls.muted.value,
    background: controls.background.value,
    surface: controls.surface.value,
    primary: controls.primary.value,
    accent: controls.accent.value,
    radius: Number(controls.radius.value),
    spacing: Number(controls.spacing.value),
    buttonStyle: controls.buttonStyle.value,
    success: controls.success.value,
    emphasis: controls.emphasis.value,
    cat1: controls.cat1.value,
    cat2: controls.cat2.value,
    cat3: controls.cat3.value,
    cat4: controls.cat4.value,
    customDark: customDark.checked,
    darkBackground: controls.darkBackground.value,
    darkSurface: controls.darkSurface.value,
    darkInk: controls.darkInk.value,
    darkMuted: controls.darkMuted.value,
    darkPrimary: controls.darkPrimary.value,
    darkAccent: controls.darkAccent.value,
    darkSuccess: controls.darkSuccess.value,
    darkEmphasis: controls.darkEmphasis.value,
    darkCat1: controls.darkCat1.value,
    darkCat2: controls.darkCat2.value,
    darkCat3: controls.darkCat3.value,
    darkCat4: controls.darkCat4.value
  };
}

function render() {
  const state = getState();
  controls.skillName.value = state.skillName;
  headlineWeightValue.textContent = String(state.headlineWeight);
  headlineScaleValue.textContent = state.headlineScale.toFixed(2);

  document.documentElement.style.setProperty("--src-ink", state.ink);
  document.documentElement.style.setProperty("--src-muted", state.muted);
  document.documentElement.style.setProperty("--src-bg", state.background);
  document.documentElement.style.setProperty("--src-surface", state.surface);
  document.documentElement.style.setProperty("--src-primary", state.primary);
  document.documentElement.style.setProperty("--src-accent", state.accent);
  document.documentElement.style.setProperty("--src-success", state.success);
  document.documentElement.style.setProperty("--src-emphasis", state.emphasis);
  document.documentElement.style.setProperty("--src-cat-1", state.cat1);
  document.documentElement.style.setProperty("--src-cat-2", state.cat2);
  document.documentElement.style.setProperty("--src-cat-3", state.cat3);
  document.documentElement.style.setProperty("--src-cat-4", state.cat4);
  document.documentElement.style.setProperty("--brand-radius", `${state.radius}px`);
  document.documentElement.style.setProperty("--brand-spacing", `${state.spacing}px`);
  document.documentElement.style.setProperty("--brand-body", fontStacks[state.bodyFont]);
  document.documentElement.style.setProperty("--brand-display", fontStacks[state.displayFont]);
  document.documentElement.style.setProperty("--brand-base-size", `${state.baseSize}px`);
  document.documentElement.style.setProperty("--brand-line-height", state.lineHeight);
  document.documentElement.style.setProperty("--brand-headline-weight", state.headlineWeight);
  document.documentElement.style.setProperty("--brand-headline-scale", state.headlineScale);
  brandPreview.dataset.buttonStyle = state.buttonStyle;

  // Dark palette: authored when overriding, else derived from the light palette.
  const dark = darkPalette(state);
  if (!state.customDark) {
    // Mirror the derived values into the (disabled) inputs as a live seed.
    DARK_KEYS.forEach((k) => { controls[k].value = dark[k]; });
  }
  darkFields.classList.toggle("disabled", !state.customDark);
  DARK_KEYS.forEach((k) => { controls[k].disabled = !state.customDark; });
  document.documentElement.style.setProperty("--srcd-bg", dark.darkBackground);
  document.documentElement.style.setProperty("--srcd-surface", dark.darkSurface);
  document.documentElement.style.setProperty("--srcd-ink", dark.darkInk);
  document.documentElement.style.setProperty("--srcd-muted", dark.darkMuted);
  document.documentElement.style.setProperty("--srcd-primary", dark.darkPrimary);
  document.documentElement.style.setProperty("--srcd-accent", dark.darkAccent);
  document.documentElement.style.setProperty("--srcd-success", dark.darkSuccess);
  document.documentElement.style.setProperty("--srcd-emphasis", dark.darkEmphasis);
  document.documentElement.style.setProperty("--srcd-cat-1", dark.darkCat1);
  document.documentElement.style.setProperty("--srcd-cat-2", dark.darkCat2);
  document.documentElement.style.setProperty("--srcd-cat-3", dark.darkCat3);
  document.documentElement.style.setProperty("--srcd-cat-4", dark.darkCat4);
  brandPreview.dataset.dark = state.customDark ? "custom" : "derived";

  brandPreview.querySelector(".bp-wordmark").textContent = state.brandName;
  skillOutput.textContent = buildSkill(state);
  tokensOutput.textContent = JSON.stringify(buildTokens(state), null, 2);
  cssOutput.textContent = buildCss(state);
  sharedCssOutput.textContent = buildSharedCss(state);
  extendedCssOutput.textContent = buildExtendedCss(state);
  darkCssOutput.textContent = buildDarkCss(state);
  darkPublishFile.hidden = !state.customDark;
  bantayJsonOutput.textContent = JSON.stringify(state, null, 2);
}

function setActiveTab(name) {
  activeTab = name;

  Object.entries(tabs).forEach(([tabName, tab]) => {
    const isActive = tabName === name;
    tab.button.classList.toggle("active", isActive);
    tab.button.setAttribute("aria-selected", String(isActive));
    tab.panel.classList.toggle("visible", isActive);
  });

  // The light/dark toggle only applies to the rendered preview.
  schemeToggle.hidden = name !== "preview";
}

function currentExport() {
  if (activeTab === "preview" || activeTab === "publish") return null;
  return {
    ...tabs[activeTab],
    label: tabs[activeTab].button.textContent
  };
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  showStatus(message);
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  showStatus(`${filename} downloaded`);
}

function buildTokens(state) {
  return {
    brand: {
      name: state.brandName,
      skillName: state.skillName,
      voice: state.voice
    },
    typography: {
      displayFont: state.displayFont,
      displayStack: fontStacks[state.displayFont],
      bodyFont: state.bodyFont,
      bodyStack: fontStacks[state.bodyFont],
      baseSize: `${state.baseSize}px`,
      lineHeight: state.lineHeight,
      headlineWeight: state.headlineWeight,
      headlineScale: state.headlineScale
    },
    color: {
      ink: state.ink,
      muted: state.muted,
      background: state.background,
      surface: state.surface,
      primary: state.primary,
      accent: state.accent
    },
    interface: {
      radius: `${state.radius}px`,
      spacing: `${state.spacing}px`,
      buttonStyle: state.buttonStyle
    }
  };
}

function buildSkill(state) {
  const tokens = buildTokens(state);
  const description = `Use when creating or editing tools, apps, websites, documents, or UI copy for the ${state.brandName} brand. Apply the brand typography, colors, interface defaults, tone, and product design rules consistently.`;

  return `---
name: ${state.skillName}
description: ${description}
metadata:
  short-description: ${state.brandName} brand style guide
---

# ${state.brandName} Brand Style Guide

Use this skill whenever work should look, sound, or behave like a ${state.brandName} product.

## Voice

- Overall tone: ${state.voice}.
- Write directly and concretely. Prefer useful product language over slogans.
- Keep interface copy short enough to scan inside dense tools.
- Describe user outcomes and actions before describing implementation details.

## Typography

- Display font: ${state.displayFont}.
- Display stack: \`${tokens.typography.displayStack}\`.
- Body font: ${state.bodyFont}.
- Body stack: \`${tokens.typography.bodyStack}\`.
- Base body size: ${tokens.typography.baseSize}.
- Body line height: ${state.lineHeight}.
- Headline weight: ${state.headlineWeight}.
- Headline scale: ${state.headlineScale}.
- Use headline-scale type only for true page or section leads. Keep cards, sidebars, and controls compact.

## Color

- Ink: ${state.ink}.
- Muted text: ${state.muted}.
- Background: ${state.background}.
- Surface: ${state.surface}.
- Primary: ${state.primary}.
- Accent: ${state.accent}.
- Primary color should mark commitment, selection, and main actions. Accent color should support notices, highlights, and secondary emphasis.

## Interface

- Border radius: ${tokens.interface.radius}.
- Spacing unit: ${tokens.interface.spacing}.
- Button style: ${state.buttonStyle}.
- Prefer practical, information-dense layouts for tools. Avoid decorative cards, oversized marketing composition, and gradients unless the specific artifact requires them.
- Make controls predictable: buttons for commands, selects for option sets, toggles for binary settings, sliders or inputs for numeric settings, and tabs for alternate views.
- Text must fit within controls and cards on mobile and desktop.

## CSS Tokens

\`\`\`css
${buildCss(state)}
\`\`\`

## JSON Tokens

\`\`\`json
${JSON.stringify(tokens, null, 2)}
\`\`\`

## Installation Note

Create a folder named \`${state.skillName}\` under your Codex skills directory, place this file at \`${state.skillName}/SKILL.md\`, then reference the skill by name when asking Codex to build ${state.brandName} tools.`;
}

function buildCss(state) {
  return `:root {
  --${state.skillName}-ink: ${state.ink};
  --${state.skillName}-muted: ${state.muted};
  --${state.skillName}-background: ${state.background};
  --${state.skillName}-surface: ${state.surface};
  --${state.skillName}-primary: ${state.primary};
  --${state.skillName}-accent: ${state.accent};
  --${state.skillName}-radius: ${state.radius}px;
  --${state.skillName}-spacing: ${state.spacing}px;
  --${state.skillName}-body-font: ${fontStacks[state.bodyFont]};
  --${state.skillName}-display-font: ${fontStacks[state.displayFont]};
  --${state.skillName}-base-size: ${state.baseSize}px;
  --${state.skillName}-line-height: ${state.lineHeight};
  --${state.skillName}-headline-weight: ${state.headlineWeight};
  --${state.skillName}-headline-scale: ${state.headlineScale};
}`;
}

// Build the @import that loads the brand fonts (display + body) from Google
// Fonts. System fonts are skipped (they need no load). Empty if both are system.
function buildFontImport(state) {
  const specs = [...new Set([state.displayFont, state.bodyFont])]
    .map((font) => googleFontSpecs[font])
    .filter(Boolean)
    .sort();
  if (!specs.length) return "";
  const url = `https://fonts.googleapis.com/css2?family=${specs.join("&family=")}&display=swap`;
  return `@import url("${url}");\n\n`;
}

// The shared design system: fixed --bantay-* names that every tool links via
// _shared/tokens.css. Includes the @import so the brand font loads everywhere.
function buildSharedCss(state) {
  return `/* Bantay design system — paste into _shared/tokens.css. */
${buildFontImport(state)}:root {
  --bantay-ink: ${state.ink};
  --bantay-muted: ${state.muted};
  --bantay-background: ${state.background};
  --bantay-surface: ${state.surface};
  --bantay-primary: ${state.primary};
  --bantay-accent: ${state.accent};

  --bantay-radius: ${state.radius}px;
  --bantay-spacing: ${state.spacing}px;

  --bantay-body-font: ${fontStacks[state.bodyFont]};
  --bantay-display-font: ${fontStacks[state.displayFont]};
  --bantay-base-size: ${state.baseSize}px;
  --bantay-line-height: ${state.lineHeight};
  --bantay-headline-weight: ${state.headlineWeight};
  --bantay-headline-scale: ${state.headlineScale};
}`;
}

// Extended tokens — paste into _shared/tokens-extended.css. The neutrals/mono
// are static (the neutrals derive from the brand); the colors are editable here.
function buildExtendedCss(state) {
  return `/* Bantay extended tokens — paste into _shared/tokens-extended.css. */
:root {
  /* Neutrals — derived from the brand */
  --bantay-line:        color-mix(in srgb, var(--bantay-muted) 20%, transparent);
  --bantay-line-strong: color-mix(in srgb, var(--bantay-muted) 42%, transparent);
  --bantay-ink-faint:   color-mix(in srgb, var(--bantay-muted) 60%, var(--bantay-background));
  --bantay-surface-2:   color-mix(in srgb, var(--bantay-muted) 8%, var(--bantay-surface));

  /* Type — platform monospace (no web load) */
  --bantay-mono-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;

  /* Status / emphasis */
  --bantay-success: ${state.success};
  --bantay-emphasis: ${state.emphasis};

  /* Categorical palette */
  --bantay-cat-1: ${state.cat1};
  --bantay-cat-2: ${state.cat2};
  --bantay-cat-3: ${state.cat3};
  --bantay-cat-4: ${state.cat4};
}`;
}

// --- Dark palette: derivation + the guide's authored override ----------------

function hexToRgb(hex) {
  let h = String(hex).replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

// color-mix(in srgb, a (aWeight*100)%, b) — channelwise blend in sRGB.
function mix(aHex, bHex, aWeight) {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  return rgbToHex([0, 1, 2].map((i) => aWeight * a[i] + (1 - aWeight) * b[i]));
}

// Derive a dark palette from the light one (matches the CSS color-mix fallback
// in styles.css for the base six; extended colors are lifted toward white).
function deriveDark(s) {
  return {
    darkBackground: mix(s.ink, "#0c0c0d", 0.84),
    darkSurface: mix(s.ink, "#18181b", 0.7),
    darkInk: mix(s.background, "#ffffff", 0.9),
    darkMuted: mix(s.background, s.ink, 0.52),
    darkPrimary: mix(s.primary, "#ffffff", 0.75),
    darkAccent: mix(s.accent, "#ffffff", 0.78),
    darkSuccess: mix(s.success, "#ffffff", 0.72),
    darkEmphasis: mix(s.emphasis, "#ffffff", 0.74),
    darkCat1: mix(s.cat1, "#ffffff", 0.7),
    darkCat2: mix(s.cat2, "#ffffff", 0.7),
    darkCat3: mix(s.cat3, "#ffffff", 0.7),
    darkCat4: mix(s.cat4, "#ffffff", 0.7)
  };
}

// The dark palette this guide should use: authored values when overriding,
// otherwise the derived ones.
function darkPalette(state) {
  if (!state.customDark) return deriveDark(state);
  const out = {};
  DARK_KEYS.forEach((k) => { out[k] = state[k] ?? defaults[k]; });
  return out;
}

// dark.css — the shipped structure (single --_dark-* source + the two triggers).
function buildDarkCss(state) {
  const d = darkPalette(state);
  const rows = [
    ["background", d.darkBackground], ["surface", d.darkSurface], ["ink", d.darkInk],
    ["muted", d.darkMuted], ["primary", d.darkPrimary], ["accent", d.darkAccent],
    ["success", d.darkSuccess], ["emphasis", d.darkEmphasis],
    ["cat-1", d.darkCat1], ["cat-2", d.darkCat2], ["cat-3", d.darkCat3], ["cat-4", d.darkCat4]
  ];
  const sources = rows.map(([t, v]) => `  --_dark-${t}: ${v};`).join("\n");
  const remap = (pad) => rows.map(([t]) => `${pad}--bantay-${t}: var(--_dark-${t});`).join("\n");
  return `/* Bantay design system — DARK theme. Paste into _shared/dark.css. */
:root {
${sources}
}

:root[data-theme="dark"] {
  color-scheme: dark;
${remap("  ")}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {
    color-scheme: dark;
${remap("    ")}
  }
}`;
}

function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

  return slug || defaults.skillName;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showStatus(message) {
  status.textContent = message;
}
