// Heavy Milkdown editor implementation, built as a SEPARATE esbuild ESM bundle
// (see `build.milkdown` in bonfire_ui_common/assets/package.json) and loaded
// on demand by the thin `milkdown.hooks.js` shim via dynamic `import()`.
//
// Keeping all of `@milkdown/*` + ProseMirror + `emoji-picker-element` out of the
// main bundle (~570kb) and only fetching it when the composer actually mounts.
//
// These functions operate on the LiveView hook instance (`hook` === `this` in the
// shim), which holds the editor + per-instance state, exactly as before.

import {
  defaultValueCtx,
  editorViewOptionsCtx,
  Editor,
  editorViewCtx,
  parserCtx,
  rootCtx,
  schemaCtx,
  serializerCtx,
} from "@milkdown/core";
import { trailing } from '@milkdown/kit/plugin/trailing'
import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
import {
  replaceAll,
  $prose,
  $inputRule
} from "@milkdown/utils";
import {
  commonmark,
  headingAttr,
  linkSchema
} from "@milkdown/preset-commonmark";
import { InputRule } from "@milkdown/prose/inputrules";
import { DOMParser, DOMSerializer } from "@milkdown/prose/model";
// NOTE: @milkdown/plugin-emoji intentionally dropped — it pulled in
// emojilib/twemoji/emoji-regex (~240kb) just for inline `:shortcode:` → emoji
// conversion, while the composer already provides emoji entry via the
// emoji-picker-element button (see initEmojiPicker below). Re-add it here and in
// the `.use(...)` chain if inline shortcode conversion is wanted back.
import {
  listener,
  listenerCtx
} from "@milkdown/plugin-listener";
import {
  SlashProvider,
  slashFactory
} from "@milkdown/plugin-slash";
import { clipboard } from '@milkdown/kit/plugin/clipboard'

import {
  Plugin,
  PluginKey
} from "@milkdown/prose/state";
import {
  Decoration,
  DecorationSet
} from "@milkdown/prose/view";
// Side-effect import registers the <emoji-picker> custom element (guarded
// internally against double-define). We instantiate it via
// document.createElement (see initEmojiPicker) rather than `new Picker()`:
// emoji-picker-element is also bundled in the main app bundle (emoji reactions),
// and only the first-loaded copy's class is registered with customElements, so
// `new Picker()` from this lazy bundle's unregistered class throws
// "Illegal constructor". createElement always uses the registered class.
import 'emoji-picker-element';

// Placeholder Plugin - adds class to empty paragraph, CSS ::before shows text
const PlaceholderPlugin = new Plugin({
  key: new PluginKey("milkdown-placeholder"),
  props: {
    decorations: (state) => {
      if (state.doc.textContent.trim().length > 0) return null;

      const decorations = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.content.size === 0) {
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: 'is-empty',
              'data-placeholder': 'Write something...'
            })
          );
          return false; // Only first empty paragraph
        }
      });

      return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
    },
  },
});
const placeholder = $prose(() => PlaceholderPlugin);

// Input rule for `[text](url)` -> link mark.
// CommonMark preset ships the link schema but no input rule; automd was removed
// because its buffer round-trip broke @mention underscore escaping. This targeted
// rule only fires on the closing `)` keystroke and never touches mention text.
const linkInputRule = $inputRule((ctx) => new InputRule(
  /\[([^\]]+)\]\((\S+)\)$/,
  (state, match, start, end) => {
    const [, text, href] = match;
    if (!text || !href) return null;
    const mark = linkSchema.type(ctx).create({ href, title: null });
    // Preserve the user's prior stored marks (e.g. an active bold) but do NOT
    // let the link mark itself stick to the cursor — otherwise everything they
    // type after the link continues the link, and undo+retype inherits it too.
    // Mirrors @milkdown/prose markRule's setStoredMarks(initialStoredMarks) behavior.
    const initialStoredMarks = state.storedMarks ?? [];
    return state.tr
      .replaceWith(start, end, state.schema.text(text, [mark]))
      .setStoredMarks(initialStoredMarks);
  },
));

