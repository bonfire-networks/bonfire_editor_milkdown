// Loaded on demand by milkdown.hooks.js; build.ext keeps Milkdown and ProseMirror in one bundle.
import {
  defaultValueCtx,
  editorViewOptionsCtx,
  Editor,
  editorViewCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { replaceAll, insert, $prose } from '@milkdown/utils';
import { imageView, showFromFile } from './images.js';
import { commonmark, hardbreakSchema, headingAttr, insertImageInputRule, linkSchema } from '@milkdown/preset-commonmark';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { Plugin, PluginKey, Selection, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { createMentionsPlugin } from './mentions.js';
import { createContentSyncPlugin, notifyServer } from './content_sync.js';
import { createLinkConversionPlugin } from './links.js';
import { serializeSocialText } from './submit_markdown.js';
// The main bundle also registers this element. createElement uses the registered class regardless of which bundle loaded first.
import 'emoji-picker-element';

function createPlaceholder(container) {
  return $prose(() => new Plugin({
    key: new PluginKey('milkdown-placeholder'),
    props: {
      decorations(state) {
        const paragraph = state.doc.firstChild;
        if (state.doc.childCount !== 1 || paragraph?.type.name !== 'paragraph' || paragraph.content.size) return null;
        return DecorationSet.create(state.doc, [Decoration.node(0, paragraph.nodeSize, {
          class: 'is-empty',
          'data-placeholder': container.dataset.placeholder,
        })]);
      },
    },
  }));
}

function getComposerRoot(hookInstance) {
  return hookInstance?.el?.closest('form') || hookInstance?.el || document;
}

function initEmojiPicker(editor, hookInstance) {
  const pickerContainer = getComposerRoot(hookInstance).querySelector('#emoji-picker-in-composer');

  if (!pickerContainer) {
    return;
  }

  if (hookInstance?._currentPicker) {
    return;
  }

  try {
    let customEmoji = [];
    try {
      const emojisData = pickerContainer.getAttribute('data-emojis');
      if (emojisData && emojisData !== '[]') {
        customEmoji = JSON.parse(emojisData);
      }
    } catch (e) {
      console.error('Failed to parse custom emojis:', e);
    }

    const picker = document.createElement('emoji-picker');
    picker.customEmoji = customEmoji;

    if (hookInstance) {
      hookInstance._currentPicker = picker;
    }

    pickerContainer.appendChild(picker);

    picker.addEventListener('emoji-click', event => {
      const { unicode, emoji } = event.detail;

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);

        const text = !unicode && emoji?.shortcodes?.[0]
          ? emoji.shortcodes[0]
          : unicode || '';

        if (!text) {
          console.warn('No valid emoji text to insert');
          return;
        }

        try {
          view.dispatch(view.state.tr.insertText(text + " "));
          view.focus();
        } catch (error) {
          console.error('Failed to insert emoji:', error);
        }
      });
    });

  } catch (error) {
    console.error('Error initializing emoji picker:', error);
  }
}

function setupLazyEmojiPicker(editor, hookInstance) {
  const emojiButton = getComposerRoot(hookInstance).querySelector('.emoji-button');

  if (!emojiButton) {
    return;
  }

  const handleEmojiButtonClick = () => {
    if (!hookInstance?._currentPicker) {
      initEmojiPicker(editor, hookInstance);
    }
  };

  emojiButton.addEventListener('click', handleEmojiButtonClick);

  if (hookInstance) {
    hookInstance._emojiButton = emojiButton;
    hookInstance._emojiButtonHandler = handleEmojiButtonClick;
  }

}

