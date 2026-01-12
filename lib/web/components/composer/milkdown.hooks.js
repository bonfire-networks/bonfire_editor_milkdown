import {
  defaultValueCtx,
  editorViewOptionsCtx,
  Editor,
  editorViewCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/core";
// import { automd } from '@milkdown/plugin-automd'; // Removed: causes underscore escaping issues with mentions
import { trailing } from '@milkdown/kit/plugin/trailing'

// import { 
//   nord 
// } from "@milkdown/theme-nord";

import { history } from '@milkdown/kit/plugin/history'
import { indent } from '@milkdown/kit/plugin/indent'
// import { getMarkdown } from '@milkdown/utils'
import { 
  replaceAll,
  $prose
} from "@milkdown/utils";
import {
  commonmark, 
  headingAttr
} from "@milkdown/preset-commonmark";
// Removed GFM preset to prevent email autolink conflicts with ActivityPub mentions
// import { 
//   gfm,
//   remarkGFMPlugin 
// } from "@milkdown/preset-gfm";
import { 
  emoji 
} from "@milkdown/plugin-emoji";
import { 
  listener,
  listenerCtx
} from "@milkdown/plugin-listener";
import { 
  SlashProvider, 
  slashFactory 
} from "@milkdown/plugin-slash";
// import { 
//   clipboard,
//   clipboardPlugin 
// } from "@milkdown/plugin-clipboard";
// Removed unist-util-visit import since GFM preset was removed
// import { visit } from 'unist-util-visit';

import { 
  Plugin, 
  PluginKey 
} from "@milkdown/prose/state";
import { 
  Decoration, 
  DecorationSet 
} from "@milkdown/prose/view";
import 'emoji-picker-element';
import { 
  Picker 
} from 'emoji-picker-element';

// import "@milkdown/theme-nord/style.css";

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

// GFM preset removed to prevent email autolink conflicts with ActivityPub mentions
// Editor now uses basic CommonMark which is sufficient for social media posts

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
    content.className = "milkdown-menu menu z-[9999] shadow-sm bg-base-100 border border-base-content/20 w-72 absolute rounded-xl top-0 left-0 hidden";

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

        const { state } = view;
        const { selection } = state;
        const { from } = selection;

        // Get text before cursor (increase range to handle longer remote mentions)
        const textBeforeCursor = state.doc.textBetween(Math.max(0, from - 50), from);

        // Match @pattern for both local and remote (ActivityPub) mentions
        const match = textBeforeCursor.match(/@([\w.-]+(?:@[\w.-]*)?)$/);

        // If no match is found or pattern is too short, don't show dropdown
        if (!match) return false;

        // Check minimum length (2 chars for local, or contains @ for remote)
        const mentionPart = match[1];
        if (mentionPart.length < 2 && !mentionPart.includes('@')) return false;

        const matchInfo = { from, fullMatchLength: match[0].length };

        // Fetch matching items (pass hookInstance for timeout management)
        return getFeedItems(mentionPart, "@", hookInstance).then(items => {
          // Clear previous content
          content.innerHTML = "";

          // Don't show if no results
          if (!items?.length) return false;

          // Render items with position data (prevents race condition bugs)
          const maxItems = Math.min(items.length, 4);
          for (let i = 0; i < maxItems; i++) {
            content.appendChild(createMentionItem(items[i], matchInfo));
          }

          return true;
        });
      }
    });

    return {
      update: (updatedView, prevState) => {
        provider.update(updatedView, prevState);
      },
      destroy: () => {
        // Clean up event listener (prevents memory leak)
        content.removeEventListener('click', handleMentionClick);
        provider.destroy();
        content.remove();
      }
    };
  };
}

