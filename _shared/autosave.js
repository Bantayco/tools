// Shared autosave for every tool — one consistent saving experience.
//
// Behaviour:
//  - Edits autosave automatically (debounced). No Save button.
//  - Signed in  -> saves to your account (D1). Signed out -> localStorage only.
//  - A fresh doc autosaves under "untitled"; setting/changing the title renames
//    the saved doc to follow it (new row written, old row deleted).
//
// All remote writes are SERIALIZED through one chain so a debounced content
// save and a rename can never overlap — otherwise an in-flight save of the old
// slug could land after the rename deletes it and re-create it (a duplicate).
import { listAssets, saveAsset, deleteAsset } from "/_shared/api.js";

const DEBOUNCE_MS = 1000;
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

  // Single write queue: every saveAsset/deleteAsset runs strictly in order, so
  // a rename's delete of the old slug always happens AFTER any earlier save of
  // it, and nothing saves the old slug afterward.
  let chain = Promise.resolve();
  function serialize(task) {
    chain = chain.then(task, task); // keep going even if a prior task threw
    return chain;
  }

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

  // Autosave content under the CURRENT slug.
  function commit() {
    saveLocal();
    if (!signedIn) {
      status("Saved locally");
      return chain;
    }
    return serialize(async () => {
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
      }
    });
  }

  // Debounced trigger — call on every edit.
  function change() {
    status("Saving…");
    clearTimeout(timer);
    timer = setTimeout(commit, DEBOUNCE_MS);
  }

  // Rename the saved doc to follow the title. Call on title commit (blur/change).
  function rename() {
    clearTimeout(timer); // drop any pending content-save aimed at the old slug
    const next = slugify(getTitle()) || DEFAULT_SLUG;
    if (next === slug) return commit();

    const prev = slug;
    slug = next;
    saveLocal();
    if (!signedIn) {
      status("Saved locally");
      return chain;
    }
    status("Saving…");
    return serialize(async () => {
      try {
        await saveAsset(tool, next, snapshot());
        if (prev && prev !== next) {
          try {
            await deleteAsset(tool, prev);
          } catch {
            /* old row may not exist yet — fine */
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
    });
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
