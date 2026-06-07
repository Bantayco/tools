// Shared autosave for every tool — one consistent saving experience.
//
// Behaviour:
//  - Edits autosave automatically (debounced). No Save button.
//  - Signed in  -> saves to your account (KV) under a slug derived from the title.
//  - Signed out -> saves to localStorage only; you can still work, nothing is lost.
//  - A fresh doc autosaves under a default slug ("untitled"); when you set/change
//    the title, the saved doc is renamed to follow it (old key removed).
//
// A tool wires itself up by describing how to read/serialise its state:
//   createStore({ tool, draftKey, getTitle, getPayload, onStatus, onSaved })
import { listAssets, saveAsset, deleteAsset } from "/_shared/api.js";

const DEBOUNCE_MS = 1000; // also keeps us under KV's ~1 write/sec per key
const DEFAULT_SLUG = "untitled";

export function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function createStore({ tool, draftKey, getTitle, getPayload, onStatus, onSaved }) {
  let slug = DEFAULT_SLUG;
  let signedIn = false;
  let timer = null;
  let saving = false; // a KV write is in flight
  let pending = false; // another change arrived mid-write

  const status = (m) => onStatus && onStatus(m);

  function snapshot() {
    return { title: (getTitle() || "").trim(), ...getPayload() };
  }

  function saveLocal() {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ slug, ...snapshot() }));
    } catch {
      /* storage full / disabled — ignore */
    }
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(draftKey) || "null");
    } catch {
      return null;
    }
  }

  // Autosave content under the CURRENT slug (no rename). Coalesces concurrent writes.
  async function commit() {
    saveLocal();
    if (!signedIn) return status("Saved locally");
    if (saving) {
      pending = true;
      return;
    }
    saving = true;
    try {
      await saveAsset(tool, slug, snapshot());
      status("Saved");
    } catch (err) {
      if (err.message === "Not signed in") {
        signedIn = false;
        status("Saved locally");
      } else {
        status(err.message || "Save failed");
      }
    } finally {
      saving = false;
      if (pending) {
        pending = false;
        commit();
      }
    }
  }

  // Debounced trigger — call on every edit.
  function change() {
    status("Saving…");
    clearTimeout(timer);
    timer = setTimeout(commit, DEBOUNCE_MS);
  }

  // Rename the saved doc to follow the title. Call on title commit (blur/change).
  async function rename() {
    const next = slugify(getTitle()) || DEFAULT_SLUG;
    if (next === slug) return commit();
    const prev = slug;
    slug = next;
    saveLocal();
    if (!signedIn) return status("Saved locally");
    try {
      await saveAsset(tool, slug, snapshot());
      if (prev && prev !== slug) {
        try {
          await deleteAsset(tool, prev);
        } catch {
          /* old key may not exist yet — fine */
        }
      }
      status("Saved");
      onSaved && onSaved();
    } catch (err) {
      if (err.message === "Not signed in") {
        signedIn = false;
        status("Saved locally");
      } else {
        status(err.message || "Save failed");
      }
    }
  }

  // Probe auth and return the user's saved items (empty array if signed out).
  async function init() {
    try {
      const items = await listAssets(tool);
      signedIn = true;
      return items;
    } catch {
      signedIn = false;
      return [];
    }
  }

  return {
    init,
    change,
    rename,
    commit,
    saveLocal,
    loadLocal,
    get slug() {
      return slug;
    },
    setSlug(v) {
      slug = v || DEFAULT_SLUG;
    },
    get signedIn() {
      return signedIn;
    },
  };
}
