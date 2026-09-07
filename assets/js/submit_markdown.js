import { remarkCtx, schemaCtx } from '@milkdown/core';
import { SerializerState } from '@milkdown/transformer';

// These are text-node handlers: code, link destinations and other literal nodes never pass through them.
export function serializeSocialText(node, parent, state, info) {
  const value = node.value.replace(/\u00a0/g, ' ');
  let text = state.safe(value, { ...info, encode: [] });
  const trailingSpaces = value.match(/ +$/)?.[0];
  if (trailingSpaces) text = text.replace(/(?:&#x20;| )+$/, trailingSpaces);
  // Query separators are literal; formatting delimiters and character references still need escaping.
  text = text.replace(/https?:\/\/(?:\\[^\s]|[^\s()[\]\\])+/g,
    url => url.replace(/(?<!\\)\\&(?=[\w%-]+=)/g, '&'));
  text = text.replace(/@[a-zA-Z0-9_\\.-]+/g, mention => mention.replace(/(?<!\\)\\_/g, '_'));
  return text.replace(/(?<!\\)\\#(?=[\p{L}\p{N}_])/gu, '#');
}

// Two hard breaks express a blank line in the composer. Split paragraphs in the AST, before Markdown delimiters exist.
export function normalizeSubmitTree(node) {
  if (!node.children) return node;
  const children = node.children.flatMap(child => {
    const normalized = normalizeSubmitTree(child);
    if (normalized.type !== 'paragraph') return [normalized];

    const paragraphs = [];
    let current = [];
    let pendingBreaks = [];
    const flushBreaks = () => {
      if (pendingBreaks.filter(part => part.type === 'break').length > 1) {
        if (current.length) paragraphs.push({ ...normalized, children: current });
        current = [];
      } else {
        current.push(...pendingBreaks);
      }
      pendingBreaks = [];
    };

    for (const part of normalized.children || []) {
      if (part.type === 'break' || (pendingBreaks.length && part.type === 'text' && /^[\t \u00a0]*$/.test(part.value))) {
        pendingBreaks.push(part);
      } else {
        flushBreaks();
        current.push(part);
      }
    }
    // A break at the end of a paragraph has no following line to separate.
    if (current.length || !paragraphs.length) paragraphs.push({ ...normalized, children: current });
    return paragraphs;
  });
  return { ...node, children };
}

export function serializeMarkdownForSubmit(ctx, doc) {
  if (doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && !doc.firstChild.content.size) return '';
  const tree = new SerializerState(ctx.get(schemaCtx)).run(doc).build();
  return ctx.get(remarkCtx).stringify(normalizeSubmitTree(tree));
}
