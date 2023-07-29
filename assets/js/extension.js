import { defaultValueCtx, editorViewOptionsCtx, Editor, rootCtx } from '@milkdown/core';
import { insert } from '@milkdown/utils';
import { commonmark} from '@milkdown/preset-commonmark';
import { emoji } from '@milkdown/plugin-emoji';
import {placeholder, placeholderCtx} from 'milkdown-plugin-placeholder';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { SlashProvider } from '@milkdown/plugin-slash'
import { slashFactory } from '@milkdown/plugin-slash';
// import { nord } from '@milkdown/theme-nord';
import { gemoji } from "gemoji";

console.log('Milkdown Vanilla Shiki Highlight loaded');
const MIN_PREFIX_LENGTH = 2
const VALID_CHARS = '[\\w\\+_\\-:]'
const MENTION_PREFIX = '(?:@)'
const EMOJI_PREFIX = '(?::)'
const MENTION_REGEX = new RegExp(`(?:\\s|^)(${MENTION_PREFIX}${VALID_CHARS}{${MIN_PREFIX_LENGTH},})$`)
const EMOJI_REGEX = new RegExp(`(?:\\s|^)(${EMOJI_PREFIX}${VALID_CHARS}{${MIN_PREFIX_LENGTH},})$`)


import '@milkdown/theme-nord/style.css';

const markdown = ``

let MilkdownHooks = {};


function mentionsPluginView(view) {
  const content = document.createElement('ul');
  content.tabIndex = 1;

  content.className = 'm-0 p-0 menu w-72 bg-base-100 shadow-lg ring-2';
  let list = ''

  const provider = new SlashProvider({
    content,
    shouldShow: (view, prevState) => {
      // get the current content of the editor
      const { state } = view;
      const { doc } = state;
      const currentText = doc.textContent;

      if (currentText === '') {
        return false;
      }
      

      const mentions = currentText.match(MENTION_REGEX)

      // Display the menu if the last character is `@` followed by 2 chars.
      if (mentions) {
        // get the characters that follows the `@` in currentText
        const text = mentions[1].split('@').pop()

        return getFeedItems(text, '@').then(res => {
          list = ''
          if (res.length > 0) {
            // Add max 4 items to the menu
            let maxItems = 4
            for (let i = 0; i < res.length && i < maxItems; i++) {
              list += mentionItemRenderer(res[i], text);
            }
            content.innerHTML = list
            return true
          } else {
            content.innerHTML = ''
            return false
          }
          })
        }
  
      return false;
    },
    trigger: '@',
  });

  return {
    update: (updatedView, prevState) => {
      provider.update(updatedView, prevState);
    },
    destroy: () => {
      provider.destroy();
      content.remove();
    }
  }
}


function emojisPluginView(view) {
  const content = document.createElement('ul');
  content.tabIndex = 1;

  content.className = 'm-0 p-0 menu w-72 bg-base-100 shadow-lg ring-2';
  let list = ''

  const provider = new SlashProvider({
    content,
    shouldShow: (view, prevState) => {
      // get the current content of the editor
      const { state } = view;
      const { doc } = state;
      const currentText = doc.textContent;

      if (currentText === '') {
        return false;
      }
      
      const emojis = currentText.match(EMOJI_REGEX)
      // Display the menu if the last character is `@` followed by 2 chars.
      if (emojis) {
        // get the characters that follows the `@` in currentText
        const text = emojis[1].split(':').pop()
        const index = gemoji.findIndex((emoji) => {
          return emoji.names.some((name) => name.includes(text));
        });

        list = ''
        if (index > 0) {
          // Add max 4 items to the menu
          gemoji
          .filter((emoji) => {
            return emoji.names.some((name) => name.includes(text));
          })
          .slice(0, 4)
          .map((emoji) => {
            list += emojiItemRenderer(emoji);
          })
          
          content.innerHTML = list
          return true
        } else {
          content.innerHTML = ''
          return false
        }
      }
      return false;
    },
    trigger: ':',
  });

  return {
    update: (updatedView, prevState) => {
      provider.update(updatedView, prevState);
    },
    destroy: () => {
      provider.destroy();
      content.remove();
    }
  }
}