async function initEditor(hook, hiddenInput, container) {
  if (hook._destroyed) return;
  const editor = await Editor.make()
    .config(ctx => {
      ctx.set(rootCtx, container);
      ctx.set(defaultValueCtx, hiddenInput.value || '');
      ctx.update(remarkStringifyOptionsCtx, options => ({
        ...options,
        handlers: { ...options.handlers, text: serializeSocialText },
      }));
      const headingStyles = {
        1: 'text-3xl', 2: 'text-2xl', 3: 'text-xl',
        4: 'text-lg', 5: 'text-base', 6: 'text-base',
      };
      ctx.set(headingAttr.key, node => ({
        class: `${headingStyles[node.attrs.level] || 'text-base'} no-margin-top`,
        'data-el-type': node.attrs.level <= 4 ? 'h3' : 'h4',
        id: null,
      }));
      // Posts render soft breaks as `<br>` (MDEx `hardbreaks: true`), not as a space
      ctx.update(hardbreakSchema.key, schema => innerCtx => {
        const spec = schema(innerCtx);
        return {
          ...spec,
          parseDOM: [{ tag: 'br[data-is-inline="true"]', getAttrs: () => ({ isInline: true }) }, ...spec.parseDOM],
          toDOM: node => ['br', spec.toDOM(node)[1]],
        };
      });
      ctx.update(editorViewOptionsCtx, previous => ({
        ...previous,
        attributes: {
          // prose-p:!my-1: the post body's paragraph spacing
          class: 'milkdown-editor relative mx-auto focus:outline-hidden h-full p-2 prose prose-bonfire break-normal max-w-none text-base-content prose-hr:!my-2 prose-br:hidden prose-p:!my-1',
          // ProseMirror reads typed text back from the DOM, so a collapsed trailing space (e.g. after a reply mention) is lost on the next keystroke
          style: 'white-space: pre-wrap; white-space: break-spaces',
          spellcheck: 'false',
          autocomplete: 'off',
        },
        // pasted files, or an image only this tab has (`blob:`/`data:`), are uploaded and placed
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files || []);
          const localUrl = !files.length && localImageUrl(event.clipboardData);
          if (!files.length && !localUrl) return false;
          event.preventDefault();
          if (files.length) uploadAndPlace(hook, files);
          else uploadAndPlaceUrl(hook, localUrl);
          return true;
        },
        // files dropped on the text land where they're dropped, rather than only as attachments
        // an upload's preview dragged in is placed by its ref, as "Insert in text" does, never as its `blob:` URL (see `milkdown.hooks.js`); any other image only this tab has is uploaded
        // a media picker tile dragged in is placed by its own Insert button, at the drop point (see `milkdown.hooks.js`)
        handleDrop: (view, event) => {
          const mediaId = event.dataTransfer?.getData(PICKED_MEDIA_TYPE);
          const ref = !mediaId && event.dataTransfer?.getData(UPLOAD_REF_TYPE);
          const files = mediaId ? [] : Array.from(event.dataTransfer?.files || []);
          const localUrl = !mediaId && !ref && !files.length && localImageUrl(event.dataTransfer);
          if (!mediaId && !ref && !files.length && !localUrl) return false;
          event.preventDefault();
          // LiveView's own drop handling on the composer would add the same files again
          event.stopPropagation();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))));
          if (mediaId) {
            // focused, the editor is where the Insert goes (rather than a plain field written in before)
            view.focus();
            runPickedInsert(mediaId);
          } else if (ref) handleServerEvent(hook, 'insert_at_cursor', { text: `![](upload:${ref})`, markdown: true });
          else if (files.length) uploadAndPlace(hook, files);
          else uploadAndPlaceUrl(hook, localUrl);
          return true;
        },
      }));
    })
    .use(commonmark)
    // the preset defines a typed `![alt](url)` input rule but doesn't register it; before the link conversion, so `![a](url)` becomes an image rather than `!` and a link
    .use(insertImageInputRule)
    .use(imageView)
    .use(indent)
    .use(trailing)
    .use(clipboard)
    .use(history)
    .use(createMentionsPlugin(hook))
    .use(createLinkConversionPlugin())
    .use(createPlaceholder(container))
    .use(createContentSyncPlugin(hook, hiddenInput))
    .create();

  if (hook._destroyed) {
    await editor.destroy();
    return;
  }
  hook.editor = editor;
  setupLazyEmojiPicker(editor, hook);
}