// Initialize emoji picker lazily (only when needed)
// Accepts hookInstance for state management
function initEmojiPicker(editor, hookInstance) {
  const pickerContainer = document.querySelector('#emoji-picker-in-composer');

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

    const picker = new Picker({
      locale: 'en',
      customEmoji,
      referenceElement: pickerContainer,
      triggerElement: pickerContainer,
      emojiSize: "1.75rem",
    });

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
  const emojiButton = document.querySelector('.emoji-button');

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

// Create Milkdown Hook following Phoenix LiveView patterns
export default {
  // Store for editor state
  editor: null,
  _updateTimeout: null,
  _searchTimeout: null,
  _currentPicker: null,
  _mentionDropdownState: null,
  _emojiButton: null,
  _emojiButtonHandler: null,

  mounted() {
    console.log("Milkdown hook mounted");
    // Initialize instance state
    this._mentionDropdownState = { skipNext: false };
    const hiddenInput = document.getElementById("editor_hidden_input");
    const container = this.el.querySelector("#editor");

    if (!hiddenInput || !container) {
      console.error("Required elements not found for Milkdown editor initialization");
      return;
    } 

      // Register event handlers in mounted (per Phoenix LiveView docs)
      this.handleEvent("mention_suggestions", (payload) => {
        if (!this.editor) {
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
        const hiddenInput = document.getElementById("editor_hidden_input");
        const existingContent = hiddenInput ? hiddenInput.value.trim() : '';

        if (existingContent && isUrl) {
          // For URLs with existing content, insert at cursor position
          this.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insertText(formattedText));
            view.focus();
          });
        } else {
          // For mentions or empty content, replace all content
          // Ensure trailing space is preserved for continued typing
          const textWithSpace = formattedText.endsWith(' ') ? formattedText : formattedText + ' ';

          // Prevent mention dropdown from appearing when inserting mentions programmatically
          this._mentionDropdownState.skipNext = true;

          this.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;

            // ProseMirror normalizes trailing whitespace in text nodes, so we append
            // a zero-width space to preserve the trailing space for user typing.
            // The zero-width space acts as an anchor and is removed when user types.
            const textWithZWS = textWithSpace + '\u200B';

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
      });
      
      this.handleEvent("smart_input:reset", () => {
        // Clear title and content warning fields
        const titleInput = document.querySelector('#smart_input_post_title input');
        const cwInput = document.querySelector('#smart_input_summary input[name="post[post_content][summary]"]');
        if (titleInput) titleInput.value = '';
        if (cwInput) cwInput.value = '';

        if (this.editor) {
          this.editor.action(replaceAll(""));
        }
      });

      
      this.handleEvent("focus-editor", () => {
        this.editor?.action((ctx) => ctx.get(editorViewCtx).focus());
      });

      this.handleEvent("insert_at_cursor", (payload) => {
        if (!this.editor || !payload.text) return;

        this.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dispatch(view.state.tr.insertText(payload.text));
          view.focus();
        });
      });

    this.initEditor(hiddenInput, container);
  },
  
  // Initialize the editor
  async initEditor(hiddenInput, container) {
      // Create simple slash factory for mentions
      const mentionSlash = slashFactory("mention-slash");
      
      // Initialize with small delay to ensure DOM is ready
      setTimeout(async () => {
        // Create and configure the editor
        this.editor = await Editor.make()
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
                  class: 'milkdown-editor relative mx-auto focus:outline-hidden h-full p-2 prose text-[16px] prose-sm prose-bonfire break-normal max-w-none text-base-content prose-hr:!my-2 prose-br:hidden', 
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
                  return false;
                }
              }));
              
              // Configure mentions slash provider (pass this for state management)
              ctx.set(mentionSlash.key, {
                view: createMentionsPluginView(this),
              });

            })
            // .use(nord)          // Apply Nord theme
            .use(commonmark)    // Basic Markdown support - required for document schema
            // Removed GFM to prevent email autolink conflicts with ActivityPub mentions
            .use(emoji)         // Emoji support
            .use(indent)
            .use(trailing)
            .use(listener)
            .use(history)       // Undo/redo support
            .use(mentionSlash)  // Mentions support
            .use(placeholder)   // Placeholder support
            // .use(automd) // Removed: causes underscore escaping issues with mentions
            .create();
            
          // Set up content listener using Milkdown's built-in listener
          this.editor.action((ctx) => {
            const listener = ctx.get(listenerCtx);
            
            // Debounce updates to avoid excessive calls
            listener.updated((ctx, doc, prevDoc) => {
              // Skip if document hasn't actually changed
              if (!doc || doc.eq && doc.eq(prevDoc)) return;
              
              // Debounce the update
              clearTimeout(this._updateTimeout);
              this._updateTimeout = setTimeout(() => {
                // Get markdown content with proper formatting
                const serializer = ctx.get(serializerCtx);
                let markdownContent = serializer(doc);

                // Normalize non-breaking spaces to regular spaces (ProseMirror uses nbsp internally)
                markdownContent = markdownContent.replace(/\u00A0/g, ' ');

                // Fix escaped characters in plain URLs (serializer escapes special chars)
                // Matches http(s):// URLs and unescapes markdown special characters within them
                markdownContent = markdownContent.replace(
                  /(https?:\/\/[^\s)\]]+)/g,
                  (url) => url.replace(/\\([&_*~`#=?])/g, '$1')
                );

                // Fix escaped underscores in mentions (serializer still escapes them)
                markdownContent = markdownContent.replace(/@[a-zA-Z0-9_\\-]*\\\_[a-zA-Z0-9_\\-]*/g, (match) => {
                  return match.replace(/\\_/g, '_');
                });

                // Fix escaped hashtags at the beginning of lines (serializer escapes # to prevent heading conflicts)
                // Support Unicode and other valid hashtag characters
                markdownContent = markdownContent.replace(/^\\#([\w\u00C0-\u024F\u1E00-\u1EFF]+)/gm, '#$1');
                markdownContent = markdownContent.replace(/\n\\#([\w\u00C0-\u024F\u1E00-\u1EFF]+)/g, '\n#$1');
                
                // Update hidden input
                hiddenInput.value = markdownContent;
                
                // Dispatch input event to notify LiveView
                hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
              }, 100);
            });
          });

          // Setup lazy emoji picker (will initialize on first button click)
          setupLazyEmojiPicker(this.editor, this);


        console.log("Milkdown editor initialized successfully");
      }, 0);
  },

  // Handle content updates
  updated() {
    const hiddenInput = document.getElementById("editor_hidden_input");

    // Only update if content has changed and editor exists
    if (this.editor && hiddenInput) {
      this.editor.action(replaceAll(hiddenInput.value));
    }
  },
  
  // Clean up when component is destroyed
  destroyed() {
    // Clear any pending timeouts
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
      this._updateTimeout = null;
    }
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = null;
    }

    // Remove emoji button listener (prevents memory leak)
    if (this._emojiButton && this._emojiButtonHandler) {
      this._emojiButton.removeEventListener('click', this._emojiButtonHandler);
      this._emojiButton = null;
      this._emojiButtonHandler = null;
    }

    // Clean up emoji picker
    if (this._currentPicker) {
      this._currentPicker.remove();
      this._currentPicker = null;
    }

    // Destroy editor
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }

    this._mentionDropdownState = null;
  },
  
};
