// Shared theme control. Preference is one of: "light" | "dark" | "system".
// Stored in localStorage; each page also runs a tiny inline snippet in <head>
// to apply it before paint (no flash). "system" = follow prefers-color-scheme.
const KEY = "bantay-theme";

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref) {
  const html = document.documentElement;
  if (pref === "light" || pref === "dark") html.setAttribute("data-theme", pref);
  else html.removeAttribute("data-theme"); // system → media query governs
}

export function setTheme(pref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  applyTheme(pref);
}
