import { parserCtx } from '@milkdown/core';
import { $prose } from '@milkdown/utils';
import { inlineCodeSchema, linkSchema } from '@milkdown/preset-commonmark';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { ATOM, linkCandidates } from './link_syntax.js';

// commonmark ships no link input rule. Converting on a typed `)`, or typing just after one, covers links finished in any order.
// Only the `[…](…)` is parsed: automd's whole-buffer round-trip broke @mention escaping.
export function createLinkConversionPlugin() {
  return $prose(ctx => new Plugin({
    key: new PluginKey('bonfire-link-conversion'),
    props: {
      handleTextInput(view, from, to, text, deflt) {
        // Editing mid-composition breaks IME input
        if (view.composing) return false;
        // Only a `)` can complete a link
        if (!text.endsWith(')') && view.state.doc.textBetween(Math.max(0, from - 1), from) !== ')') return false;
        const tr = deflt();
        if (!convertLink(ctx, tr, [from, from + text.length])) return false;
        view.dispatch(tr);
        return true;
      },
      handleDOMEvents: {
        // The composition lands after this event, as in prosemirror-inputrules
        compositionend: view => {
          setTimeout(() => {
            if (view.isDestroyed) return;
            const { $cursor } = view.state.selection;
            const tr = view.state.tr;
            if ($cursor && convertLink(ctx, tr, [$cursor.pos])) view.dispatch(tr);
          });
          return false;
        },
      },
    },
  }));
}

// `ends`: where a just-completed link may end
function convertLink(ctx, tr, ends) {
  const $cursor = tr.doc.resolve(tr.selection.head);
  if (!$cursor.parent.isTextblock || $cursor.parent.type.spec.code) return false;
  const block = $cursor.parent, base = $cursor.start();
  const blockText = block.textBetween(0, block.content.size, null, ATOM);
  const link = linkCandidates(blockText).find(({ end }) => ends.includes(base + end));
  if (!link) return false;
  const linkType = linkSchema.type(ctx);
  const start = base + link.start, labelEnd = base + link.labelEnd, end = base + link.end;
  if (tr.doc.rangeHasMark(start, end, linkType) || tr.doc.rangeHasMark(start, end, inlineCodeSchema.type(ctx))) return false;
  const attrs = parseLink(blockText.slice(link.start, link.end), ctx.get(parserCtx), linkType);
  if (!attrs) return false;
  tr.delete(labelEnd, end).addMark(start + 1, labelEnd, linkType.create(attrs)).delete(start, start + 1);
  // The link mark is inclusive
  tr.setStoredMarks(linkType.removeFromSet(tr.doc.resolve(tr.selection.head).marks()));
  return true;
}

function parseLink(source, parse, linkType) {
  let doc;
  try {
    doc = parse(source);
  } catch {
    return null;
  }
  const paragraph = doc.firstChild;
  if (doc.childCount !== 1 || paragraph.type.name !== 'paragraph' || !paragraph.childCount) return null;
  const first = linkType.isInSet(paragraph.firstChild.marks);
  for (let i = 0; i < paragraph.childCount; i++) {
    const mark = linkType.isInSet(paragraph.child(i).marks);
    if (!first || !mark || !first.eq(mark)) return null;
  }
  // `[a]()` is valid, but converting it would block the URL typed in next
  return first.attrs.href ? first.attrs : null;
}
