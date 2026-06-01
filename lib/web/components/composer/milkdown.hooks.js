// Thin shim for the Milkdown composer hook.
//
// The heavy editor (`@milkdown/*` + ProseMirror + emoji-picker, ~570kb) lives in
// a SEPARATE esbuild ESM bundle (`/assets/milkdown_editor.js`, built via
// `build.milkdown`) so it stays OUT of the main bundle loaded on every page. We
// fetch it on demand the first time the composer mounts.
//
// IMPORTANT (per LiveView best practice + ProseMirror singleton rule):
//   - `handleEvent` is registered SYNCHRONOUSLY in mounted() and events arriving
//     before the editor bundle finishes loading are QUEUED, then flushed once the
//     editor is ready — so none are dropped (e.g. a `focus-editor` at open).
//   - ALL Milkdown/ProseMirror code stays in the single lazy bundle; the main
//     bundle must never also import it (avoids duplicate-ProseMirror failures).

// Module-level memo so the editor bundle is fetched (and parsed) only once per
// page, then reused across composer remounts/navigation.
let editorModule;
function loadEditorModule(url) {
  return (editorModule ||= import(url));
}

// Server events that target the editor; handled by the loaded module's dispatcher.
const EDITOR_EVENTS = [
  "mention_suggestions",
  "smart_input:reset",
  "focus-editor",
  "insert_at_cursor",
];

export default {
  mounted() {
    this._destroyed = false;
    this._ready = false;
    this._eventQueue = [];

    // Register handlers synchronously so nothing is missed while the bundle loads.
    // Until the editor is ready, queue payloads; flush them once it is.
    for (const name of EDITOR_EVENTS) {
      this.handleEvent(name, (payload) => {
        if (this._ready && this._mod) {
          this._mod.handleServerEvent(this, name, payload);
        } else {
          this._eventQueue.push({ name, payload });
        }
      });
    }

    const bundleUrl =
      this.el.dataset.editorBundle ||
      new URL("/assets/milkdown_editor.js", window.location.origin).href;

    loadEditorModule(bundleUrl)
      .then(async (mod) => {
        if (this._destroyed) return;
        this._mod = mod;
        await mod.mountEditor(this);
        // If we were torn down during the async import/init, ensure any editor
        // that finished creating gets destroyed (initEditor self-aborts too, but
        // this is the catch-all since destroyed() may have run while editor was null).
        if (this._destroyed) {
          mod.destroy(this);
          return;
        }

        this._ready = true;
        // Flush any events that arrived during download/init.
        const queued = this._eventQueue;
        this._eventQueue = [];
        for (const { name, payload } of queued) {
          mod.handleServerEvent(this, name, payload);
        }
      })
      .catch((e) => {
        console.error("milkdown: failed to load editor bundle", e);
      });
  },

  updated() {
    this._mod?.syncFromServer?.(this);
  },

  reconnected() {
    this._mod?.reconnect?.(this);
  },

  destroyed() {
    this._destroyed = true;
    this._mod?.destroy?.(this);
  },
};
