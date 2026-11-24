// Keep Milkdown/ProseMirror in the lazy build.ext bundle. Register server events before loading so opening/reply events can be replayed after initialization.
let editorModule;
function loadEditorModule(url) {
  return (editorModule ||= import(url));
}

// A composer mode without the editor (eg. a poll's question) takes the same insertion in a plain field marked `data-insert-at-cursor`, as typed markdown: an upload placed there as `![](upload:<ref>)` gets its URL at publish all the same.
// Here rather than in the editor bundle, which such a mode doesn't load.
// An insertion dispatched elsewhere (eg. on an upload preview's "Insert in text" button) goes to the plain field last written in, else to the editor, else to the first plain field.
const PLAIN_FIELD = "input[data-insert-at-cursor], textarea[data-insert-at-cursor]";
const EDITOR = "#editor_milkdown_container";

if (typeof document !== "undefined" && !window.__bonfireInsertAtCursor) {
  window.__bonfireInsertAtCursor = true;
  let lastField = null;

  document.addEventListener("focusin", (event) => {
    if (event.target?.matches?.(PLAIN_FIELD)) lastField = event.target;
    else if (event.target?.closest?.(EDITOR)) lastField = null;
  });

  const insertInto = (field, text) => {
    const end = field.value.length;
    field.setRangeText(text, field.selectionStart ?? end, field.selectionEnd ?? end, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
  };

  document.addEventListener("bonfire:insert_at_cursor", (event) => {
    const target = event.target;
    const text = event.detail?.text;
    if (!text) return;
    if (target?.matches?.(PLAIN_FIELD)) return insertInto(target, text);
    // the editor's hook handles what's dispatched on it
    if (target?.closest?.(EDITOR)) return;

    const field = lastField?.isConnected ? lastField : null;
    const editor = document.querySelector(EDITOR);
    if (field) insertInto(field, text);
    else if (editor) editor.dispatchEvent(new CustomEvent("bonfire:insert_at_cursor", { detail: event.detail, bubbles: true }));
    else {
      const first = document.querySelector(PLAIN_FIELD);
      if (first) insertInto(first, text);
    }
  });
}

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

    // handled now if the editor is ready, else once it is
    const dispatch = (name, payload) => {
      if (this._ready && this._mod) {
        this._mod.handleServerEvent(this, name, payload);
      } else {
        this._eventQueue.push({ name, payload });
      }
    };

    for (const name of EDITOR_EVENTS) {
      this.handleEvent(name, (payload) => dispatch(name, payload));
    }

    // the same insertion from the page, without a server round trip (eg. an upload preview's "Insert in text")
    this.el.addEventListener("bonfire:insert_at_cursor", (event) => {
      dispatch("insert_at_cursor", event.detail || {});
      this.loadEditor();
    });

    this._loadStarted = false;
    this._onInteract = () => this.loadEditor();

    this._io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadEditor();
    });
    this._io.observe(this.el);
    this.el.addEventListener("focusin", this._onInteract);
    this.el.addEventListener("pointerdown", this._onInteract);
  },

  async loadEditor() {
    if (this._loadStarted || this._destroyed) return;
    this._loadStarted = true;
    this._teardownLazyTriggers();

    const bundleUrl =
      this.el.dataset.editorBundle ||
      new URL("/assets/milkdown_editor.js", window.location.origin).href;

    try {
      const mod = await loadEditorModule(bundleUrl);
      if (this._destroyed) return;
      this._mod = mod;
      await mod.mountEditor(this);
      if (this._destroyed) {
        mod.destroy(this);
        return;
      }

      this._ready = true;
      const queued = this._eventQueue;
      this._eventQueue = [];
      for (const { name, payload } of queued) {
        mod.handleServerEvent(this, name, payload);
      }
    } catch (e) {
      if (this._destroyed) return;
      await this._mod?.destroy?.(this);
      this._ready = false;
      console.error('milkdown: failed to initialize editor', e);
    }
  },

  _teardownLazyTriggers() {
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }
    if (this._onInteract) {
      this.el.removeEventListener("focusin", this._onInteract);
      this.el.removeEventListener("pointerdown", this._onInteract);
    }
  },

  reconnected() {
    this._mod?.reconnect?.(this);
  },

  destroyed() {
    this._destroyed = true;
    this._teardownLazyTriggers();
    this._eventQueue = [];
    this._mod?.destroy?.(this);
  },
};
