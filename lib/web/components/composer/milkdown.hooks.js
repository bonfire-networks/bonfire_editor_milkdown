import {
  defaultValueCtx,
  editorViewOptionsCtx,
  Editor,
  editorViewCtx,
  rootCtx,
} from "@milkdown/core";
import { automd } from '@milkdown/plugin-automd';
import { trailing } from '@milkdown/kit/plugin/trailing'

// import { 
//   nord 
// } from "@milkdown/theme-nord";

import { history } from '@milkdown/kit/plugin/history'
import { indent, indentConfig } from '@milkdown/kit/plugin/indent'
// import { getMarkdown } from '@milkdown/kit/utils'
import { 
  replaceAll,
  $prose
} from "@milkdown/utils";
import {
  commonmark, 
  headingAttr, 
  paragraphAttr
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
      if (!view || !view.state) return false;
      
      const { state } = view;
      const { selection } = state;
      const { from } = selection;
      
      // Get text before cursor
      const textBeforeCursor = state.doc.textBetween(Math.max(0, from - 30), from);
      
      // Match @pattern with exactly 2 or more chars after @
      // The regex `@(\w{2,})$` ensures:
      // - @ character is present
      // - Followed by at least 2 word characters (\w{2,})
      // - And occurs at the end of the text ($)
      const match = textBeforeCursor.match(/@(\w{2,})$/);
      
      // If no match is found (either no @ or fewer than 2 chars after @), don't show dropdown
      if (!match) return false;
      
      console.log("Found mention pattern:", match[0]);
      
      // Get the text after @ (without the @ symbol)
      const query = match[1];
      
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
            
            // Calculate position
            const matchLength = text.length + 1; // +1 for @ symbol
            const startPos = from - matchLength;
            
            // Replace text
            view.dispatch(
              view.state.tr
                .delete(startPos, from)
                .insertText(`${mention} `)
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
  _currentContent: "",
  
  mounted() {
    try {
      console.log("Milkdown hook mounted"); // Debug log
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
          this.editor.action(replaceAll(""));
          this.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            view.dispatch(view.state.tr.insertText(text + " "));
            view.focus();
          });
        } else {
          console.warn("Received mention_suggestions event with invalid payload:", payload);
        }
      });
      
      this.handleEvent("smart_input:reset", () => {
        console.log("RECEIVED smart_input:reset event");

        if (this.editor) {
          this.editor.action(replaceAll(""));
           // Also clear title and content warning fields                                                                              │ │
          const titleInput = document.querySelector('#smart_input_thread_title input');                                               
          const cwInput = document.querySelector('#smart_input_post_title input[name="post[post_content][summary]"]');                                                                                                                                          
          
          if (titleInput) titleInput.value = '';                                                                                      
          if (cwInput) cwInput.value = ''; 
        }
      });
      
      this.handleEvent("reset-editor", () => {
        console.log("RECEIVED reset-editor event");
        if (this.editor) {
          this.editor.action(replaceAll(""));
           // Also clear title and content warning fields                                                                              │ │
          const titleInput = document.querySelector('#smart_input_thread_title input');                                               
          const cwInput = document.querySelector('#smart_input_post_title input[name="post[post_content][summary]"]');                                                                                                                                          
          
          if (titleInput) titleInput.value = '';                                                                                      
          if (cwInput) cwInput.value = '';   
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
    } catch (error) {
      console.error("Error in Milkdown hook mounted:", error);
    }
  },
  
  // Initialize the editor
  async initEditor(hiddenInput, container) {
    try {
      // Create simple slash factory for mentions
      const mentionSlash = slashFactory("mention-slash");
      
      // Initialize with small delay to ensure DOM is ready
      setTimeout(async () => {
        try {
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
              ctx.set(paragraphAttr.key, () => ({ class: 'text-[15px]' }));
              
              // Configure editor view options
              ctx.update(editorViewOptionsCtx, (prev) => ({
                ...prev,
                attributes: { 
                  class: 'milkdown-editor mx-auto focus:outline-hidden h-full p-2', 
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
            .use(commonmark)    // Basic Markdown support
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
            .use(automd)
            .create();
            
          // Set up content listener
          this.editor.action((ctx) => {
            ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
              try {
                // Transform markdown to handle special cases
                const transformedMarkdown = markdown
                  .replace(/\u00A0/g, " ")  // Replace ALL non-breaking spaces with regular spaces
                  // .replace(/!\[(.*?)\]\(.*?\)/g, "$1")  // Removed: This was stripping image markdown syntax
                  .replace(/(^|\s)\\#/g, "$1#")
                  .replace(/(#[^_\s]+)\\(_[^_\s]+)/g, "$1$2")                                           
                  // Fix escaped backslashes in URL                                              
                  .replace(/(https?)\\\:\/\//g, "$1://"); 

                // Update hidden input value
                hiddenInput.value = transformedMarkdown;
                this._currentContent = transformedMarkdown;

                // Dispatch input event to notify LiveView
                const inputEvent = new Event("input", {
                  bubbles: true,
                });
                hiddenInput.dispatchEvent(inputEvent);
                
                // Trigger validation to update submit button state
                // this.pushEvent("validate", {});
                
                // Send event to LiveView
                // this.pushEvent("editor-content-updated", { content: transformedMarkdown });
              } catch (error) {
                console.error("Error updating markdown content:", error);
              }
            });
          });

          // Initialize emoji picker
          initEmojiPicker(this.editor);
          
          console.log("Milkdown editor initialized successfully");
        } catch (error) {
          console.error("Error initializing Milkdown editor:", error);
        }
      }, 0);
    } catch (error) {
      console.error("Error setting up Milkdown editor:", error);
    }
  },
  
  // Handle content updates
  updated() {
    try {
      const hiddenInput = document.getElementById("editor_hidden_input");
      
      // Only update if content has changed and editor exists
      if (this.editor && hiddenInput && hiddenInput.value !== this._currentContent) {
        this._currentContent = hiddenInput.value;
        this.editor.action(replaceAll(hiddenInput.value));
      }
    } catch (error) {
      console.error("Error in Milkdown hook updated:", error);
    }
  },
  
  // Clean up when component is destroyed
  destroyed() {
    try {
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
    } catch (error) {
      console.error("Error cleaning up Milkdown hook:", error);
    }
  },
  
};