function slashPluginView(view) {
  const content = document.createElement('ul');
  content.tabIndex = 1;

  content.className = 'm-0 p-0 menu w-72 bg-base-100 shadow-lg ring-2';
  let list = slashItemRenderer()
  content.innerHTML = list
  const provider = new SlashProvider({
    content,
    trigger: '/',
  });

  return {
    update: (updatedView, prevState) => {
      provider.update(updatedView, prevState);
    },
    destroy: () => {
      provider.destroy();
      content.remove();
    }
  }
}



function getFeedItems(queryText, prefix) {
  // console.log(prefix)
  if (queryText && queryText.length > 0) {
    return new Promise((resolve) => {
      // this requires the bonfire_tag extension
      fetch("/api/tag/autocomplete/ck5/" + prefix + "/" + queryText)
        .then((response) => response.json())
        .then((data) => {
          console.log("data")
          console.log(data)
          let values = data.map((item) => ({
            id: item.id,
            value: item.name,
            link: item.link,
          }));
          resolve(values);
        })
        .catch((error) => {
          console.error("There has been a problem with the tag search:", error);
          resolve([]);
        });
    });
  } else return [];
}

const mentionItemRenderer = (item, text) => {
  return `
    <li class="rounded-none">
      <button class="gap-3 rounded-none w-full flex items-center">
        <div class="flex-shrink-0">
          <img class="h-6 w-6 rounded-full" src="https://picsum.photos/80" alt="">
        </div>
        <div class="gap-0 items-start flex flex-col" data-id="${item.id}" data-input="${text}">
          <div class="text-sm truncate max-w-[240px] text-base-content font-semibold">${item.value}</div>
          <div class="text-xs truncate max-w-[240px] text-base-content/70 font-regular">${item.id}</div>
        </div>
      </button>
    </li>`
}

const emojiItemRenderer = (item) => {
  return `
    <li class="rounded-none">
      <button class="gap-3 rounded-none w-full flex items-center">
        <div class="flex items-baseline w-full gap-2">
        <span>${item.emoji}</span> </span>:${item.names[0]}:</span>
        </div>
      </button>
    </li>`
}

