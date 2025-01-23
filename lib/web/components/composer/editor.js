import {
    defaultValueCtx,
    editorViewOptionsCtx,
    Editor,
    editorViewCtx,
    rootCtx,
    listenerCtx
  } from "@milkdown/kit/core";
  import { replaceAll, insert } from "@milkdown/utils";
  import { commonmark } from "@milkdown/kit/preset/commonmark";
  import { gfm } from "@milkdown/kit/preset/gfm";
  import { emoji } from "@milkdown/plugin-emoji";
  import { listener } from "@milkdown/kit/plugin/listener";
  import { clipboard } from "@milkdown/kit/plugin/clipboard";
  import { createPopup } from "@picmo/popup-picker";
  import "@milkdown/theme-nord/style.css";

export const createEditor = async (hook, hiddenInput, composer$) => {
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, "#editor");
        ctx.set(defaultValueCtx, "");
        
        ctx.set(mentionSlash.key, {
          view: mentionsPluginView,
        });
        
        ctx.set(emojisSlash.key, {
          view: emojisPluginView,
        });
  
        ctx.get(listenerCtx).markdownUpdated((ctx, markdown) => {
          if (!hiddenInput) return;
          
          const transformedMarkdown = transformMarkdown(markdown);
          hiddenInput.value = transformedMarkdown;
          
          const inputEvent = new Event("input", { bubbles: true });
          hiddenInput.dispatchEvent(inputEvent);
        });
  
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: {
            placeholder: "Type your text here...",
            class: "editor prose prose-sm h-full p-2 focus:outline-none composer w-full max-w-full prose-p:first-of-type:mt-0",
            spellcheck: "false",
          },
        }));
      })
      .use([
        commonmark,
        gfm,
        emoji,
        listener,
        mentionSlash,
        emojisSlash,
        clipboard,
        createPlaceholderPlugin(),
      ])
      .create();
  
    const trigger = document.querySelector(".emoji-button");
    if (!trigger) {
      console.warn("Emoji button not found");
      return editor;
    }
  
    const picker = createPopup(
      {},
      {
        referenceElement: trigger,
        triggerElement: trigger,
        emojiSize: "1.75rem",
        className: "z-[99999999999999999999]",
      },
    );
  
    trigger.addEventListener("click", () => picker.toggle());
  
    picker.addEventListener("emoji:select", (event) => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.insertText(event.emoji + " ");
        view.dispatch(tr);
        view.focus();
      });
    });
  
    // Set up editor click handlers
    composer$?.addEventListener("click", (e) => {
      if (e.target.matches(".emoji_btn")) {
        e.preventDefault();
        const { emoji, text } = e.target.dataset;
        if (!emoji || !text) return;
  
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const { selection } = state;
          
          view.dispatch(
            view.state.tr
              .delete(selection.from - text.length - 1, selection.from)
              .insertText(emoji + " ")
          );
          view.focus();
        });
      }
  
      if (e.target.matches(".mention_btn")) {
        e.preventDefault();
        const { mention, text } = e.target.dataset;
        if (!mention || !text) return;
  
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { state } = view;
          const { selection } = state;
          const startPos = selection.from - text.length - 1;
  
          view.dispatch(
            view.state.tr
              .delete(startPos, selection.from)
              .insertText(`${mention} \u200B `)
          );
          view.focus();
        });
      }
    });
  
    // Handle LiveView events
    hook.handleEvent("smart_input:reset", () => {
      editor.action(replaceAll(""));
    });
  
    hook.handleEvent("mention_suggestions", ({ text }) => {
      editor.action(replaceAll(""));
      if (text != null) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dispatch(view.state.tr.insertText(text + " "));
          view.focus();
        });
      }
    });
  
    return {
      editor,
      picker,
      cleanup: () => {
        picker?.destroy();
        editor?.destroy();
        composer$?.removeEventListener("click", handleEditorClicks);
      }
    };
  };