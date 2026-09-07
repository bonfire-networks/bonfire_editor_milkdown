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
import { replaceAll, $prose, $inputRule } from '@milkdown/utils';
import { commonmark, headingAttr, linkSchema } from '@milkdown/preset-commonmark';
import { InputRule } from '@milkdown/prose/inputrules';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { createMentionsPlugin } from './mentions.js';
import { createContentSyncPlugin } from './content_sync.js';
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

// commonmark has a link schema but no link input rule; a targeted rule avoids reparsing mention text.
const linkInputRule = $inputRule(ctx => new InputRule(
  /\[([^\]]+)\]\((\S+)\)$/,
  (state, match, start, end) => {
    const [, text, href] = match;
    const mark = linkSchema.type(ctx).create({ href, title: null });
    const initialStoredMarks = state.storedMarks ?? [];
    return state.tr
      .replaceWith(start, end, state.schema.text(text, [mark]))
      .setStoredMarks(initialStoredMarks);
  },
));

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
      ctx.update(editorViewOptionsCtx, previous => ({
        ...previous,
        attributes: {
          class: 'milkdown-editor relative mx-auto focus:outline-hidden h-full p-2 prose prose-bonfire break-normal max-w-none text-base-content prose-hr:!my-2 prose-br:hidden',
          spellcheck: 'false',
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
    .use(linkInputRule)
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

export async function mountEditor(hook) {
  const hiddenInput = hook.el.querySelector('#editor_hidden_input');
  const container = hook.el.querySelector('#editor');
  if (!hiddenInput || !container) throw new Error('Milkdown composer is missing its input or editor container');

  if (!hiddenInput.value && hook.el.dataset.suggestion) hiddenInput.value = hook.el.dataset.suggestion;
  const draft = window.Bonfire?.getComposerDraft?.(hiddenInput);
  if (draft) hiddenInput.value = draft;
  await initEditor(hook, hiddenInput, container);
  if (hook._destroyed) return;
  if (hiddenInput.value) hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
}

export function handleServerEvent(hook, name, payload) {
  switch (name) {
    case 'mention_suggestions': return handleMentionSuggestions(hook, payload);
    case 'smart_input:reset': return handleReset(hook);
    case 'focus-editor': return hook.editor?.action(ctx => ctx.get(editorViewCtx).focus());
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
}

export function reconnect(hook) {
  if (!hook.editor) return;
  hook._flushEditor?.(false);
  hook.el.querySelector('#editor_hidden_input')?.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function destroy(hook) {
  if (hook._emojiButton) {
    hook._emojiButton.removeEventListener('click', hook._emojiButtonHandler);
    hook._emojiButton = null;
    hook._emojiButtonHandler = null;
  }
  hook._currentPicker?.remove();
  hook._currentPicker = null;
  const editor = hook.editor;
  hook.editor = null;
  await editor?.destroy();
}
