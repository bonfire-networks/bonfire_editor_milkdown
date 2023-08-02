import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

const PlaceholderPlugin = new Plugin({
    key: new PluginKey('milkdown-placeholder'),
    props: {
        decorations: (state) => {
            const element = document.createElement('span')
            
            element.classList.add('milkdown-placeholder')
            element.style.position = "absolute";
            element.style.opacity = "0.5";
            element.innerText = "Write something...";

            const placeholderDecoration = Decoration.widget(0, element, {key: 'milkdown-placeholder', side: 0});
            if (state.doc.textContent.trim().length === 0) {
                return DecorationSet.create(state.doc, [placeholderDecoration])
            }
        }
    }
});
export const placeholder = $prose(() => PlaceholderPlugin);