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

// Placeholder Plugin
const PlaceholderPlugin = new Plugin({
  key: new PluginKey("milkdown-placeholder"),
  props: {
    decorations: (state) => {
      const element = document.createElement("span");

      element.classList.add("milkdown-placeholder");
      element.style.position = "absolute";
      element.style.opacity = "0.5";
      element.innerText = "Write something...";

      const placeholderDecoration = Decoration.widget(0, element, {
        key: "milkdown-placeholder",
        side: 0,
      });
      
      if (state.doc.textContent.trim().length === 0) {
        return DecorationSet.create(state.doc, [placeholderDecoration]);
      }
    },
  },
});
const placeholder = $prose(() => PlaceholderPlugin);

// GFM preset removed to prevent email autolink conflicts with ActivityPub mentions
// Editor now uses basic CommonMark which is sufficient for social media posts


// Global reference for the emoji picker to maintain original behavior
let currentPicker = null;

// Add debouncing to reduce API calls
let searchTimeout = null;
function getFeedItems(queryText, prefix) {
  if (!queryText?.length) return Promise.resolve([]);
  
  clearTimeout(searchTimeout);
  return new Promise((resolve) => {
    searchTimeout = setTimeout(() => {
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
    }, 100); // 300ms debounce to reduce API requests
  });
}

// Simple helper to ensure mention starts with @
function formatMention(mention) {
  return mention.startsWith('@') ? mention : '@' + mention;
}

const mentionItemRenderer = (item, text) => {
  return `
    <li class="rounded-none">
      <button type="button" data-mention="${item.id}" data-text="${text}" class="mention_btn rounded-none w-full flex items-center">
        <div class="flex items-center gap-3 w-full pointer-events-none">
          <div class="flex-shrink-0">
            <img class="h-8 w-8 rounded-full" src="${item.icon}" alt="">
          </div>
          <div class="gap-0 items-start flex flex-col" data-id="${item.id}" data-input="${text}">
            <div class="text-sm truncate max-w-[240px] text-base-content font-semibold">${item.value}</div>
            <div class="text-xs truncate max-w-[240px] text-base-content/70 font-regular">${item.id}</div>
          </div>
        </div>
      </button>
    </li>`;
};

function mentionsPluginView(view) {
  // Create a simple container
  const content = document.createElement("ul");
  content.tabIndex = 1;
  content.className = "milkdown-menu menu z-[99999999] menu shadow-sm bg-base-100 border border-base-content/10 w-72 absolute rounded-xl top-0 left-0 hidden";

  // Create provider with minimal configuration
  const provider = new SlashProvider({
    content,
    trigger: "@",
    shouldShow: (view, prevState) => {
      // Dynamically check the attribute each time 
      const disableMentions = 
        view.dom.closest('[data-disable-mentions]')?.getAttribute('data-disable-mentions') === "true"; 

      if (disableMentions || !view || !view.state) return false;
      
      const { state } = view;
      const { selection } = state;
      const { from } = selection;
      
      // Get text before cursor (increase range to handle longer remote mentions)
      const textBeforeCursor = state.doc.textBetween(Math.max(0, from - 50), from);
      
      // Match @pattern for both local and remote (ActivityPub) mentions
      // The regex `@([\w.-]+(?:@[\w.-]*)?)$` ensures:
      // - @ character is present
      // - Followed by username characters (letters, digits, underscore, dot, dash)
      // - Optionally followed by @domain.com for remote mentions (domain part can be empty while typing)
      // - Must have at least 2 chars for local mentions or proper remote format
      const match = textBeforeCursor.match(/@([\w.-]+(?:@[\w.-]*)?)$/);
      
      // If no match is found or pattern is too short, don't show dropdown
      if (!match) return false;
      
      // Check minimum length (2 chars for local, or contains @ for remote)
      const mentionPart = match[1];
      if (mentionPart.length < 2 && !mentionPart.includes('@')) return false;
      
      console.log("Found mention pattern:", match[0]);
      
      // Get the text after @ (without the @ symbol)
      const query = mentionPart;
      // Store the full match for position calculation
      const fullMatch = match[0];
      
      // Fetch matching items
      return getFeedItems(query, "@").then(items => {
        // Don't show if no results
        if (!items || items.length === 0) {
          content.innerHTML = "";
          return false;
        }
        
        // Render items
        let html = "";
        const maxItems = Math.min(items.length, 4);
        
        for (let i = 0; i < maxItems; i++) {
          html += mentionItemRenderer(items[i], query);
        }
        
        content.innerHTML = html;
        
        // Add click handlers to items
        const buttons = content.querySelectorAll('.mention_btn');
        buttons.forEach(button => {
          button.addEventListener('click', () => {
            const mention = button.dataset.mention;
            const text = button.dataset.text;
            
            // Calculate position using the actual match length (includes @)
            const startPos = from - fullMatch.length;
            
            // Format mention to ensure it starts with @
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
          });
        });
        
        return true;
      });
    }
  });

  return {
    update: (updatedView, prevState) => {
      provider.update(updatedView, prevState);
    },
    destroy: () => {
      provider.destroy();
      content.remove();
    }
  };
}