const slashItemRenderer = () => {
  return `
    <li class="rounded-none">
      <div className="rounded-none flex items-center gap-2">
        <span className="material-symbols-outlined text-nord-10 dark:text-nord-9">
          <svg class="w-5 h-5 shrink-0 flex-1 text-info" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M6 17q-.425 0-.713-.288T5 16V8q0-.425.288-.713T6 7q.425 0 .713.288T7 8v3h4V8q0-.425.288-.713T12 7q.425 0 .713.288T13 8v8q0 .425-.288.713T12 17q-.425 0-.713-.288T11 16v-3H7v3q0 .425-.288.713T6 17Zm12 0q-.425 0-.713-.288T17 16V9h-1q-.425 0-.713-.288T15 8q0-.425.288-.713T16 7h2q.425 0 .713.288T19 8v8q0 .425-.288.713T18 17Z"/></svg>
        </span>
        Large Heading
      </div>
    </li>
    <li class="rounded-none">
      <div className="rounded-none flex items-center gap-2">
        <span className="material-symbols-outlined text-nord-10 dark:text-nord-9">
        <svg class="w-5 h-5 shrink-0 flex-1 text-info" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M4 17q-.425 0-.713-.288T3 16V8q0-.425.288-.713T4 7q.425 0 .713.288T5 8v3h4V8q0-.425.288-.713T10 7q.425 0 .713.288T11 8v8q0 .425-.288.713T10 17q-.425 0-.713-.288T9 16v-3H5v3q0 .425-.288.713T4 17Zm10 0q-.425 0-.713-.288T13 16v-3q0-.825.588-1.413T15 11h4V9h-5q-.425 0-.713-.288T13 8q0-.425.288-.713T14 7h5q.825 0 1.413.588T21 9v2q0 .825-.588 1.413T19 13h-4v2h5q.425 0 .713.288T21 16q0 .425-.288.713T20 17h-6Z"/></svg>
        </span>
        Small Heading
      </div>
    </li>
    <li class="rounded-none">
      <div className="rounded-none flex items-center gap-2">
        <span className="material-symbols-outlined text-nord-10 dark:text-nord-9">
        <svg class="w-5 h-5 shrink-0 flex-1 text-info" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M14 20v-2h3q.425 0 .713-.288T18 17v-2q0-.95.55-1.725t1.45-1.1v-.35q-.9-.325-1.45-1.1T18 9V7q0-.425-.288-.712T17 6h-3V4h3q1.25 0 2.125.875T20 7v2q0 .425.288.713T21 10h1v4h-1q-.425 0-.713.288T20 15v2q0 1.25-.875 2.125T17 20h-3Zm-7 0q-1.25 0-2.125-.875T4 17v-2q0-.425-.288-.713T3 14H2v-4h1q.425 0 .713-.288T4 9V7q0-1.25.875-2.125T7 4h3v2H7q-.425 0-.713.288T6 7v2q0 .95-.55 1.725T4 11.825v.35q.9.325 1.45 1.1T6 15v2q0 .425.288.713T7 18h3v2H7Z"/></svg>
        </span>
        Code Block
      </div>
    </li>
    <li class="rounded-none">
      <div className="rounded-none flex items-center gap-2">
        <span className="material-symbols-outlined text-nord-10 dark:text-nord-9">
          <svg class="w-5 h-5 shrink-0 flex-1 text-info" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M20 21H5q-.825 0-1.413-.588T3 19V5q0-.825.588-1.413T5 3h15q.825 0 1.413.588T22 5v14q0 .825-.588 1.413T20 21ZM5 8h15V5H5v3Zm3 2H5v9h3v-9Zm9 0v9h3v-9h-3Zm-2 0h-5v9h5v-9Z"/></svg>
        </span>
        Table
      </div>
    </li>
    <li class="rounded-none">
      <div className="rounded-none flex items-center gap-2">
        <span className="material-symbols-outlined text-nord-10 dark:text-nord-9">
          <svg class="w-5 h-5 shrink-0 flex-1 text-info"  xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"><path fill="currentColor" fill-rule="evenodd" d="M2 7.5a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1h-10a.5.5 0 0 1-.5-.5Z" clip-rule="evenodd"/></svg>
        </span>
        Divider
      </div>
    </li>
    `
    
}


const mentionSlash = slashFactory('mentions-slash');
const emojisSlash = slashFactory('emojis-slash');
const slash = slashFactory('slash');


MilkdownHooks.Milkdown = {
  mounted() {
  const editor = Editor
    .make()
    .config(ctx => {
      ctx.set(rootCtx, '#editor')
      ctx.set(defaultValueCtx, markdown)
      // ctx.set(placeholderCtx, 'Type something here...')
      ctx.set(mentionSlash.key, {
        view: mentionsPluginView
      })
      ctx.set(emojisSlash.key, {
        view: emojisPluginView
      })
      ctx.set(slash.key, {
        view: slashPluginView
      })
      ctx.get(listenerCtx).markdownUpdated((ctx, markdown, prevMarkdown) => {
        console.log(markdown)
        output = markdown;
        this.el.querySelector('.editor_hidden_input').value = markdown;
      })
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { placeholder: "Type your text here...",  class: 'editor prose prose-sm h-full p-2 focus:outline-none', spellcheck: 'false' },
      }))
    })
    // .config(nord)
    .use(commonmark)
    .use(emoji)
    .use(listener)
    // .use(placeholder)
    .use(mentionSlash)
    .use(emojisSlash)
    .use(slash)
    

    editor.onStatusChange((status) => {
      console.log(status);
      
    });

    editor.create()

    // editor.action(insert("# Hello World"))
  }
}


export { MilkdownHooks } 