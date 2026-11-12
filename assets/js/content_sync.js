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
      let wasEmpty = !hiddenInput.value.trim();
      const form = hiddenInput.form;
      const flush = (notify = true) => {
        if (destroyed) return;
        if (notify) clearTimeout(timeout);
        if (lastDoc !== view.state.doc) {
          markdown = serializeMarkdownForSubmit(ctx, view.state.doc);
          lastDoc = view.state.doc;
        }
        hiddenInput.value = markdown;
        const empty = !markdown.trim();
        if (notify && !empty && !form?.classList.contains('phx-submit-loading')) { // enable Post without waiting for the server; never during a submit, since LiveView disables Post before the FormData that calls flush(false)
          form?.querySelector('#submit_btn')?.removeAttribute('disabled');
        }
        if (notify && lastNotified !== markdown) {
          lastNotified = markdown;
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
          if (empty !== wasEmpty) { // text appeared or was cleared: tell the server now, so its Post state and re-renders match
            wasEmpty = empty;
            hiddenInput.dispatchEvent(new Event('blur'));
          }
        }
        return markdown;
      };
      const handleSubmit = () => flush(false);
      const handleFormData = event => {
        // FormData has already taken its snapshot when this event fires.
        event.formData.set(hiddenInput.name, flush(false));
      };
      const handleBlur = () => {
        flush();
        hiddenInput.dispatchEvent(new Event('blur')); // the textarea's phx-debounce="blur" sends the held change now; it never has focus itself
      };
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

// Sends the textarea's value to the server now, past its phx-debounce="blur".
export function notifyServer(hiddenInput) {
  hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
  hiddenInput.dispatchEvent(new Event('blur'));
}
