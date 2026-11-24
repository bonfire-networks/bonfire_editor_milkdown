import { $view } from '@milkdown/utils';
import { imageSchema } from '@milkdown/preset-commonmark';

// A file placed in the text before it's uploaded is `![](upload:<ref>)`, `<ref>` being its LiveView upload entry's: its URL only exists once the post is published.
// Meanwhile it shows from the file itself when the editor had it (pasted or dropped: LiveView's preview only comes with the server's reply), else from the preview LiveView made for that entry (`live_img_preview` renders `<img data-phx-entry-ref>`). The node keeps `upload:<ref>`, so that's what is sent.
// A video or audio file is placed the same way (it shows as its player once published), and shows here as a video or audio, which an image of it can't.
const files = new Map(); // ref => { url, tag }

export function showFromFile(ref, file) {
  if (files.has(ref)) return;
  const tag = file.type?.startsWith('video/') ? 'video' : file.type?.startsWith('audio/') ? 'audio' : 'img';
  files.set(ref, { url: URL.createObjectURL(file), tag });
}

const uploadRef = src => (src?.startsWith('upload:') ? src.slice('upload:'.length) : null);

export function previewSrc(src) {
  const ref = uploadRef(src);
  if (ref === null) return src;
  return files.get(ref)?.url || document.querySelector(`img[data-phx-entry-ref="${CSS.escape(ref)}"]`)?.getAttribute('src') || '';
}

const previewTag = src => files.get(uploadRef(src))?.tag || 'img';

export const imageView = $view(imageSchema.node, () => node => {
  const tag = previewTag(node.attrs.src);
  const dom = document.createElement(tag);
  if (tag !== 'img') dom.controls = true;

  const show = node => {
    dom.src = previewSrc(node.attrs.src || '');
    if (tag === 'img') dom.alt = node.attrs.alt || '';
    if (node.attrs.title) dom.title = node.attrs.title;
    else dom.removeAttribute('title');
  };

  show(node);

  return {
    dom,
    update: updated => {
      // a different kind of file needs a different element: ProseMirror makes a new view
      if (updated.type !== node.type || previewTag(updated.attrs.src) !== tag) return false;
      show(updated);
      return true;
    },
  };
});