const initEmojiPicker = (editor) => {
  // Skip emoji picker initialization if the container isn't available
  // This allows the editor to work even without the emoji picker
  if (!document.querySelector('.emoji-picker-in-composer')) {
    console.info('Emoji picker container not found');
    return; // Container not found, silently skip initialization
  }
  
  try {
    const pickerContainer = document.querySelector('#emoji-picker-in-composer');
    
    // Clean up any existing picker
    if (currentPicker) {
      currentPicker.remove();
      currentPicker = null;
    }

    // Get custom emojis from data attribute
    let customEmoji = [];
    try {
      const emojisData = pickerContainer.getAttribute('data-emojis');
      if (emojisData) {
        customEmoji = JSON.parse(emojisData);
      }
    } catch (e) {
      console.error('Failed to parse custom emojis:', e);
    }
    
    currentPicker = new Picker({
      locale: 'en',
      customEmoji,
      referenceElement: pickerContainer,
      triggerElement: pickerContainer,
      emojiSize: "1.75rem",
    });

    pickerContainer.appendChild(currentPicker);

    // Handle emoji selection
    currentPicker.addEventListener('emoji-click', event => {
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
  } catch (error) {
    console.error('Error initializing emoji picker:', error);
  }
};

// Create Milkdown Hook following Phoenix LiveView patterns
export default {
  // Store for editor state
  editor: null,
  _updateTimeout: null,
  
  mounted() {
    console.log("Milkdown hook mounted");
    const hiddenInput = document.getElementById("editor_hidden_input");
    const container = this.el.querySelector("#editor");

    if (!hiddenInput || !container) {
      console.error("Required elements not found for Milkdown editor initialization");
      return;
    } 

      // Register event handlers in mounted (per Phoenix LiveView docs)
      this.handleEvent("mention_suggestions", (payload) => {
        console.log("RECEIVED mention_suggestions event with payload:", payload);
        if (!this.editor) {
          console.warn("Cannot handle mention_suggestions: Editor not initialized yet");
          return;
        }
        
        // Support both payload structures
        const text = payload.text || (payload.name && payload.name.text);
        
        if (text) {
          console.log("Processing mention suggestions:", text);

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
            // For mentions or empty content, replace all (existing behavior)
            this.editor.action(replaceAll(""));
            this.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx);
              view.dispatch(view.state.tr.insertText(formattedText + " "));
              view.focus();
            });
          }
        } else {
          console.warn("Received mention_suggestions event with invalid payload:", payload);
        }
      });
      
      this.handleEvent("smart_input:reset", () => {
        console.log("RECEIVED smart_input:reset event");

        // const toggle_button = document.querySelector('#main_smart_input_button .toggle_button');
        // const submitting_icon = document.querySelector('#main_smart_input_button .submitting_icon');

        // // Reset submit button state
        // if (toggle_button && submitting_icon) {
        //   console.log("Resetting submit button state");
        //   toggle_button.classList.remove('hidden');
        //   submitting_icon.classList.add('hidden');
        // } else {
        //   console.log("Submit button elements not found");
        // }

        // Also clear title and content warning fields
        const titleInput = document.querySelector('#smart_input_post_title input');
        const cwInput = document.querySelector('#smart_input_summary input[name="post[post_content][summary]"]');

        if (titleInput) titleInput.value = '';
        if (cwInput) cwInput.value = '';

        if (this.editor) {
          this.editor.action(replaceAll(""));
        }

      });

      
      this.handleEvent("focus-editor", () => {
        console.log("RECEIVED focus-editor event");
        if (this.editor) {
          this.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.focus();
          });
        }
      });

      this.handleEvent("insert_at_cursor", (payload) => {
        console.log("RECEIVED insert_at_cursor event with payload:", payload);
        if (!this.editor) {
          console.warn("Cannot handle insert_at_cursor: Editor not initialized yet");
          return;
        }

        const text = payload.text;
        if (text) {
          console.log("Inserting text at cursor:", text);

          this.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);

            // Insert the text at the current cursor position
            view.dispatch(view.state.tr.insertText(text));

            // Focus the editor after insertion
            view.focus();
          });
        } else {
          console.warn("Received insert_at_cursor event with no text:", payload);
        }
      });

      // Set up handler for focusing the composer
      // this.focusComposerHandler = (event) => {
      //   try {
      //     const contentEditableDiv = this.el.querySelector("[contenteditable]");
      //     if (!contentEditableDiv) {
      //       console.warn("Could not find contenteditable element for focus");
      //       return;
      //     }
          
      //     contentEditableDiv.focus();
      //     const range = document.createRange();
      //     const selection = window.getSelection();
      //     range.selectNodeContents(contentEditableDiv);
      //     range.collapse(false);
      //     selection.removeAllRanges();
      //     selection.addRange(range);
      //   } catch (error) {
      //     console.error("Error focusing composer:", error);
      //   }
      // };

      // // Listen for focus events
      // window.addEventListener("bonfire:focus-composer", this.focusComposerHandler);

    // Initialize editor asynchronously to ensure DOM is ready
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
              ctx.set(headingAttr.key, (node) => {
                const level = node.attrs.level;
                if (level === 1) return { class: 'text-3xl no-margin-top', "data-el-type": 'h3', id: null };
                if (level === 2) return { class: 'text-2xl no-margin-top', "data-el-type": 'h3', id: null };
                if (level === 3) return { class: 'text-xl no-margin-top', "data-el-type": 'h3', id: null };
                if (level === 4) return { class: 'text-lg no-margin-top', "data-el-type": 'h3', id: null };
                if (level === 5) return { class: 'text-base no-margin-top', "data-el-type": 'h4', id: null };
                if (level === 6) return { class: 'text-base no-margin-top', "data-el-type": 'h4', id: null };
              });
              
              // ctx.set(blockquoteAttr.key, () => ({
              //   class: 'pl-4 border-l-4 border-base-content/30 italic my-4'
              // }));
              
              // Configure paragraph styles
              // ctx.set(paragraphAttr.key, () => ({ class: 'text-[15px]' }));
              
              // Configure editor view options
              ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                attributes: { 
                  class: 'milkdown-editor mx-auto focus:outline-hidden h-full p-2 prose text-[16px] prose-sm prose-bonfire break-normal break-all max-w-none text-base-content prose-hr:!my-2 prose-br:hidden', 
                  spellcheck: 'false',
                  placeholder: "Type your text here..."
                },
                handlePaste: (view, event) => {
                  // Block pasting if there are any files
                  if (event.clipboardData.files.length > 0) {
                    event.preventDefault();
                    console.log('File paste blocked');
                    return true;
                  }
              
                  // Block pasting if there are any image items
                  const hasImageItems = Array.from(event.clipboardData.items).some(
                    item => item.type.startsWith('image/')
                  );
              
                  if (hasImageItems) {
                    event.preventDefault();
                    console.log('Image paste blocked');
                    return true;
                  }
              
                  // Let the editor handle normal text paste
                  return false;
                }
              }));
              
              // Configure mentions slash provider
              ctx.set(mentionSlash.key, {
                view: mentionsPluginView,
              });

            })
            // .use(nord)          // Apply Nord theme
            .use(commonmark)    // Basic Markdown support - required for document schema
            // Removed GFM to prevent email autolink conflicts with ActivityPub mentions
            .use(emoji)         // Emoji support
            .use(indent)
            .use(trailing)
            
            // Custom clipboard configuration to disable image pasting
            // .use(clipboard.configure(clipboardPlugin, {
            //   handlePaste: (view, event, slice) => {
            //     // Skip handling if no clipboardData is available
            //     if (!event.clipboardData) return false;
                
            //     // Check if the clipboard contains images
            //     const hasImages = Array.from(event.clipboardData.items).some(
            //       item => item.type.startsWith('image/')
            //     );
                
            //     // If clipboard contains images, prevent handling entirely
            //     if (hasImages) {
            //       console.log('Image paste detected and blocked');
            //       event.preventDefault();
            //       return true; // Mark as handled (preventing default behavior)
            //     }
                
            //     // Let default clipboard handler process non-image content
            //     return false;
            //   }
            // }))  
            .use(listener)      // Event listener
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

          // Initialize emoji picker
          initEmojiPicker(this.editor);


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
    // Clear any pending timeout
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
      this._updateTimeout = null;
    }


    // Clean up emoji picker
    if (currentPicker) {
      currentPicker.remove();
      currentPicker = null;
    }
    
    // Destroy editor
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    
    // Remove event listeners
    if (this.focusComposerHandler) {
      window.removeEventListener(
        "bonfire:focus-composer",
        this.focusComposerHandler
      );
      this.focusComposerHandler = null;
    }
  },
  
};
