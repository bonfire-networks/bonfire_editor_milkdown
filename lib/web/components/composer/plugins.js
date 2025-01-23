import { $prose } from "@milkdown/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { SlashProvider, slashFactory } from "@milkdown/kit/plugin/slash";
import { gemoji } from "gemoji";

export const createPlaceholderPlugin = () => {
    return $prose(() => new Plugin({
      key: new PluginKey("milkdown-placeholder"),
      props: {
        decorations: (state) => {
          if (state.doc.textContent.trim().length !== 0) {
            return DecorationSet.empty;
          }
  
          const element = document.createElement("span");
          element.classList.add("milkdown-placeholder");
          element.style.position = "absolute";
          element.style.opacity = "0.5";
          element.innerText = "Write something...";
  
          const decoration = Decoration.widget(0, element, {
            key: "milkdown-placeholder",
            side: 0,
          });
  
          return DecorationSet.create(state.doc, [decoration]);
        },
      },
    }));
  };
  
  export function createMentionsPluginView(view) {
    const content = document.createElement("ul");
    content.tabIndex = 1;
    content.className = "milkdown-menu absolute m-0 p-0 menu left-menu bg-base-200 border border-base-content/10 shadow-xl border-lg";
  
    const provider = new SlashProvider({
      content,
      shouldShow: async (view) => {
        const currentText = view.state.doc.textContent;
        if (!currentText) return false;
  
        const matches = currentText.match(CONSTANTS.MENTION_REGEX);
        if (!matches) return false;
  
        const text = matches[1].split("@").pop();
        const items = await getFeedItems(text, "@");
  
        content.innerHTML = items.length > 0 
          ? items.slice(0, 4).map(item => mentionItemRenderer(item, text)).join("")
          : "";
  
        return items.length > 0;
      },
      trigger: "@",
    });
  
    return {
      update: (updatedView, prevState) => provider.update(updatedView, prevState),
      destroy: () => {
        provider.destroy();
        content.remove();
      },
    };
  }
  
  export  function createEmojisPluginView() {
    const content = document.createElement("ul");
    content.tabIndex = 1;
    content.className = "milkdown-menu absolute m-0 p-0 menu w-72 bg-base-100 border border-base-content/10 shadow-lg";
  
    const provider = new SlashProvider({
      content,
      shouldShow: (view) => {
        const currentText = view.state.doc.textContent;
        if (!currentText) return false;
  
        const matches = currentText.match(CONSTANTS.EMOJI_REGEX);
        if (!matches) return false;
  
        const text = matches[1].split(":").pop();
        const matchingEmojis = gemoji
          .filter(emoji => emoji.names.some(name => name.includes(text)))
          .slice(0, 6);
  
        content.innerHTML = matchingEmojis.length > 0
          ? matchingEmojis.map(emoji => emojiItemRenderer(emoji, text)).join("")
          : "";
  
        return matchingEmojis.length > 0;
      },
      trigger: ":",
    });
  
    return {
      update: (updatedView, prevState) => provider.update(updatedView, prevState),
      destroy: () => {
        provider.destroy();
        content.remove();
      },
    };
  }