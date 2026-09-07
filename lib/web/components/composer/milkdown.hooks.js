// Keep Milkdown/ProseMirror in the lazy build.ext bundle. Register server events before loading so opening/reply events can be replayed after initialization.
let editorModule;
function loadEditorModule(url) {
  return (editorModule ||= import(url));
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

    for (const name of EDITOR_EVENTS) {
      this.handleEvent(name, (payload) => {
        if (this._ready && this._mod) {
          this._mod.handleServerEvent(this, name, payload);
        } else {
          this._eventQueue.push({ name, payload });
        }
      });
    }

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
