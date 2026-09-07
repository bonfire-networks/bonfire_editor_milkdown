import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { SlashProvider } from '@milkdown/plugin-slash';

export function getMentionMatchInfo(state) {
  const { selection } = state;
  const { $from, empty, from } = selection;
  if (!(selection instanceof TextSelection) || !empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.marks().some(mark => mark.type.spec.code)) return null;

  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC');
  const match = text.match(/(?:^|[\s(])(@([\w.-]+(?:@[\w.-]*)?))$/);
  if (!match || (match[2].length < 2 && !match[2].includes('@'))) return null;
  return { from: from - match[1].length, to: from, query: match[2] };
}

export function insertMention(state, match, mention) {
  const current = getMentionMatchInfo(state);
  if (!current || !match || current.query !== match.query || current.from !== match.from || current.to !== match.to) return null;
  return state.tr.insertText(`${mention.startsWith('@') ? mention : '@' + mention} `, current.from, current.to);
}

function createMentionItem(item, index) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.index = index;
  button.className = 'mention_btn rounded-none w-full flex items-center gap-3 min-h-11 p-2';

  const img = document.createElement('img');
  img.className = 'h-8 w-8 rounded-full shrink-0';
  img.alt = '';
  if (/^(https?:\/\/|\/)/.test(item.icon || '')) img.src = item.icon;
  const text = document.createElement('span');
  text.className = 'min-w-0 flex flex-col items-start';
  const name = document.createElement('span');
  name.className = 'text-sm truncate max-w-full font-semibold';
  name.textContent = item.name || item.id;
  const username = document.createElement('span');
  username.className = 'text-xs truncate max-w-full text-base-content/70';
  username.textContent = item.id;
  text.append(name, username);
  button.append(img, text);
  li.append(button);
  return li;
}

function createMentionMenu(view, hook) {
  const content = document.createElement('ul');
  content.className = 'milkdown-menu menu z-50 shadow-sm bg-base-100 border border-secondary w-72 max-w-full absolute rounded-xl';
  content.dataset.show = 'false';

  let items = [];
  let displayedMatch = null;
  let query = null;
  let timeout;
  let controller;
  let destroyed = false;

  const getMatch = () => {
    if (destroyed || view.composing || !view.editable || hook.el.dataset.disableMentions === 'true' || (!view.hasFocus() && !content.contains(document.activeElement))) return null;
    return getMentionMatchInfo(view.state);
  };
  const provider = new SlashProvider({
    content,
    debounce: 0,
    shouldShow: () => {
      const match = getMatch();
      return !!(match && displayedMatch && match.query === displayedMatch.query && match.from === displayedMatch.from && match.to === displayedMatch.to && items.length);
    },
  });
  const cancelSearch = () => {
    clearTimeout(timeout);
    controller?.abort();
    controller = null;
  };
  const accept = index => {
    if (!getMatch() || !items[index]) return false;
    const tr = insertMention(view.state, displayedMatch, items[index].id);
    if (!tr) return false;
    view.dispatch(tr);
    provider.hide();
    view.focus();
    return true;
  };
  const update = () => {
    const match = getMatch();
    if (!match) {
      cancelSearch();
      query = null;
      displayedMatch = null;
      items = [];
      provider.hide();
      return;
    }
    if (query === match.query) {
      if (items.length) {
        displayedMatch = match;
        provider.update(view);
      }
      return;
    }

    cancelSearch();
    query = match.query;
    displayedMatch = null;
    items = [];
    provider.hide();
    const request = new AbortController();
    controller = request;
    timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/tag/autocomplete/ck5/@/${encodeURIComponent(match.query)}`, { signal: request.signal });
        if (!response.ok) throw new Error(`Mention search returned ${response.status}`);
        const results = await response.json();
        const latest = getMatch();
        if (request.signal.aborted || !latest || latest.query !== match.query) return;
        items = results.filter(item => typeof item.id === 'string' && item.id).slice(0, 4);
        displayedMatch = latest;
        content.replaceChildren(...items.map((item, index) => createMentionItem(item, index)));
        if (items.length) {
          provider.update(view);
        }
      } catch (error) {
        if (!request.signal.aborted) {
          console.error('Mention search failed', error);
          query = null;
        }
      }
    }, 100);
  };
  const handlePointerDown = event => {
    if (event.target.closest('button')) event.preventDefault();
  };
  const handleClick = event => {
    const button = event.target.closest('button[data-index]');
    if (button) accept(Number(button.dataset.index));
  };
  const handleBlur = () => {
    cancelSearch();
    query = null;
    displayedMatch = null;
    items = [];
    provider.hide();
  };
  content.addEventListener('pointerdown', handlePointerDown);
  content.addEventListener('click', handleClick);
  view.dom.addEventListener('blur', handleBlur);

  return {
    update,
    destroy() {
      destroyed = true;
      cancelSearch();
      provider.destroy();
      content.removeEventListener('pointerdown', handlePointerDown);
      content.removeEventListener('click', handleClick);
      view.dom.removeEventListener('blur', handleBlur);
      content.remove();
    },
  };
}

export function createMentionsPlugin(hook) {
  return $prose(() => new Plugin({
    key: new PluginKey('bonfire-mentions'),
    view: view => createMentionMenu(view, hook),
  }));
}
