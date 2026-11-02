import { remarkCtx, schemaCtx } from '@milkdown/core';
import { SerializerState } from '@milkdown/transformer';

// These are text-node handlers: code, link destinations and other literal nodes never pass through them.
export function serializeSocialText(node, parent, state, info) {
  const value = node.value.replace(/\u00a0/g, ' ');
  let text = state.safe(value, { ...info, encode: [] });
  const trailingSpaces = value.match(/ +$/)?.[0];
  if (trailingSpaces) text = text.replace(/(?:&#x20;| )+$/, trailingSpaces);
  // Linkify reads raw Markdown on the server, so underscores in mentions, hashtags and URLs stay literal.
  // Formatting delimiters and character references still need escaping.
  text = text.replace(/https?:\/\/(?:\\[^\s]|[^\s()[\]\\])+/g,
    url => url.replace(/(?<!\\)\\&(?=[\w%-]+=)/g, '&').replace(/(?<!\\)\\_/g, '_'));
  text = text.replace(/[@#][\p{L}\p{M}\p{N}_\\.-]+/gu, token => token.replace(/(?<!\\)\\_/g, '_'));
  return text.replace(/(?<!\\)\\#(?=[\p{L}\p{N}_])/gu, '#');
}

// An empty paragraph serializes to this: a line left blank
const BLANK_LINE_HTML = '<br />';
const blankLine = () => ({ type: 'paragraph', children: [{ type: 'html', value: BLANK_LINE_HTML }] });
const isBlankLine = node => node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'html' && node.children[0].value === BLANK_LINE_HTML;

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
      const breaks = pendingBreaks.filter(part => part.type === 'break').length;
      // Breaks opening a paragraph are blank lines above it
      if (breaks && !current.length && !paragraphs.length) {
        paragraphs.push(...Array.from({ length: breaks }, blankLine));
      } else if (breaks > 1) {
        if (current.length) paragraphs.push({ ...normalized, children: current });
        // Breaks past the split are blank lines too
        paragraphs.push(...Array.from({ length: breaks - 2 }, blankLine));
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
  if (node.type !== 'root') return { ...node, children };
  // Drop blank lines at the post's edges; the editor's empty last paragraph renders nothing and stays
  const first = children.findIndex(child => !isBlankLine(child));
  const last = children.findLastIndex(child => !isBlankLine(child) && !(child.type === 'paragraph' && !child.children?.length));
  return { ...node, children: children.filter((child, i) => !isBlankLine(child) || (i > first && i < last)) };
}

export function serializeMarkdownForSubmit(ctx, doc) {
  if (doc.childCount === 1 && doc.firstChild.type.name === 'paragraph' && !doc.firstChild.content.size) return '';
  const tree = new SerializerState(ctx.get(schemaCtx)).run(doc).build();
  return ctx.get(remarkCtx).stringify(normalizeSubmitTree(tree));
}