// A restored draft continues after a fresh space (the Markdown parse drops a trailing one), with the caret at the end
function continueDraft(editor) {
  editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    const last = view.state.doc.lastChild;
    if (last?.type.name !== 'paragraph') return; // any transaction makes the trailing plugin add a paragraph after a code block
    const tr = view.state.tr;
    if (last.textContent && !/\s$/.test(last.textContent)) {
      const end = view.state.doc.content.size - 1;
      // The link mark is inclusive
      const marks = linkSchema.type(ctx).removeFromSet(view.state.doc.resolve(end).marks());
      tr.insert(end, view.state.schema.text(' ', marks));
    }
    view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)).setMeta('addToHistory', false));
  });
}

export async function mountEditor(hook) {
  const hiddenInput = hook.el.querySelector('#editor_hidden_input');
  const container = hook.el.querySelector('#editor');
  if (!hiddenInput || !container) throw new Error('Milkdown composer is missing its input or editor container');

  if (!hiddenInput.value && hook.el.dataset.suggestion) hiddenInput.value = hook.el.dataset.suggestion;
  const draft = window.Bonfire?.getComposerDraft?.(hiddenInput);
  if (draft) hiddenInput.value = draft;
  await initEditor(hook, hiddenInput, container);
  if (hook._destroyed) return;
  if (draft) continueDraft(hook.editor);
  hook._guardReplyOverDraft = event => guardReplyOverDraft(hook, event);
  document.addEventListener('click', hook._guardReplyOverDraft, true);
  // [data-keep-editor-focus] controls must not take focus, or iOS closes the keyboard
  hook._keepFocus = event => {
    if (event.target.closest?.('[data-keep-editor-focus]') && hook.el.contains(document.activeElement)) event.preventDefault();
  };
  document.addEventListener('mousedown', hook._keepFocus, true);
  // the keyboard opening (or closing) shrinks the visible area, and an iOS paste does not scroll: keep the caret in view once things settle
  hook._followCaret = () => {
    clearTimeout(hook._followCaretTimer);
    hook._followCaretTimer = setTimeout(() => hook.editor?.action(ctx => {
      const view = ctx.get(editorViewCtx);
      if (!view.hasFocus() || (window.visualViewport?.scale ?? 1) !== 1) return; // not while pinch-zoomed
      // scroll the text area directly: a transaction would let the trailing plugin add a paragraph after a code block
      const caret = view.coordsAtPos(view.state.selection.head);
      const box = hook.el.getBoundingClientRect();
      if (caret.bottom > box.bottom) hook.el.scrollTop += caret.bottom - box.bottom + 8;
      else if (caret.top < box.top) hook.el.scrollTop -= box.top - caret.top + 8;
    }), 150);
  };
  window.visualViewport?.addEventListener('resize', hook._followCaret);
  hook.el.addEventListener('paste', hook._followCaret); // paste bubbles up from #editor
  lockWhileSending(hook);
  if (hiddenInput.value) notifyServer(hiddenInput);
}