function pasteMarkdownPlainText(ctx, view, event) {
  const text = event.clipboardData?.getData("text/plain");
  if (!text || !/\[[^\]\n]+\]\([^)]+\)/.test(text)) return false;

  const doc = ctx.get(parserCtx)(text);
  if (!doc || typeof doc === "string") return false;

  const schema = ctx.get(schemaCtx);
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
  const slice = DOMParser.fromSchema(schema).parseSlice(dom);

  event.preventDefault();
  view.dispatch(view.state.tr.replaceSelection(slice));
  return true;
}

function serializeMarkdownForSubmit(ctx, doc) {
  const serializer = ctx.get(serializerCtx);
  let markdownContent = serializer(doc);

  markdownContent = markdownContent.replace(/ /g, ' ');
  markdownContent = markdownContent.replace(/​/g, '');
  markdownContent = markdownContent.replace(
    /(https?:\/\/[^\s)\]]+)/g,
    (url) => url.replace(/\\([&_*~`#=?])/g, '$1')
  );
  markdownContent = markdownContent.replace(/@[a-zA-Z0-9_\\-]*\\\_[a-zA-Z0-9_\\-]*/g, (match) => {
    return match.replace(/\\_/g, '_');
  });
  markdownContent = markdownContent.replace(/^\\#([\wÀ-ɏḀ-ỿ]+)/gm, '#$1');
  markdownContent = markdownContent.replace(/\n\\#([\wÀ-ɏḀ-ỿ]+)/g, '\n#$1');

  return markdownContent;
}

// Debounced fetch for autocomplete - accepts hook instance for state management
function getFeedItems(queryText, prefix, hookInstance) {
  if (!queryText?.length) return Promise.resolve([]);

  // Clear previous timeout using instance state
  if (hookInstance?._searchTimeout) {
    clearTimeout(hookInstance._searchTimeout);
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      fetch("/api/tag/autocomplete/ck5/" + prefix + "/" + queryText)
        .then(response => {
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
        })
        .then(data => {
          resolve(data.map(item => ({
            id: item.id,
            value: item.name,
            icon: item.icon,
          })));
        })
        .catch(error => {
          console.error("Tag search error for query '" + queryText + "':", error);
          resolve([]);
        });
    }, 100); // 100ms debounce to reduce API requests

    // Store timeout ID on instance for cleanup
    if (hookInstance) {
      hookInstance._searchTimeout = timeoutId;
    }
  });
}

// Simple helper to ensure mention starts with @
function formatMention(mention) {
  return mention.startsWith('@') ? mention : '@' + mention;
}

function getMentionMatchInfo(view) {
  if (!view || !view.state) return null;

  const { state } = view;
  const { selection } = state;
  const { from } = selection;
  const textBeforeCursor = state.doc.textBetween(Math.max(0, from - 50), from);
  const match = textBeforeCursor.match(/@([\w.-]+(?:@[\w.-]*)?)$/);

  if (!match) return null;

  const query = match[1];
  if (query.length < 2 && !query.includes('@')) return null;

  return { from, fullMatchLength: match[0].length, query };
}

// Create mention item DOM element safely (prevents XSS from user-controlled data)
// matchInfo contains position data for accurate text replacement
function createMentionItem(item, matchInfo) {
  const li = document.createElement('li');
  li.className = 'rounded-none';

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.mention = item.id || '';
  button.dataset.from = matchInfo?.from ?? '';
  button.dataset.matchLength = matchInfo?.fullMatchLength ?? '';
  button.className = 'mention_btn rounded-none w-full flex items-center';

  const wrapper = document.createElement('div');
  wrapper.className = 'flex items-center gap-3 w-full pointer-events-none';

  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'flex-shrink-0';

  const img = document.createElement('img');
  img.className = 'h-8 w-8 rounded-full';
  img.alt = '';
  // Validate icon URL to prevent javascript: or data: exploits
  const iconUrl = item.icon || '';
  if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://') || iconUrl.startsWith('/')) {
    img.src = iconUrl;
  }
  imgWrapper.appendChild(img);

  const textWrapper = document.createElement('div');
  textWrapper.className = 'gap-0 items-start flex flex-col';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'text-sm truncate max-w-[240px] text-base-content font-semibold';
  nameDiv.textContent = item.value || ''; // textContent is safe from XSS

  const idDiv = document.createElement('div');
  idDiv.className = 'text-xs truncate max-w-[240px] text-base-content/70 font-regular';
  idDiv.textContent = item.id || ''; // textContent is safe from XSS

  textWrapper.appendChild(nameDiv);
  textWrapper.appendChild(idDiv);
  wrapper.appendChild(imgWrapper);
  wrapper.appendChild(textWrapper);
  button.appendChild(wrapper);
  li.appendChild(button);

  return li;
}

// Creates the mentions plugin view - accepts hookInstance for state management
function createMentionsPluginView(hookInstance) {
  return function mentionsPluginView(view) {
    // Create a simple container
    const content = document.createElement("ul");
    content.tabIndex = 1;
    content.className = "milkdown-menu menu z-[9999] shadow-sm bg-base-100 border border-base-content/10 w-72 absolute rounded-xl top-0 left-0 hidden";

    // Event delegation: single click handler on container (fixes memory leak)
    // Position data is stored per-button to handle race conditions
    const handleMentionClick = (event) => {
      const button = event.target.closest('.mention_btn');
      if (!button) return;

      const mention = button.dataset.mention;
      const from = parseInt(button.dataset.from, 10);
      const matchLength = parseInt(button.dataset.matchLength, 10);
      if (!mention || isNaN(from) || isNaN(matchLength)) return;

      const startPos = from - matchLength;
      const formattedMention = formatMention(mention);

      // Replace text
      view.dispatch(
        view.state.tr
          .delete(startPos, from)
          .insertText(`${formattedMention} `)
      );

      // Hide dropdown and focus editor
      provider.hide();
      view.focus();
    };

    content.addEventListener('click', handleMentionClick);

    let activeQuery = null;
    let activeItems = [];
    let pendingQuery = null;
    let requestSeq = 0;

    const renderMentionItems = (items, matchInfo) => {
      content.innerHTML = "";

      const maxItems = Math.min(items.length, 4);
      for (let i = 0; i < maxItems; i++) {
        content.appendChild(createMentionItem(items[i], matchInfo));
      }
    };

    // Create provider with minimal configuration
    const provider = new SlashProvider({
      content,
      trigger: "@",
      shouldShow: (view, prevState) => {
        // Skip dropdown when inserting mentions programmatically
        if (hookInstance?._mentionDropdownState?.skipNext) {
          hookInstance._mentionDropdownState.skipNext = false;
          return false;
        }

        // Check for data attribute to disable mentions
        const disableMentions =
          view.dom.closest('[data-disable-mentions]')?.getAttribute('data-disable-mentions') === "true";

        if (disableMentions || !view || !view.state) return false;

        const matchInfo = getMentionMatchInfo(view);
        if (!matchInfo) {
          activeQuery = null;
          activeItems = [];
          pendingQuery = null;
          return false;
        }

        if (matchInfo.query === activeQuery && activeItems.length > 0) {
          renderMentionItems(activeItems, matchInfo);
          return true;
        }

        if (matchInfo.query !== pendingQuery) {
          pendingQuery = matchInfo.query;
          const seq = ++requestSeq;

          getFeedItems(matchInfo.query, "@", hookInstance).then(items => {
            if (seq !== requestSeq) return;

            const latestMatch = getMentionMatchInfo(view);
            if (!latestMatch || latestMatch.query !== matchInfo.query) return;

            activeQuery = matchInfo.query;
            activeItems = items || [];

            if (activeItems.length > 0) {
              renderMentionItems(activeItems, latestMatch);
              provider.update(view);
            } else {
              provider.hide();
            }
          });
        }

        return false;
      }
    });

    return {
      update: (updatedView, prevState) => {
        provider.update(updatedView, prevState);
      },
      destroy: () => {
        requestSeq++;
        // Clean up event listener (prevents memory leak)
        content.removeEventListener('click', handleMentionClick);
        provider.destroy();
        content.remove();
      }
    };
  };
}

function getComposerRoot(hookInstance) {
  return hookInstance?.el?.closest('form') || hookInstance?.el || document;
}

// Initialize emoji picker lazily (only when needed)
// Accepts hookInstance for state management
function initEmojiPicker(editor, hookInstance) {
  const pickerContainer = getComposerRoot(hookInstance).querySelector('#emoji-picker-in-composer');

  // Skip if container not found
  if (!pickerContainer) {
    console.info('Emoji picker container not found');
    return;
  }

  // Skip if picker already initialized (check instance state)
  if (hookInstance?._currentPicker) {
    console.info('Emoji picker already initialized');
    return;
  }

  try {
    // Get custom emojis from data attribute (will be empty "[]" by default for performance)
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
    picker.locale = 'en';
    picker.customEmoji = customEmoji;

    // Store on instance for cleanup
    if (hookInstance) {
      hookInstance._currentPicker = picker;
    }

    pickerContainer.appendChild(picker);

    // Recalculate tooltip position after picker database is ready
    picker.addEventListener('emoji-ready', () => {
      if (pickerContainer._updatePosition) {
        pickerContainer._updatePosition();
        console.log('Emoji picker position recalculated after data load');
      }
    }, { once: true });

    // Handle emoji selection
    picker.addEventListener('emoji-click', event => {
      const { unicode, emoji } = event.detail;

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);

        // Use shortcode only when unicode is missing
        const text = !unicode && emoji?.shortcodes?.[0]
          ? emoji.shortcodes[0]
          : unicode || '';

        if (!text) {
          console.warn('No valid emoji text to insert');
          return;
        }

        try {
          // Insert the emoji text
          view.dispatch(view.state.tr.insertText(text + " "));
          view.focus();
        } catch (error) {
          console.error('Failed to insert emoji:', error);
        }
      });
    });

    console.log('Emoji picker initialized successfully with', customEmoji.length, 'custom emojis');
  } catch (error) {
    console.error('Error initializing emoji picker:', error);
  }
}

// Setup lazy initialization for emoji picker (triggered by button click)
// Stores listener reference on hookInstance for cleanup
function setupLazyEmojiPicker(editor, hookInstance) {
  const emojiButton = getComposerRoot(hookInstance).querySelector('.emoji-button');

  if (!emojiButton) {
    console.info('Emoji button not found, skipping lazy initialization');
    return;
  }

  // Create named handler so we can remove it later
  const handleEmojiButtonClick = () => {
    // Only initialize once (check instance state)
    if (!hookInstance?._currentPicker) {
      console.log('Emoji button clicked, initializing picker...');
      initEmojiPicker(editor, hookInstance);
    }
  };

  emojiButton.addEventListener('click', handleEmojiButtonClick);

  // Store references for cleanup
  if (hookInstance) {
    hookInstance._emojiButton = emojiButton;
    hookInstance._emojiButtonHandler = handleEmojiButtonClick;
  }

  console.log('Emoji picker lazy initialization setup complete');
}

// Initialize the editor on the given hook instance. Resolves once the editor
// actually exists, so the caller (the shim) can safely flush queued server events.
async function initEditor(hook, hiddenInput, container) {
  // Create simple slash factory for mentions
  const mentionSlash = slashFactory("mention-slash");

  // Defer one tick so the container is settled in the DOM before ProseMirror
  // mounts. Awaited by mountEditor so the hook only flips to "ready" once the
  // editor exists, letting the shim safely flush any queued server events.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Create and configure the editor
  hook.editor = await Editor.make()
    .config((ctx) => {
      // Set root element - using the actual container element
      ctx.set(rootCtx, container);

      // Set initial content from hidden input if available
      ctx.set(defaultValueCtx, hiddenInput.value || "");

      // Configure heading styles
      const headingStyles = {
        1: 'text-3xl', 2: 'text-2xl', 3: 'text-xl',
        4: 'text-lg', 5: 'text-base', 6: 'text-base'
      };
      ctx.set(headingAttr.key, (node) => ({
        class: `${headingStyles[node.attrs.level] || 'text-base'} no-margin-top`,
        "data-el-type": node.attrs.level <= 4 ? 'h3' : 'h4',
        id: null
      }));

      // Configure editor view options
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: {
          class: 'milkdown-editor relative mx-auto focus:outline-hidden h-full p-2 prose prose-bonfire break-normal max-w-none text-base-content prose-hr:!my-2 prose-br:hidden',
          spellcheck: 'false',
          placeholder: "Type your text here..."
        },
        handlePaste: (view, event) => {
          // Block pasting files or images
          const hasFiles = event.clipboardData.files.length > 0;
          const hasImages = Array.from(event.clipboardData.items).some(
            item => item.type.startsWith('image/')
          );
          if (hasFiles || hasImages) {
            event.preventDefault();
            return true;
          }
          if (pasteMarkdownPlainText(ctx, view, event)) return true;
          return false;
        }
      }));

      // Configure mentions slash provider (pass hook for state management)
      ctx.set(mentionSlash.key, {
        view: createMentionsPluginView(hook),
      });
    })
    .use(commonmark)    // Basic Markdown support - required for document schema
    .use(indent)
    .use(trailing)
    .use(clipboard)     // Parse pasted plain-text markdown
    .use(listener)
    .use(history)       // Undo/redo support
    .use(mentionSlash)  // Mentions support
    .use(linkInputRule) // [text](url) -> link
    .use(placeholder)   // Placeholder support
    .create();

  // The composer may have been torn down while the editor was being created
  // (async create racing a fast unmount). If so, destroy it immediately rather
  // than wiring listeners/emoji-picker onto an orphan that destroy() already
  // skipped (it ran when hook.editor was still null).
  if (hook._destroyed) {
    hook.editor.destroy();
    hook.editor = null;
    return;
  }

  // Set up content listener using Milkdown's built-in listener
  hook.editor.action((ctx) => {
    const listener = ctx.get(listenerCtx);

    // Debounce updates to avoid excessive calls
    listener.updated((ctx, doc, prevDoc) => {
      // Skip if document hasn't actually changed
      if (!doc || doc.eq && doc.eq(prevDoc)) return;

      // Debounce the update
      clearTimeout(hook._updateTimeout);
      hook._updateTimeout = setTimeout(() => {
        const markdownContent = serializeMarkdownForSubmit(ctx, doc);

        // Update hidden input
        hiddenInput.value = markdownContent;

        // Dispatch input event to notify LiveView
        hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
      }, 100);
    });
  });

  // Setup lazy emoji picker (will initialize on first button click)
  setupLazyEmojiPicker(hook.editor, hook);

  console.log("Milkdown editor initialized successfully");
}

export async function mountEditor(hook) {
  // Initialize instance state
  hook._mentionDropdownState = { skipNext: false };
  const hiddenInput = hook.el.querySelector("#editor_hidden_input");
  const container = hook.el.querySelector("#editor");

  if (!hiddenInput || !container) {
    console.error("Required elements not found for Milkdown editor initialization");
    return;
  }

  // Fall back to data-suggestion attribute for initial value
  if (!hiddenInput.value && hook.el.dataset.suggestion) {
    hiddenInput.value = hook.el.dataset.suggestion;
  }

  const draft = window.Bonfire?.getComposerDraft?.(hiddenInput);
  if (draft) hiddenInput.value = draft;

  await initEditor(hook, hiddenInput, container);
}

// Dispatch a server-pushed event to its handler. Called by the shim once the
// editor is ready; events that arrive during the bundle download are queued by
// the shim and flushed through here, so none are dropped.
export function handleServerEvent(hook, name, payload) {
  switch (name) {
    case "mention_suggestions":
      return handleMentionSuggestions(hook, payload);
    case "smart_input:reset":
      return handleReset(hook);
    case "focus-editor":
      return handleFocusEditor(hook);
    case "insert_at_cursor":
      return handleInsertAtCursor(hook, payload);
  }
}

function handleMentionSuggestions(hook, payload) {
  if (!hook.editor) {
    console.warn("Cannot handle mention_suggestions: Editor not initialized yet");
    return;
  }

  // Support both payload structures
  const text = payload.text || (payload.name && payload.name.text);

  if (!text || typeof text !== 'string') {
    console.warn("Received mention_suggestions event with invalid payload:", payload);
    return;
  }

  // Check if this is a mention (starts with @) or a URL (for quotes)
  const isUrl = text.trim().startsWith('http');
  const formattedText = isUrl ? text : formatMention(text);

  // Check if there's existing content
  const hiddenInput = hook.el.querySelector("#editor_hidden_input");
  const existingContent = hiddenInput ? hiddenInput.value.trim() : '';

  if (existingContent && isUrl) {
    // For URLs with existing content, insert at cursor position
    hook.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(formattedText));
      view.focus();
    });
  } else {
    // For mentions or empty content, replace all content
    // Ensure trailing space is preserved for continued typing
    const textWithSpace = formattedText.endsWith(' ') ? formattedText : formattedText + ' ';

    // Prevent mention dropdown from appearing when inserting mentions programmatically
    hook._mentionDropdownState.skipNext = true;

    hook.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;

      // ProseMirror normalizes trailing whitespace in text nodes, so we append
      // a zero-width space to preserve the trailing space for user typing.
      // The zero-width space acts as an anchor and is removed when user types.
      const textWithZWS = textWithSpace + '​';

      // Create properly structured content (ProseMirror requires block-level nodes)
      const paragraph = state.schema.nodes.paragraph.create(
        null,
        state.schema.text(textWithZWS)
      );

      // Replace entire document content with the new paragraph
      const tr = state.tr.replaceWith(0, state.doc.content.size, paragraph);

      // Position cursor after trailing space but before zero-width space
      // Position calculation: 1 (paragraph opening tag) + text length with space
      const cursorPos = textWithSpace.length + 1;
      tr.setSelection(state.selection.constructor.near(tr.doc.resolve(cursorPos)));

      view.dispatch(tr);
      view.focus();

      // Hide any visible mention dropdown
      const mentionDropdown = document.querySelector('.milkdown-menu');
      if (mentionDropdown && !mentionDropdown.classList.contains('hidden')) {
        mentionDropdown.classList.add('hidden');
      }
    });
  }
}

function handleReset(hook) {
  // Clear title and content warning fields
  const form = hook.el.closest('form') || document;
  const titleInput = form.querySelector('#smart_input_post_title input');
  const cwInput = form.querySelector('#smart_input_summary textarea[name="post[post_content][summary]"]');
  if (titleInput) titleInput.value = '';
  if (cwInput) cwInput.value = '';

  if (hook.editor) {
    hook.editor.action(replaceAll(""));
  }
}

function handleFocusEditor(hook) {
  hook.editor?.action((ctx) => ctx.get(editorViewCtx).focus());
}

function handleInsertAtCursor(hook, payload) {
  if (!hook.editor || !payload.text) return;

  hook.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    view.dispatch(view.state.tr.insertText(payload.text));
    view.focus();
  });
}

// Equivalent to the previous hook `updated()`.
export function syncFromServer(hook) {
  const hiddenInput = hook.el.querySelector("#editor_hidden_input");
  if (!hook.editor || !hiddenInput) return;

  // Only sync if the server pushed a different value than what the editor has
  const serializer = hook.editor.ctx?.get?.(serializerCtx);
  if (!serializer) return;

  hook.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const currentMarkdown = serializeMarkdownForSubmit(ctx, view.state.doc);
    if (currentMarkdown.trim() !== hiddenInput.value.trim()) {
      replaceAll(hiddenInput.value)(ctx);
    }
  });
}

// Equivalent to the previous hook `reconnected()`.
export function reconnect(hook) {
  if (!hook.editor) return;
  const hiddenInput = hook.el.querySelector("#editor_hidden_input");
  if (hiddenInput) {
    hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// Equivalent to the previous hook `destroyed()`.
export function destroy(hook) {
  // Clear any pending timeouts
  if (hook._updateTimeout) {
    clearTimeout(hook._updateTimeout);
    hook._updateTimeout = null;
  }
  if (hook._searchTimeout) {
    clearTimeout(hook._searchTimeout);
    hook._searchTimeout = null;
  }

  // Remove emoji button listener (prevents memory leak)
  if (hook._emojiButton && hook._emojiButtonHandler) {
    hook._emojiButton.removeEventListener('click', hook._emojiButtonHandler);
    hook._emojiButton = null;
    hook._emojiButtonHandler = null;
  }

  // Clean up emoji picker
  if (hook._currentPicker) {
    hook._currentPicker.remove();
    hook._currentPicker = null;
  }

  // Destroy editor
  if (hook.editor) {
    hook.editor.destroy();
    hook.editor = null;
  }

  hook._mentionDropdownState = null;
}
