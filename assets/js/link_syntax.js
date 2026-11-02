// Leaf nodes read as this, so no link spans them
export const ATOM = '￼';

// Offsets: start at `[`, labelEnd at `]`, end after `)`
export function linkCandidates(text) {
  const candidates = [];
  if (!text.includes('](')) return candidates;
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    // `!` makes it an image
    if (escaped(text, start) || text[start - 1] === '!') continue;
    const labelEnd = text.indexOf('](', start);
    if (labelEnd === -1) continue;
    const label = text.slice(start + 1, labelEnd);
    if (!label || label.includes('[') || label.includes(ATOM)) continue;
    const close = closingParen(text, labelEnd + 2);
    if (close !== -1) candidates.push({ start, labelEnd, end: close + 1 });
  }
  return candidates;
}

// URL brackets must balance, as in `Foo_(bar)`; a quoted title may hold any
export function closingParen(text, from) {
  let depth = 0, quote = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (char === ATOM) return -1;
    if (char === '\\') i++;
    else if (quote) quote = char === quote ? null : quote;
    else if ((char === '"' || char === "'") && /\s/.test(text[i - 1])) quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && depth-- === 0) return i;
  }
  return -1;
}

// An odd run of backslashes escapes the character
function escaped(text, at) {
  let slashes = 0;
  while (text[at - 1 - slashes] === '\\') slashes++;
  return slashes % 2 === 1;
}
