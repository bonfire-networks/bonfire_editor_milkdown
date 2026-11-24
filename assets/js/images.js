import { $view } from '@milkdown/utils';
import { imageSchema } from '@milkdown/preset-commonmark';

// A file placed in the text before it's uploaded is `![](upload:<ref>)`, `<ref>` being its LiveView upload entry's: its URL only exists once the post is published.
// Meanwhile it shows from the file itself when the editor had it (pasted or dropped: LiveView's preview only comes with the server's reply), else from the preview LiveView made for that entry (`live_img_preview` renders `<img data-phx-entry-ref>`). The node keeps `upload:<ref>`, so that's what is sent.
const fileUrls = new Map();

export function showFromFile(ref, file) {
  if (!fileUrls.has(ref)) fileUrls.set(ref, URL.createObjectURL(file));
}

export function previewSrc(src) {
  if (!src?.startsWith('upload:')) return src;
  const ref = src.slice('upload:'.length);
  return fileUrls.get(ref) || document.querySelector(`img[data-phx-entry-ref="${CSS.escape(ref)}"]`)?.getAttribute('src') || '';
}

export const imageView = $view(imageSchema.node, () => node => {
  const img = document.createElement('img');

  const show = node => {
    img.src = previewSrc(node.attrs.src || '');
    img.alt = node.attrs.alt || '';
    if (node.attrs.title) img.title = node.attrs.title;
    else img.removeAttribute('title');
  };

  show(node);

  return {
    dom: img,
    update: updated => {
      if (updated.type !== node.type) return false;
      show(updated);
      return true;
    },
  };
});