// LiveView locks the form's inputs while sending, not this contenteditable: lock it (and, via data-sending, the controls) until the answer
function lockWhileSending(hook) {
  const form = hook.el.closest('form');
  if (!form) return;
  hook._sendContainer = hook.el.closest('#smart_input_container'); // destroy may run detached
  let locked = null; // null: the first sync also clears a data-sending left by a previous editor
  const sync = () => {
    const now = form.classList.contains('phx-submit-loading') || !!hook._awaitingReset;
    if (now === locked) return;
    locked = now;
    hook.editor?.action(ctx => ctx.get(editorViewCtx).setProps({ editable: () => !now }));
    hook._sendContainer?.toggleAttribute('data-sending', now);
  };
  hook._syncLock = sync;
  hook._sendLock = new MutationObserver(sync);
  hook._sendLock.observe(form, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// Replace accepted: locked until the server's reset (with its reply), so nothing typed meanwhile is wiped; reconnect releases a lost one
function awaitReset(hook) {
  hook._awaitingReset = true;
  hook._syncLock?.();
}

function releaseReset(hook) {
  if (!hook._awaitingReset) return;
  hook._awaitingReset = false;
  hook._syncLock?.();
}

// Reply on another post while the composer holds text: ask before the draft becomes that reply
function guardReplyOverDraft(hook, event) {
  const button = event.target.closest?.('[data-id="action_reply"]');
  if (!button || !hook.editor) return;
  const replyingTo = getComposerRoot(hook).querySelector('[name="reply_to[reply_to_id]"]')?.value || '';
  const markdown = hook._flushEditor?.(false) || '';
  if (!markdown.trim() || replyingTo === button.getAttribute('phx-value-id')) return;
  if (hook.liveSocket && !hook.liveSocket.isConnected()) return; // offline: keep the draft, ask nothing
  event.preventDefault();
  event.stopImmediatePropagation(); // LiveView handles clicks on window, bubble phase
  if (!window.confirm(hook.el.dataset.replaceDraftConfirm || 'Replace your draft with this reply?')) return;
  awaitReset(hook);
  // the reply's smart_input:reset clears and unlocks before this callback (a lost push keeps the draft); Reply targets another LiveView, so it is clicked again
  hook.pushEventTo('#smart_input', 'Bonfire.UI.Common.SmartInput:reset_to_default', {}, () => {
    setTimeout(() => button.click()); // click() is ignored during this click's dispatch
    focusOnceReplying(hook, button.getAttribute('phx-value-id'));
  });
}

// focus once the composer targets that post and is unlocked (gives up after 5 s)
function focusOnceReplying(hook, replyId, tries = 50) {
  clearTimeout(hook._focusReplyTimer);
  const input = getComposerRoot(hook).querySelector('[name="reply_to[reply_to_id]"]');
  if (input?.value === replyId && !hook._awaitingReset) return hook.editor?.action(ctx => ctx.get(editorViewCtx).focus());
  if (tries > 0) hook._focusReplyTimer = setTimeout(() => focusOnceReplying(hook, replyId, tries - 1), 100);
}

// a file the text can show where it sits (see `Bonfire.Files.InlineMedia`); any other one is only attached
const PLACEABLE = /^(image|video|audio)\//;

// the drag data type carrying an upload preview's ref (set on dragstart in `milkdown.hooks.js`, a separate bundle)
const UPLOAD_REF_TYPE = 'application/x-bonfire-upload-ref';
// the drag data type carrying a media picker tile's media id (set on dragstart in `milkdown.hooks.js`)
const PICKED_MEDIA_TYPE = 'application/x-bonfire-picked-media';

// runs a media picker tile's Insert button, which places the file at the cursor and adds it to the uploads (the same in `milkdown.hooks.js`)
function runPickedInsert(mediaId) {
  const button = document.querySelector(`[data-id=media_tile][data-media-id="${CSS.escape(mediaId)}"] [data-role=pick_insert]`);
  if (button) window.liveSocket?.execJS(button, button.getAttribute('phx-click'));
}

// Pasted or dropped files go to the composer's LiveView upload, as attached ones do (so its limits and upload at publish apply), and each image, video or audio is placed at the cursor as `![](upload:<ref>)`, `<ref>` being the ref LiveView gives the file (`file._phxRef`, its upload entry's).
// A file with the same content as one the composer still uploads (in its upload list, which the server renders: `[data-role=upload_entry][data-ref]`) isn't uploaded again: it's placed again with that ref.
async function uploadAndPlace(hook, files) {
  if (typeof hook.uploadTo !== 'function') return;
  // the form the editor is in: the post composer's, or the one a composer mode renders instead (eg. a poll's), which holds the same upload
  const form = hook.el.closest('form');
  const uploading = ref => !!document.querySelector(`[data-role=upload_entry][data-ref="${CSS.escape(ref)}"]`);

  const hashes = await Promise.all(files.map(contentHash));
  const sameAs = new Map(); // a file => the ref of the upload with its content
  files.forEach((file, i) => {
    const ref = hashes[i] && refsByHash.get(hashes[i]);
    if (ref && uploading(ref)) sameAs.set(file, ref);
  });
  const fresh = files.filter(file => !sameAs.has(file));
  if (fresh.length) hook.uploadTo(form || '#smart_input_form', 'files', fresh);

  const refOf = file => sameAs.get(file) ?? file._phxRef;

  const place = () => {
    files.forEach((file, i) => {
      if (file._phxRef === undefined) return;
      if (hashes[i]) refsByHash.set(hashes[i], file._phxRef);
      showFromFile(file._phxRef, file);
    });
    const markdown = files
      .filter(file => PLACEABLE.test(file.type) && refOf(file) !== undefined)
      .map(file => `![](upload:${refOf(file)})`)
      .join('\n\n');
    if (markdown) handleServerEvent(hook, 'insert_at_cursor', { text: markdown, markdown: true });
  };

  // LiveView gives a file its ref when it sends the form's change, which can be debounced, so after `uploadTo` returns: wait for the refs, a while at most, then place the files that have one
  const until = Date.now() + PLACE_WAIT_MS;
  const placeWhenRefs = () => {
    if (fresh.every(file => file._phxRef !== undefined) || Date.now() > until) place();
    else requestAnimationFrame(placeWhenRefs);
  };
  placeWhenRefs();
}

const PLACE_WAIT_MS = 5000;

// A `blob:` or `data:` image URL in what's dropped or pasted (eg. an image from elsewhere on the page), when no file comes with it: it only exists in this tab, so it's never put in the text as it is. An `https` one isn't taken (it can be attached by reference, see the plan's step on gallery reuse).
function localImageUrl(transfer) {
  const uri = (transfer?.getData('text/uri-list') || '').split(/\r?\n/).find(line => line && !line.startsWith('#'));
  const src = (transfer?.getData('text/html') || '').match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  return [uri, src].find(url => /^(blob|data):/i.test(url || '')) || null;
}

// such an image is fetched here, as a file, and uploaded and placed as a pasted one is; nothing happens if it can't be read (eg. a `blob:` from another tab) or isn't an image, video or audio
async function uploadAndPlaceUrl(hook, url) {
  try {
    const blob = await (await fetch(url)).blob();
    if (!PLACEABLE.test(blob.type)) return;
    const ext = blob.type.split('/')[1]?.split(/[+;]/)[0] || 'bin';
    await uploadAndPlace(hook, [new File([blob], `pasted.${ext}`, { type: blob.type })]);
  } catch (error) {
    console.warn('[milkdown] could not read a dropped or pasted image', url.slice(0, 60), error);
  }
}

// A placed file goes on a line of its own, as the body needs it to show as media (a URL that ends its line, see `Bonfire.Common.Text.markdown_parts/3`): text before the cursor stays on the line before, and the cursor goes to the start of the line after, so what's typed next goes there. False where the cursor isn't in a line of text, for `insert` to do it.
function placeAsBlocks(view, doc) {
  if (!doc?.content.size) return false;
  const tr = view.state.tr.deleteSelection();
  let $pos = tr.selection.$from;
  if (!$pos.parent.isTextblock || $pos.depth < 1) return false;

  if ($pos.parentOffset > 0) {
    tr.split($pos.pos);
    $pos = tr.doc.resolve(tr.mapping.map($pos.pos));
  }

  const cursor = $pos.pos;
  tr.insert($pos.before(), doc.content);
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(tr.steps.length - 1).map(cursor)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

// the ref of each upload by its content, to find a file pasted again; emptied when the composer resets (its uploads are gone once published)
const refsByHash = new Map();

// null where the page can't hash (`crypto.subtle` is only there over https or on localhost): such files are always uploaded
async function contentHash(file) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function handleServerEvent(hook, name, payload) {
  switch (name) {
    case 'mention_suggestions': return handleMentionSuggestions(hook, payload);
    case 'smart_input:reset': return handleReset(hook);
    case 'focus-editor':
      if (payload?.to === 'smart_input' && !hook.el.closest('#smart_input_container')) return; // floating composer only
      if (payload?.reply_to) return focusOnceReplying(hook, payload.reply_to); // it can arrive before PersistentLive opens the reply
      return hook.editor?.action(ctx => ctx.get(editorViewCtx).focus());
    case 'insert_at_cursor':
      if (!hook.editor || typeof payload.text !== 'string' || !payload.text) return;
      return hook.editor.action(ctx => {
        const view = ctx.get(editorViewCtx);
        // `markdown: true` parses the text into nodes (eg. an uploaded file placed as `![](upload:<ref>)`), on lines of their own; else it goes in as typed
        if (payload.markdown) placeAsBlocks(view, ctx.get(parserCtx)(payload.text)) || insert(payload.text)(ctx);
        else view.dispatch(view.state.tr.insertText(payload.text));
        view.focus();
      });
  }
}

function handleMentionSuggestions(hook, payload) {
  const text = payload.text || payload.name?.text;
  if (!hook.editor || typeof text !== 'string' || !text) return;
  const isUrl = /^https?:\/\//i.test(text.trim());
  const formatted = isUrl || text.startsWith('@') ? text : '@' + text;
  hook.editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    const { state } = view;
    if (isUrl && state.doc.textContent.trim()) {
      view.dispatch(state.tr.insertText(formatted));
    } else {
      // Reply suggestions intentionally replace the composer; quote URLs append to existing content.
      const value = formatted.endsWith(' ') ? formatted : formatted + ' ';
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(value));
      const tr = state.tr.replaceWith(0, state.doc.content.size, paragraph);
      tr.setSelection(TextSelection.create(tr.doc, value.length + 1));
      view.dispatch(tr);
    }
    view.focus();
  });
}

