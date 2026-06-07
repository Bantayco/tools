import { getAssetParam, loadTokenSet, setAssetParam } from "/_shared/util.js";
import { getAsset } from "/_shared/api.js";
import { createStore } from "/_shared/autosave.js";

const TOOL = "style-guide";
const STORAGE_KEY = "bantay-style-guide-state";

const fontStacks = {
  Inter: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "Avenir Next": '"Avenir Next", Avenir, ui-sans-serif, system-ui, sans-serif',
  "SF Pro": '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
  "Source Sans": '"Source Sans 3", "Source Sans Pro", ui-sans-serif, system-ui, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  "IBM Plex Sans": '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "Public Sans": '"Public Sans", ui-sans-serif, system-ui, sans-serif',
  "Work Sans": '"Work Sans", ui-sans-serif, system-ui, sans-serif'
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
  buttonStyle: "solid"
};

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
  "buttonStyle"
];

const status = document.querySelector("#status");
const brandPreview = document.querySelector("#brandPreview");
const skillOutput = document.querySelector("#skillOutput");
const tokensOutput = document.querySelector("#tokensOutput");
const cssOutput = document.querySelector("#cssOutput");
const copySkill = document.querySelector("#copySkill");
const downloadSkill = document.querySelector("#downloadSkill");
const resetGuide = document.querySelector("#resetGuide");
const myGuides = document.querySelector("#myGuides");
const copyCurrent = document.querySelector("#copyCurrent");
const downloadCurrent = document.querySelector("#downloadCurrent");
const headlineWeightValue = document.querySelector("#headlineWeightValue");
const headlineScaleValue = document.querySelector("#headlineScaleValue");

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
  }
};

let activeTab = "preview";

const store = createStore({
  tool: TOOL,
  draftKey: STORAGE_KEY,
  getTitle: () => controls.brandName.value,
  getPayload: () => getState(),
  onStatus: showStatus,
  onSaved: () => store.init().then(fillSwitcher),
});

setupFontOptions();
bindControls();

const params = new URLSearchParams(location.search);
if (!params.has("new") && store.loadLocal()) {
  const draft = store.loadLocal();
  applyState({ ...defaults, ...draft });
  store.setSlug(draft.slug || slugify(controls.brandName.value));
} else {
  applyState(defaults);
  store.setSlug(slugify(controls.brandName.value));
}
render();
boot();

async function boot() {
  fillSwitcher(await store.init());
  // Precedence: ?id=<slug> (a saved guide) > ?f=<name> (a shipped preset).
  const id = params.get("id");
  if (id) {
    try {
      await openSaved(slugify(id));
    } catch (error) {
      showStatus(error.message);
    }
  } else {
    await loadFromAssetParam();
  }
}

// Load one of the user's saved guides (from KV) and make it the autosave target.
async function openSaved(slug) {
  const set = await getAsset(TOOL, slug);
  applyState({ ...defaults, ...set });
  store.setSlug(slug);
  store.saveLocal();
  render();
  setAssetParam(null, "f");
  myGuides.value = slug;
  showStatus(`Loaded "${set.title || set.brandName || slug}"`);
}

// If the URL carries ?f=<name>, load that saved set from /_shared/tokens/.
async function loadFromAssetParam() {
  const name = getAssetParam("f");
  if (!name) return;
  try {
    const set = await loadTokenSet(name);
    applyState({ ...defaults, ...set });
    store.setSlug(slugify(controls.brandName.value));
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

copySkill.addEventListener("click", () => copyText(skillOutput.textContent, "Skill copied"));
downloadSkill.addEventListener("click", () => downloadText("SKILL.md", skillOutput.textContent, "text/markdown"));

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

resetGuide.addEventListener("click", () => {
  applyState(defaults);
  render();
  store.change();
  showStatus("Defaults restored");
});

myGuides.addEventListener("change", async () => {
  const slug = myGuides.value;
  if (!slug) return;
  try {
    await openSaved(slug);
  } catch (error) {
    showStatus(error.message);
  }
});

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
  const options = Object.keys(fontStacks)
    .map((font) => `<option value="${escapeHtml(font)}">${escapeHtml(font)}</option>`)
    .join("");

  document.querySelector("#displayFont").innerHTML = options;
  document.querySelector("#bodyFont").innerHTML = options;
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
  // The brand name is the doc title — committing it renames the saved guide.
  controls.brandName.addEventListener("change", () => store.rename());
}

function applyState(state) {
  controlIds.forEach((id) => {
    controls[id].value = state[id] ?? defaults[id];
  });
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
    buttonStyle: controls.buttonStyle.value
  };
}

function render() {
  const state = getState();
  controls.skillName.value = state.skillName;
  headlineWeightValue.textContent = String(state.headlineWeight);
  headlineScaleValue.textContent = state.headlineScale.toFixed(2);

  document.documentElement.style.setProperty("--brand-ink", state.ink);
  document.documentElement.style.setProperty("--brand-muted", state.muted);
  document.documentElement.style.setProperty("--brand-bg", state.background);
  document.documentElement.style.setProperty("--brand-surface", state.surface);
  document.documentElement.style.setProperty("--brand-primary", state.primary);
  document.documentElement.style.setProperty("--brand-accent", state.accent);
  document.documentElement.style.setProperty("--brand-radius", `${state.radius}px`);
  document.documentElement.style.setProperty("--brand-spacing", `${state.spacing}px`);
  document.documentElement.style.setProperty("--brand-body", fontStacks[state.bodyFont]);
  document.documentElement.style.setProperty("--brand-display", fontStacks[state.displayFont]);
  document.documentElement.style.setProperty("--brand-base-size", `${state.baseSize}px`);
  document.documentElement.style.setProperty("--brand-line-height", state.lineHeight);
  document.documentElement.style.setProperty("--brand-headline-weight", state.headlineWeight);
  document.documentElement.style.setProperty("--brand-headline-scale", state.headlineScale);
  brandPreview.dataset.buttonStyle = state.buttonStyle;

  brandPreview.querySelector(".sample-nav strong").textContent = state.brandName;
  skillOutput.textContent = buildSkill(state);
  tokensOutput.textContent = JSON.stringify(buildTokens(state), null, 2);
  cssOutput.textContent = buildCss(state);
}

function setActiveTab(name) {
  activeTab = name;

  Object.entries(tabs).forEach(([tabName, tab]) => {
    const isActive = tabName === name;
    tab.button.classList.toggle("active", isActive);
    tab.button.setAttribute("aria-selected", String(isActive));
    tab.panel.classList.toggle("visible", isActive);
  });
}

function currentExport() {
  if (activeTab === "preview") return null;
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
