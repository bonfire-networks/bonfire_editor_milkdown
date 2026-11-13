// Loaded on demand by milkdown.hooks.js; build.ext keeps Milkdown and ProseMirror in one bundle.
import {
  defaultValueCtx,
  editorViewOptionsCtx,
  Editor,
  editorViewCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { history } from '@milkdown/kit/plugin/history';
import { indent } from '@milkdown/kit/plugin/indent';
import { replaceAll, $prose } from '@milkdown/utils';
import { commonmark, hardbreakSchema, headingAttr, linkSchema } from '@milkdown/preset-commonmark';
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
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          if (data.files.length || Array.from(data.items).some(item => item.type.startsWith('image/'))) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      }));
    })
    .use(commonmark)
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
        view.dispatch(view.state.tr.insertText(payload.text));
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