// smart_input:reset: clear, then unlock
function handleReset(hook) {
  const form = getComposerRoot(hook);
  const titleInput = form.querySelector('#smart_input_post_title input');
  const cwInput = form.querySelector('#smart_input_summary textarea[name="post[post_content][summary]"]');
  if (titleInput) titleInput.value = '';
  if (cwInput) cwInput.value = '';
  refsByHash.clear();
  if (hook.editor) {
    hook.editor.action(replaceAll(''));
    hook._flushEditor?.();
  }
  releaseReset(hook);
}

export function reconnect(hook) {
  releaseReset(hook);
  if (!hook.editor) return;
  hook._flushEditor?.(false);
  const hiddenInput = hook.el.querySelector('#editor_hidden_input');
  if (hiddenInput) notifyServer(hiddenInput);
}

export async function destroy(hook) {
  if (hook._emojiButton) {
    hook._emojiButton.removeEventListener('click', hook._emojiButtonHandler);
    hook._emojiButton = null;
    hook._emojiButtonHandler = null;
  }
  hook._currentPicker?.remove();
  hook._currentPicker = null;
  if (hook._guardReplyOverDraft) document.removeEventListener('click', hook._guardReplyOverDraft, true);
  if (hook._keepFocus) document.removeEventListener('mousedown', hook._keepFocus, true);
  clearTimeout(hook._focusReplyTimer);
  if (hook._followCaret) {
    window.visualViewport?.removeEventListener('resize', hook._followCaret);
    hook.el.removeEventListener('paste', hook._followCaret);
  }
  clearTimeout(hook._followCaretTimer);
  hook._sendLock?.disconnect();
  hook._sendContainer?.removeAttribute('data-sending'); // nothing else clears it (JS.ignore_attributes)
  const editor = hook.editor;
  hook.editor = null;
  await editor?.destroy();
}
