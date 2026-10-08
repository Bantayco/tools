// Reusable "Publish" control for tools.bantay.co.
//
// A tool mounts this on any container element and gets a button that toggles
// the asset's public visibility. Publishing snapshots the CURRENT saved copy
// into publish-only columns; later edits don't leak until the owner republishes.
//
// Usage (from a tool's app.js):
//   import { createPublish } from "/_shared/publish.js";
//   const publish = createPublish({
//     tool: "mermaid",
//     getSlug: () => store.slug,
//     container: document.querySelector("#publishMount"),
//     onStatus: showStatus,
//     makePublicUrl: (tool, slug) => `${location.origin}/mermaid/?p=${slug}`,
//   });
//   publish.refresh();          // call after signin / after a save that changed the slug
//   publish.setEnabled(false);  // e.g. while a rename is in flight
//
// The component itself is tool-agnostic — it never touches the tool's payload.
// The tool decides what the human-readable public URL looks like via
// `makePublicUrl`; the raw JSON always lives at /public/<tool>/<slug>.
import { getPublishState, publishAsset, unpublishAsset } from "/_shared/api.js";

export function createPublish({
  tool,
  getSlug,
  container,
  onStatus,
  makePublicUrl,
}) {
  if (!container) throw new Error("createPublish: container is required");
  if (typeof getSlug !== "function") throw new Error("createPublish: getSlug must be a function");
  if (typeof makePublicUrl !== "function") throw new Error("createPublish: makePublicUrl must be a function");

  const status = (m) => onStatus && onStatus(m);

  container.classList.add("publish");
  container.innerHTML = `
    <button type="button" class="publish-toggle" data-role="toggle" title="Publish this file publicly">Publish</button>
    <div class="publish-linkbox" data-role="linkbox" hidden>
      <a class="publish-link" data-role="link" href="#" target="_blank" rel="noopener"></a>
      <button type="button" class="publish-copy" data-role="copy" title="Copy public link">Copy</button>
      <button type="button" class="publish-unpublish" data-role="unpublish" title="Unpublish">Unpublish</button>
    </div>
  `;

  const toggleBtn = container.querySelector('[data-role="toggle"]');
  const linkBox = container.querySelector('[data-role="linkbox"]');
  const linkEl = container.querySelector('[data-role="link"]');
  const copyBtn = container.querySelector('[data-role="copy"]');
  const unpublishBtn = container.querySelector('[data-role="unpublish"]');

  let state = { publishedAt: null, publicUrl: null };
  let enabled = true;
  let busy = false;

  function currentUrl() {
    const slug = getSlug();
    return slug ? makePublicUrl(tool, slug) : null;
  }

  function render() {
    const disabled = !enabled || busy || !getSlug();
    toggleBtn.disabled = disabled;
    if (state.publishedAt) {
      toggleBtn.textContent = "Published";
      toggleBtn.classList.add("is-published");
      linkBox.hidden = false;
      const url = currentUrl();
      linkEl.href = url || "#";
      linkEl.textContent = url ? url.replace(/^https?:\/\//, "") : "";
      copyBtn.disabled = disabled || !url;
      unpublishBtn.disabled = disabled;
    } else {
      toggleBtn.textContent = "Publish";
      toggleBtn.classList.remove("is-published");
      linkBox.hidden = true;
    }
  }

  async function refresh() {
    const slug = getSlug();
    if (!slug) {
      state = { publishedAt: null, publicUrl: null };
      render();
      return;
    }
    try {
      const result = await getPublishState(tool, slug);
      state = result || { publishedAt: null, publicUrl: null };
    } catch (err) {
      // Signed out, or the asset hasn't been saved yet — treat as "not published".
      state = { publishedAt: null, publicUrl: null };
    }
    render();
  }

  async function publish() {
    const slug = getSlug();
    if (!slug) return;
    busy = true;
    render();
    status("Publishing…");
    try {
      const result = await publishAsset(tool, slug);
      state = result;
      status("Published");
    } catch (err) {
      status(err.message || "Publish failed");
    } finally {
      busy = false;
      render();
    }
  }

  async function unpublish() {
    const slug = getSlug();
    if (!slug) return;
    busy = true;
    render();
    status("Unpublishing…");
    try {
      await unpublishAsset(tool, slug);
      state = { publishedAt: null, publicUrl: null };
      status("Unpublished");
    } catch (err) {
      status(err.message || "Unpublish failed");
    } finally {
      busy = false;
      render();
    }
  }

  async function copy() {
    const url = currentUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      status("Link copied");
    } catch {
      status("Copy failed — select the link and copy manually");
    }
  }

  toggleBtn.addEventListener("click", () => {
    if (state.publishedAt) return; // handled by unpublishBtn once published
    publish();
  });
  unpublishBtn.addEventListener("click", unpublish);
  copyBtn.addEventListener("click", copy);

  render();

  return {
    refresh,
    setEnabled(v) {
      enabled = !!v;
      render();
    },
    get published() {
      return !!state.publishedAt;
    },
  };
}
