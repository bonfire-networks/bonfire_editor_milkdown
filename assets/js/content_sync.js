import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { serializeMarkdownForSubmit } from './submit_markdown.js';

export function createContentSyncPlugin(hook, hiddenInput) {
  return $prose(ctx => new Plugin({
    key: new PluginKey('bonfire-content-sync'),
    view(view) {
      let timeout;
      let lastDoc;
      let markdown;
      let lastNotified = hiddenInput.value;
      let destroyed = false;
      const flush = (notify = true) => {
        if (destroyed) return;
        if (notify) clearTimeout(timeout);
        if (lastDoc !== view.state.doc) {
          markdown = serializeMarkdownForSubmit(ctx, view.state.doc);
          lastDoc = view.state.doc;
        }
        hiddenInput.value = markdown;
        if (notify && lastNotified !== markdown) {
          lastNotified = markdown;
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return markdown;
      };
      const form = hiddenInput.form;
      const handleSubmit = () => flush(false);
      const handleFormData = event => {
        // FormData has already taken its snapshot when this event fires.
        event.formData.set(hiddenInput.name, flush(false));
      };
      const handleBlur = () => flush();
      form?.addEventListener('submit', handleSubmit, true);
      form?.addEventListener('formdata', handleFormData);
      view.dom.addEventListener('blur', handleBlur);
      hook._flushEditor = flush;

      return {
        update(updatedView, previousState) {
          if (updatedView.state.doc === previousState.doc) return;
          clearTimeout(timeout);
          timeout = setTimeout(flush, 200);
        },
        destroy() {
          destroyed = true;
          clearTimeout(timeout);
          form?.removeEventListener('submit', handleSubmit, true);
          form?.removeEventListener('formdata', handleFormData);
          view.dom.removeEventListener('blur', handleBlur);
          if (hook._flushEditor === flush) hook._flushEditor = null;
        },
      };
    },
  }));
}
