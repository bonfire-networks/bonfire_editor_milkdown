export const mentionItemRenderer = (item, text) => `
  <li class="rounded-none">
    <button 
      type="button" 
      data-mention="${item.id}" 
      data-text="${text}" 
      class="mention_btn rounded-none w-full flex items-center"
    >
      <div class="flex items-center gap-3 w-full pointer-events-none">
        <div class="flex-shrink-0">
          <img class="h-6 w-6 rounded-full" src="${item.icon}" alt="">
        </div>
        <div class="gap-0 items-start flex flex-col">
          <div class="text-sm truncate max-w-[240px] text-base-content font-semibold">${item.value}</div>
          <div class="text-xs truncate max-w-[240px] text-base-content/70 font-regular">${item.id}</div>
        </div>
      </div>
    </button>
  </li>`;

  export const emojiItemRenderer = (item, text) => `
  <li class="rounded-none">
    <button 
      type="button" 
      data-text="${text}" 
      data-emoji="${item.emoji}" 
      class="emoji_btn gap-3 rounded-none w-full flex items-center"
    >
      <div class="pointer-events-none flex items-baseline w-full gap-2">
        <span>${item.emoji}</span>
        <span class="truncate max-w-[220px]">:${item.names[0]}:</span>
      </div>
    </button>
  </li>`;