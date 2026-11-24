import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { contentCases } from './composer_content_cases.mjs';

const assets = fileURLToPath(new URL('..', import.meta.url));
let browser, server, origin, page;
const pageErrors = [];
const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
.hidden, .milkdown-menu[data-show="false"] { display:none }
.milkdown-menu[data-show="true"] { display:block }
.milkdown-menu { position:absolute; background:white; padding:8px; border:1px solid; list-style:none }
#editor { min-height:120px } .ProseMirror { min-height:100px }
</style></head><body><div id="smart_input_container"><form id="composer">
<div id="editor_milkdown_container" data-editor-bundle="/editor.js">
<textarea hidden id="editor_hidden_input" name="body" data-persist-draft></textarea>
<div id="editor" data-placeholder="Scrivi qualcosa…"></div>
</div><button id="submit" type="submit">Send</button></form></div>
<script type="module">
import Hook from '/hook.js';
window.events = {};
window.hook = { ...Hook, el: document.querySelector('#editor_milkdown_container'), handleEvent(name, handler) { window.events[name] = handler; }, pushEventTo(_target, event, _payload, onReply) { if (event.endsWith(':reset_to_default')) window.events['smart_input:reset']?.(); onReply?.(); } }; // LiveView dispatches the reply's events before onReply
document.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  window.submitted = new FormData(event.target).get('body');
});
document.querySelector('form').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }
});
window.hook.mounted();
</script></body></html>`;

before(async () => {
  const entries = { 'editor': './test/editor_fixture.js', 'hook': '../lib/web/components/composer/milkdown.hooks.js' };
  const bundled = await build({ absWorkingDir: assets, entryPoints: entries, bundle: true, format: 'esm', target: 'es2020', outdir: '/virtual', write: false });
  const files = new Map(bundled.outputFiles.map(file => ['/' + file.path.split('/').at(-1), file.text]));
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.url.startsWith('/api/tag/')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{ id: '@alice', name: 'Alice' }, { id: '@albert', name: 'Albert' }]));
      return;
    }
    response.setHeader('Content-Type', files.has(pathname) ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    response.end(files.get(pathname) || html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.MILKDOWN_BROWSER_EXECUTABLE });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});
beforeEach(async () => {
  pageErrors.length = 0;
  page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.stack));
  page.on('console', message => {
    if (message.type() === 'info' || message.type() === 'error') console.info(`[browser ${message.type()}] ${message.text()}`);
  });
});
afterEach(async () => {
  await page.close();
  assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
});
async function openEditor() {
  await page.goto(origin);
  await page.waitForFunction(() => window.hook?._ready);
}
const text = value => ({ type: 'text', text: value });
const paragraph = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });

test('same-tick form submission and FormData include the current document', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('Just typed'));
    document.querySelector('form').requestSubmit();
    view.dispatch(view.state.tr.insertText(' again'));
    return { submitted, snapshot: new FormData(document.querySelector('form')).get('body') };
  });
  assert.equal(result.submitted.trim(), 'Just typed');
  assert.equal(result.snapshot.trim(), 'Just typed again');
});

test('form snapshots preserve the pending input notification and blur does not duplicate it', async () => {
  await openEditor();
  await page.evaluate(() => {
    const input = document.querySelector('#editor_hidden_input');
    window.inputValues = [];
    input.addEventListener('input', () => inputValues.push(input.value));
    editorTest.view().dispatch(editorTest.view().state.tr.insertText('Draft'));
    window.snapshot = new FormData(input.form).get('body');
  });
  await page.waitForFunction(() => inputValues.length === 1);
  await page.evaluate(() => editorTest.view().dom.dispatchEvent(new Event('blur')));
  assert.deepEqual(await page.evaluate(() => ({ snapshot, inputValues })), {
    snapshot: 'Draft\n', inputValues: ['Draft\n'],
  });
});

test('blur flushes a pending draft notification after a form snapshot', async () => {
  await openEditor();
  const values = await page.evaluate(() => {
    const input = document.querySelector('#editor_hidden_input');
    const values = [];
    input.addEventListener('input', () => values.push(input.value));
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('Draft'));
    new FormData(input.form);
    view.dom.dispatchEvent(new Event('blur'));
    return values;
  });
  assert.deepEqual(values, ['Draft\n']);
});

test('literal URL punctuation survives serialization without becoming Markdown formatting', async () => {
  await openEditor();
  const values = ['https://example.com/a*b*c', 'https://example.com/a`b`c', 'https://example.com/a_b_c', 'https://example.com/a~b~c', 'https://example.com/?a=1&b=2', 'https://example.com/?a=1&copy;'];
  for (const value of values) {
    const json = doc(paragraph(text(value)));
    const result = await page.evaluate(json => {
      editorTest.setDoc(json, 1);
      return editorTest.roundTrip();
    }, json);
    assert.deepEqual(result, json);
  }
});

test('root updates and reconnect do not replace newer typing', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('Unsaved edit'));
    hook.el.dataset.suggestion = 'older server value';
    hook.updated?.();
    hook.reconnected();
    return { document: view.state.doc.textContent, input: document.querySelector('#editor_hidden_input').value };
  });
  assert.equal(result.document, 'Unsaved edit');
  assert.equal(result.input.trim(), 'Unsaved edit');
});

test('serialization preserves backslashes, NBSP and zero-width spaces in code', async () => {
  await openEditor();
  const json = doc({ type: 'code_block', attrs: { language: '' }, content: [text('\\\n\nkeep\u00a0\u200b')] }, paragraph({ ...text('https://example.org/a\\_b'), marks: [{ type: 'inlineCode' }] }));
  const result = await page.evaluate(json => {
    editorTest.setDoc(json, 1);
    return editorTest.roundTrip();
  }, json);
  assert.equal(result.content[0].content[0].text, '\\\n\nkeep\u00a0\u200b');
  assert.equal(result.content[1].content[0].text, 'https://example.org/a\\_b');
});

test('code is submitted verbatim, with quotes, ampersands and angle brackets unescaped', async () => {
  await openEditor();
  const code = 'IO.puts("Hello world") && a < b > c &amp;';
  const json = doc({ type: 'code_block', attrs: { language: 'elixir' }, content: [text(code)] }, paragraph({ ...text(code), marks: [{ type: 'inlineCode' }] }));
  const markdown = await page.evaluate(json => {
    editorTest.setDoc(json, 1);
    document.querySelector('form').requestSubmit();
    return submitted;
  }, json);
  assert.equal(markdown, '```elixir\n' + code + '\n```\n\n`' + code + '`\n');
});

test('social tokens stay usable and blank hard-break lines become paragraphs', async () => {
  await openEditor();
  const result = await page.evaluate(json => {
    editorTest.setDoc(json, 1);
    return { markdown: editorTest.serialize(), parsed: editorTest.roundTrip() };
  }, doc(paragraph(text('@foo_bar #日本語 https://example.org/?a=1&b=2'), { type: 'hardbreak' }, { type: 'hardbreak' }, text('Next paragraph'))));
  assert.match(result.markdown, /@foo_bar #日本語 https:\/\/example.org\/\?a=1&b=2/);
  assert.equal(result.parsed.content[0].type, 'paragraph');
  assert.equal(result.parsed.content[1].type, 'paragraph');
  assert.equal(result.parsed.content[1].content[0].text, 'Next paragraph');
});

test('single hard breaks and escaped link destinations round-trip', async () => {
  await openEditor();
  const result = await page.evaluate(json => {
    editorTest.setDoc(json, 1);
    return editorTest.roundTrip();
  }, doc(paragraph(text('first'), { type: 'hardbreak' }, { ...text('wiki'), marks: [{ type: 'link', attrs: { href: 'https://example.org/a_(b)?a=1&b=2', title: null } }] })));
  assert.equal(result.content[0].content[1].type, 'hardbreak');
  assert.equal(result.content[0].content[2].marks[0].attrs.href, 'https://example.org/a_(b)?a=1&b=2');
});

test('mention matching never crosses paragraphs or inline atoms', async () => {
  await openEditor();
  const results = await page.evaluate(json => {
    editorTest.setDoc(json, 9);
    const crossParagraph = editorTest.getMentionMatchInfo(editorTest.view().state);
    const view = editorTest.view();
    const inline = { type: 'doc', content: [{ type: 'paragraph', content: [{type:'text',text:'@al'}, {type:'image',attrs:{src:'/x'}}, {type:'text',text:'ice'}] }] };
    editorTest.setDoc(inline, 8);
    return [crossParagraph, editorTest.getMentionMatchInfo(view.state)];
  }, doc(paragraph(text('@al')), paragraph(text('ice'))));
  assert.deepEqual(results, [null, null]);
});

test('mentions reject selected text, email suffixes, code and stale ranges', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const make = value => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:value}]}]});
    editorTest.setDoc(make('@alice'), 7);
    const view = editorTest.view();
    const previous = editorTest.getMentionMatchInfo(view.state);
    view.dispatch(view.state.tr.insertText('x'));
    const stale = editorTest.insertMention(view.state, previous, '@alice');
    editorTest.setDoc(make('@alice'), 1, 7);
    const selection = editorTest.getMentionMatchInfo(view.state);
    editorTest.setDoc(make('me@alice'), 9);
    const email = editorTest.getMentionMatchInfo(view.state);
    editorTest.setDoc({type:'doc',content:[{type:'code_block',content:[{type:'text',text:'@alice'}]}]}, 7);
    return [stale, selection, email, editorTest.getMentionMatchInfo(view.state)];
  });
  assert.deepEqual(result, [null, null, null, null]);
});

// usernames can have letters and digits in any script, and hosts can be IDNs
test('mentions match non-ASCII and dotted handles', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const make = value => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:value}]}]});
    return ['@josé', '@你好', '@first.last', '@josé@bücher.local', '@你好@你好.local'].map(value => {
      editorTest.setDoc(make(value), value.length + 1);
      return editorTest.getMentionMatchInfo(editorTest.view().state)?.query;
    });
  });
  assert.deepEqual(result, ['josé', '你好', 'first.last', 'josé@bücher.local', '你好@你好.local']);
});

// a handle may be typed with any prefix we read: `@` for people, `&` or `!` for groups (`!` is the threadiverse's), `+` for topics. The prefix typed is the one the search asks for and the one inserted
test('mentions match and keep every handle prefix', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const make = value => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:value}]}]});
    return ['@alice', '&group', '!group', '+topic', '!group@lemmy.local'].map(value => {
      editorTest.setDoc(make(value), value.length + 1);
      const view = editorTest.view();
      const match = editorTest.getMentionMatchInfo(view.state);
      // the server's id carries the prefix asked for, and one without gets the prefix typed
      const fromServer = editorTest.insertMention(view.state, match, `${match?.prefix}${match?.query}`)?.doc.textContent;
      const bare = editorTest.insertMention(view.state, match, match?.query)?.doc.textContent;
      return [match?.prefix, match?.query, fromServer, bare];
    });
  });
  assert.deepEqual(result, [
    ['@', 'alice', '@alice ', '@alice '],
    ['&', 'group', '&group ', '&group '],
    ['!', 'group', '!group ', '!group '],
    ['+', 'topic', '+topic ', '+topic '],
    ['!', 'group@lemmy.local', '!group@lemmy.local ', '!group@lemmy.local '],
  ]);
});

test('underscores in non-ASCII mentions are not escaped on submit', async () => {
  await openEditor();
  const markdown = await page.evaluate(() => {
    editorTest.setDoc({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'@你好_x and @josé_y'}]}]}, 1);
    return editorTest.serialize();
  });
  assert.equal(markdown, '@你好_x and @josé_y\n');
});

test('mention clicks replace the current match without interfering with submit shortcuts', async () => {
  await openEditor();
  await page.locator('.ProseMirror').fill('@al');
  await page.waitForSelector('.milkdown-menu[data-show="true"]');
  await page.locator('.milkdown-menu button').nth(1).click();
  assert.equal(await page.evaluate(() => editorTest.view().state.doc.textContent), '@albert ');
  await page.evaluate(() => editorTest.replace(''));
  await page.locator('.ProseMirror').fill('@al');
  await page.waitForSelector('.milkdown-menu[data-show="true"]');
  await page.keyboard.press('Control+Enter');
  assert.equal((await page.evaluate(() => submitted)).trim(), '@al');
  assert.equal(await page.evaluate(() => editorTest.view().state.doc.textContent), '@al');
});

test('previous mention results stay visible and usable while the next query loads', async () => {
  await openEditor();
  await page.locator('.ProseMirror').fill('@al');
  await page.waitForSelector('.milkdown-menu[data-show="true"]');
  let release;
  const held = new Promise(resolve => release = resolve);
  await page.route('**/api/tag/**', async route => { await held; await route.fulfill({ json: [] }); });
  const request = page.waitForRequest('**/api/tag/**');
  await page.keyboard.type('i');
  await request;
  assert.equal(await page.locator('.milkdown-menu[data-show="true"] button').count(), 2);
  await page.locator('.milkdown-menu button').first().click();
  assert.equal(await page.evaluate(() => editorTest.view().state.doc.textContent), '@alice ');
  release();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.milkdown-menu[data-show="true"]').count(), 0);
});

test('an empty response hides the previous mention results', async () => {
  await openEditor();
  await page.locator('.ProseMirror').fill('@al');
  await page.waitForSelector('.milkdown-menu[data-show="true"]');
  await page.route('**/api/tag/**', route => route.fulfill({ json: [] }));
  await page.keyboard.type('z');
  await page.waitForSelector('.milkdown-menu[data-show="false"]', { state: 'attached' });
});

test('stale autocomplete responses cannot reopen a dismissed menu', async () => {
  let release;
  const held = new Promise(resolve => release = resolve);
  await page.route('**/api/tag/**', async route => { await held; await route.fulfill({ json: [{id:'@alice', name:'Alice'}] }); });
  await openEditor();
  const request = page.waitForRequest('**/api/tag/**');
  await page.locator('.ProseMirror').fill('@al');
  await request;
  await page.locator('.ProseMirror').fill('plain text');
  release();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.ProseMirror').innerText(), 'plain text');
  assert.equal(await page.locator('.milkdown-menu[data-show="true"]').count(), 0);
});

test('paste respects HTML and keeps Markdown syntax literal inside code', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    const paste = (plain, html = '') => {
      const data = new DataTransfer();
      data.setData('text/plain', plain);
      if (html) data.setData('text/html', html);
      editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    };
    paste('[link](https://example.org)', '<p><strong>HTML wins</strong></p>');
    const rich = editorTest.view().state.doc.toJSON();
    editorTest.setDoc({type:'doc',content:[{type:'code_block'}]}, 1);
    paste('[link](https://example.org)');
    const code = editorTest.view().state.doc.toJSON();
    editorTest.setDoc({type:'doc',content:[{type:'paragraph'}]}, 1);
    paste('[link](https://example.org)');
    return {rich, code, markdown:editorTest.view().state.doc.toJSON()};
  });
  assert.equal(result.rich.content[0].content[0].text, 'HTML wins');
  assert.equal(result.rich.content[0].content[0].marks[0].type, 'strong');
  assert.equal(result.code.content[0].content[0].text, '[link](https://example.org)');
  assert.equal(result.markdown.content[0].content[0].marks[0].type, 'link');
});

// Steps: typed text, { key }, { paste, html } or { setDoc, pos }
async function typeSteps(...steps) {
  await openEditor();
  await page.focus('.ProseMirror');
  for (const step of steps) {
    if (step.key) {
      await page.keyboard.press(step.key);
      // ProseMirror reads native cursor moves on the async selectionchange
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => {
        const view = editorTest.view(), selection = document.getSelection();
        return view.state.selection.head === view.posAtDOM(selection.focusNode, selection.focusOffset);
      });
    }
    else if (step.setDoc) await page.evaluate(({ setDoc, pos }) => editorTest.setDoc(setDoc, pos), step);
    else if (step.paste) await page.evaluate(({ paste, html }) => {
      const data = new DataTransfer();
      data.setData('text/plain', paste);
      if (html) data.setData('text/html', html);
      editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, step);
    else await page.keyboard.type(step);
  }
  return page.evaluate(() => ({ doc: editorTest.view().state.doc.toJSON(), markdown: editorTest.serialize() }));
}
const linked = (value, href, title = null, marks = []) => ({ ...text(value), marks: [...marks, { type: 'link', attrs: { href, title } }] });

for (const { id, steps, markdown, todo } of contentCases) {
  test(`composer content ${id} sends the expected Markdown`, { todo }, async () => {
    assert.equal((await typeSteps(...steps)).markdown, markdown);
  });
}

test('a link URL typed into ready-made brackets converts when typing continues after them', async () => {
  const inside = await typeSteps('[a]()', { key: 'ArrowLeft' }, 'https://example.com');
  assert.deepEqual(inside.doc, doc(paragraph(text('[a](https://example.com)'))));
  const result = await typeSteps('[a]()', { key: 'ArrowLeft' }, 'https://example.com', { key: 'End' }, ' ok');
  assert.deepEqual(result.doc, doc(paragraph(linked('a', 'https://example.com'), text(' ok'))));
  assert.equal(result.markdown, '[a](https://example.com) ok\n');
});

test('a link converts when its opening bracket is typed last', async () => {
  const result = await typeSteps('a](https://example.com)', { key: 'Home' }, '[', { key: 'End' }, ' ok');
  assert.deepEqual(result.doc, doc(paragraph(linked('a', 'https://example.com'), text(' ok'))));
});

test('a link URL pasted into ready-made brackets converts when typing continues after them', async () => {
  const result = await typeSteps('[a]()', { key: 'ArrowLeft' }, { paste: 'https://example.com' }, { key: 'End' }, ' ok');
  assert.deepEqual(result.doc, doc(paragraph(linked('a', 'https://example.com'), text(' ok'))));
});

test('a link URL with balanced brackets keeps them', async () => {
  const result = await typeSteps('[w](https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.deepEqual(result.doc, doc(paragraph(linked('w', 'https://en.wikipedia.org/wiki/Foo_(bar)'))));
});

test('a typed link title is stored on the link', async () => {
  const result = await typeSteps('[a](https://example.com "t")');
  assert.deepEqual(result.doc, doc(paragraph(linked('a', 'https://example.com', 't'))));
});

test('formatting inside link text survives the conversion', async () => {
  const result = await typeSteps('[**a** b](https://example.com)');
  const [bold, rest] = result.doc.content[0].content;
  assert.deepEqual(bold, linked('a', 'https://example.com', null, [{ type: 'strong', attrs: { marker: '*' } }]));
  assert.deepEqual(rest.marks, [{ type: 'link', attrs: { href: 'https://example.com', title: null } }]);
});

test('link text typed into ready-made brackets stays whole', async () => {
  const result = await typeSteps('[](https://example.com)', { key: 'Home' }, { key: 'ArrowRight' }, 'abc', { key: 'End' }, ' ok');
  assert.deepEqual(result.doc, doc(paragraph(linked('abc', 'https://example.com'), text(' ok'))));
});

test('a literal link loaded from a draft stays literal while typing', async () => {
  const draft = await openWithDraftAndType('\\[a]\\(https://example.com)', 'x');
  assert.equal(draft.text, '[a](https://example.com) x');
});

test('a range selection over a waiting link leaves the text alone', async () => {
  const result = await typeSteps('[a]()', { key: 'ArrowLeft' }, 'https://example.com', { key: 'Shift+End' });
  assert.deepEqual(result.doc, doc(paragraph(text('[a](https://example.com)'))));
});

test('a quoted title may hold a closing bracket', async () => {
  const result = await typeSteps('[a](https://example.com "x)")');
  assert.deepEqual(result.doc, doc(paragraph(linked('a', 'https://example.com', 'x)'))));
});

test('a pasted single newline shows as a line break in the composer, as it does in the post', async () => {
  await typeSteps({ paste: 'a\nb' });
  assert.equal(await page.evaluate(() => document.querySelector('.ProseMirror').innerText), 'a\nb');
});

// A real Chromium IME composition
test('a closing bracket typed through an IME converts after the composition, not during it', async () => {
  await typeSteps('[a](https://example.com');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: ')', selectionStart: 1, selectionEnd: 1 });
  const composing = await page.evaluate(() => editorTest.view().state.doc.textContent);
  await cdp.send('Input.insertText', { text: ')' });
  await page.waitForFunction(() => editorTest.view().state.doc.firstChild.firstChild?.marks.length);
  assert.equal(composing, '[a](https://example.com)');
  assert.deepEqual(await page.evaluate(() => editorTest.view().state.doc.toJSON()), doc(paragraph(linked('a', 'https://example.com'))));
});

test('link conversion leaves code alone', async () => {
  await openEditor();
  const code = await page.evaluate(async source => {
    const typeAtEnd = async (json, end) => {
      editorTest.setDoc(json, end);
      const view = editorTest.view();
      view.dispatch(view.state.tr.insertText(')'));
      return view.state.doc.toJSON();
    };
    return [
      await typeAtEnd({type:'doc',content:[{type:'code_block',content:[{type:'text',text:source}]}]}, source.length + 1),
      await typeAtEnd({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:source,marks:[{type:'inlineCode'}]}]}]}, source.length + 1),
    ];
  }, '[a](https://example.com');
  assert.ok(!JSON.stringify(code).includes('"link"'));
});

test('link conversion leaves images alone', async () => {
  const image = await typeSteps('![a](https://example.com/x.png)');
  assert.ok(!JSON.stringify(image.doc).includes('"link"'));
});

test('link conversion keeps mention text, and text typed after a link is not linked', async () => {
  const mention = await typeSteps('@foo_bar [a](https://example.com) x');
  assert.equal(mention.markdown, '@foo_bar [a](https://example.com) x\n');
});

test('reply insertion preserves a trailing space without a sentinel and reset flushes immediately', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    events.mention_suggestions({text:'foo_bar'});
    const mention = editorTest.view().state.doc.textContent;
    const caret = editorTest.view().state.selection.from;
    const markdown = editorTest.serialize();
    events['smart_input:reset']({});
    return {mention, caret, markdown, input: document.querySelector('#editor_hidden_input').value};
  });
  assert.equal(result.mention, '@foo_bar ');
  assert.equal(result.caret, 10);
  assert.equal(result.markdown, '@foo_bar \n');
  assert.equal(result.input.trim(), '');
});

test('typing after a reply mention keeps the space', async () => {
  const warnings = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await openEditor();
  await page.evaluate(() => events.mention_suggestions({text:'foo_bar'}));
  await page.keyboard.type('hi');
  const result = await page.evaluate(() => ({
    text: editorTest.view().state.doc.textContent,
    markdown: editorTest.serialize(),
  }));
  assert.deepEqual(result, {text: '@foo_bar hi', markdown: '@foo_bar hi\n'});
  assert.deepEqual(warnings.filter(warning => warning.includes('white-space')), []);
});

// Drafts are restored the way bonfire_live.js stores them: the serialized Markdown, from localStorage
async function openWithDraftAndType(draft, typed) {
  await page.addInitScript(draft => { window.Bonfire = { getComposerDraft: () => draft }; }, draft);
  await openEditor();
  if (typed) {
    await page.focus('.ProseMirror');
    await page.keyboard.press('End');
    await page.keyboard.type(typed);
  }
  return page.evaluate(() => ({
    text: editorTest.view().state.doc.textContent,
    markdown: editorTest.serialize(),
  }));
}

test('a restored draft keeps its trailing space when typing', async () => {
  assert.deepEqual(await openWithDraftAndType('@foo_bar \n', 'hi'), {text: '@foo_bar hi', markdown: '@foo_bar hi\n'});
});

test('every restored draft continues after a space', async () => {
  assert.deepEqual(await openWithDraftAndType('hello\n', 'hi'), {text: 'hello hi', markdown: 'hello hi\n'});
});

test('a restored draft ending in a link continues after the link', async () => {
  assert.deepEqual(await openWithDraftAndType('see [a](https://example.com)\n', 'hi'), {text: 'see a hi', markdown: 'see [a](https://example.com) hi\n'});
});

test('a restored draft ending in a code block gets no extra space', async () => {
  const draft = '```\ncode\n```\n';
  assert.deepEqual(await openWithDraftAndType(draft), {text: 'code', markdown: draft});
});

test('destroying during lazy loading leaves no editor or pending update', async () => {
  let release;
  const held = new Promise(resolve => release = resolve);
  await page.route('**/editor.js', async route => { await held; await route.continue(); });
  const requested = page.waitForRequest('**/editor.js');
  await page.goto(origin);
  await requested;
  await page.evaluate(() => hook.destroyed());
  release();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.ProseMirror').count(), 0);
});

test('destroy cancels the pending content notification', async () => {
  await openEditor();
  await page.evaluate(async () => {
    window.notifications = 0;
    document.querySelector('#editor_hidden_input').addEventListener('input', () => notifications++);
    editorTest.view().dispatch(editorTest.view().state.tr.insertText('pending'));
    await hook._mod.destroy(hook);
  });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => notifications), 0);
});

test('placeholder uses the translated label only for an empty document', async () => {
  await openEditor();
  assert.equal(await page.locator('.is-empty').getAttribute('data-placeholder'), 'Scrivi qualcosa…');
  await page.evaluate(json => editorTest.setDoc(json, 1), doc(paragraph(), paragraph()));
  assert.equal(await page.locator('.is-empty').count(), 0);
});

test('mention requests are disabled for messages and ordinary typing emits one debounced update', async () => {
  await openEditor();
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/api/tag/')) requests++; });
  await page.evaluate(() => {
    hook.el.dataset.disableMentions = 'true';
    window.notifications = 0;
    document.querySelector('#editor_hidden_input').addEventListener('input', () => notifications++);
  });
  await page.locator('.ProseMirror').fill('@alice');
  await page.waitForFunction(() => document.querySelector('#editor_hidden_input').value.includes('@alice'));
  assert.equal(requests, 0);
  assert.equal(await page.evaluate(() => notifications), 1);
});

test('typing enables a disabled Post button without a server reply, empty text leaves it disabled', async () => {
  await openEditor();
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'submit_btn';
    button.disabled = true;
    document.querySelector('form').append(button);
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('   '));
    hook._flushEditor();
  });
  assert.equal(await page.evaluate(() => document.querySelector('#submit_btn').disabled), true);
  await page.evaluate(() => editorTest.view().dispatch(editorTest.view().state.tr.insertText('Hi')));
  await page.waitForFunction(() => !document.querySelector('#submit_btn').disabled);
});

test('editor blur passes a blur to the hidden field, so phx-debounce="blur" sends the change', async () => {
  await openEditor();
  const events = await page.evaluate(() => {
    const input = document.querySelector('#editor_hidden_input');
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('Draft'));
    hook._flushEditor();
    const events = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('blur', () => events.push('blur'));
    view.dispatch(view.state.tr.insertText(' more'));
    view.dom.dispatchEvent(new Event('blur'));
    return events;
  });
  assert.deepEqual(events, ['input', 'blur']);
});

test('a submit in progress keeps a disabled Post button disabled', async () => {
  await openEditor();
  const result = await page.evaluate(async () => {
    const form = document.querySelector('form');
    const button = document.createElement('button');
    button.id = 'submit_btn';
    form.append(button);
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('Posting now'));
    // what LiveView does on submit: lock the form, disable Post, then serialise
    form.classList.add('phx-submit-loading');
    button.disabled = true;
    const body = new FormData(form).get('body');
    await new Promise(resolve => setTimeout(resolve, 300));
    return { body, disabled: button.disabled };
  });
  assert.equal(result.body.trim(), 'Posting now');
  assert.equal(result.disabled, true);
});

test('the server hears at once when text appears or is cleared, not on other typing', async () => {
  await openEditor();
  const blurs = await page.evaluate(() => {
    const input = document.querySelector('#editor_hidden_input');
    let blurs = 0;
    input.addEventListener('blur', () => blurs++);
    const view = editorTest.view();
    const counts = [];
    view.dispatch(view.state.tr.insertText('Hi'));
    hook._flushEditor(); counts.push(blurs);
    view.dispatch(view.state.tr.insertText(' there'));
    hook._flushEditor(); counts.push(blurs);
    view.dispatch(view.state.tr.delete(1, view.state.doc.content.size - 1));
    hook._flushEditor(); counts.push(blurs);
    return counts;
  });
  assert.deepEqual(blurs, [1, 1, 2]);
});

test('a restored draft puts the caret at the end, so typing continues it', async () => {
  await page.addInitScript(() => { window.Bonfire = { getComposerDraft: () => 'Restored draft\n' }; });
  await openEditor();
  await page.evaluate(() => events['focus-editor']());
  await page.keyboard.type('X');
  assert.equal(await page.evaluate(() => editorTest.view().state.doc.textContent), 'Restored draft X');
});

// Reply buttons on feed items (bonfire_ui_social reply_live.sface): data-id="action_reply", phx-value-id = the post
async function clickReplyWith(answer, replyToId = '', { connected = true, serverAnswers = true } = {}) {
  await openEditor();
  return page.evaluate(async ({ answer, replyToId, connected, serverAnswers }) => {
    hook.liveSocket = { isConnected: () => connected };
    if (!serverAnswers) hook.pushEventTo = () => {}; // a push LiveView rejects (socket down) never calls back
    const form = document.querySelector('form');
    form.insertAdjacentHTML('beforeend', `<input type="hidden" name="reply_to[reply_to_id]" value="${replyToId}">`);
    document.body.insertAdjacentHTML('beforeend', '<button type="button" data-id="action_reply" phx-value-id="post-2">Reply</button>');
    const view = editorTest.view();
    view.dispatch(view.state.tr.insertText('My post draft'));
    hook._flushEditor();
    let asked = 0, reachedLiveView = 0;
    window.confirm = () => { asked++; return answer; };
    window.addEventListener('click', () => reachedLiveView++); // LiveView listens to clicks on window, bubble phase
    document.querySelector('[data-id="action_reply"]').click();
    await new Promise(resolve => setTimeout(resolve, 300));
    return { asked, reachedLiveView, text: view.state.doc.textContent, value: document.querySelector('#editor_hidden_input').value };
  }, { answer, replyToId, connected, serverAnswers });
}

test('Reply with a new-post draft asks first; declining keeps the draft and stops the reply', async () => {
  assert.deepEqual(await clickReplyWith(false), { asked: 1, reachedLiveView: 0, text: 'My post draft', value: 'My post draft\n' });
});

test('Reply with a new-post draft asks first; accepting clears the draft before the reply opens', async () => {
  const result = await clickReplyWith(true);
  assert.equal(result.asked, 1);
  assert.equal(result.reachedLiveView, 1);
  assert.equal(result.text, '');
});

test('Reply while disconnected asks nothing and keeps the draft', async () => {
  const result = await clickReplyWith(true, '', { connected: false });
  assert.deepEqual([result.asked, result.text], [0, 'My post draft']);
});

test('accepting keeps the draft when the server never confirms the reset', async () => {
  const result = await clickReplyWith(true, '', { serverAnswers: false });
  assert.deepEqual([result.asked, result.reachedLiveView, result.text], [1, 0, 'My post draft']);
});

test('the text is read-only while the form is being sent, and editable again after', async () => {
  await openEditor();
  const states = await page.evaluate(async () => {
    const form = document.querySelector('form');
    const editable = () => document.querySelector('.ProseMirror').getAttribute('contenteditable');
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));
    const before = editable();
    form.classList.add('phx-submit-loading');
    await tick();
    const sending = editable();
    form.classList.remove('phx-submit-loading');
    await tick();
    return [before, sending, editable()];
  });
  assert.deepEqual(states, ['true', 'false', 'true']);
});

test('a Replace whose answer was lost is released when the socket reconnects', async () => {
  await clickReplyWith(true, '', { serverAnswers: false });
  const states = await page.evaluate(async () => {
    const editable = () => document.querySelector('.ProseMirror').getAttribute('contenteditable');
    const before = editable();
    hook._mod.reconnect(hook);
    await new Promise(resolve => setTimeout(resolve, 20));
    return [before, editable(), document.querySelector('.ProseMirror').textContent];
  });
  assert.deepEqual(states, ['false', 'true', 'My post draft']);
});

test('a reply\'s focus waits until the composer targets that reply', async () => {
  await openEditor();
  const focused = await page.evaluate(async () => {
    const form = document.querySelector('form');
    form.insertAdjacentHTML('beforeend', '<input type="hidden" name="reply_to[reply_to_id]" value="">');
    document.querySelector('.ProseMirror').blur();
    events['focus-editor']({ to: 'smart_input', reply_to: 'post-9' });
    await new Promise(resolve => setTimeout(resolve, 150));
    const early = document.activeElement?.classList.contains('ProseMirror');
    document.querySelector('[name="reply_to[reply_to_id]"]').value = 'post-9';
    await new Promise(resolve => setTimeout(resolve, 250));
    return [early, document.activeElement?.classList.contains('ProseMirror')];
  });
  assert.deepEqual(focused, [false, true]);
});

test('after OK on Replace the text stays read-only until the server\'s reset', async () => {
  const result = await clickReplyWith(true, '', { serverAnswers: false });
  const states = await page.evaluate(async () => {
    const editable = () => document.querySelector('.ProseMirror').getAttribute('contenteditable');
    const before = editable();
    events['smart_input:reset']();
    await new Promise(resolve => setTimeout(resolve, 20));
    return [before, editable(), document.querySelector('.ProseMirror').textContent];
  });
  assert.equal(result.text, 'My post draft');
  assert.deepEqual(states, ['false', 'true', '']);
});

test('an editor torn down while sending leaves the composer controls usable', async () => {
  await openEditor();
  const states = await page.evaluate(async () => {
    const form = document.querySelector('form');
    const container = document.querySelector('#smart_input_container');
    form.classList.add('phx-submit-loading');
    await new Promise(resolve => setTimeout(resolve, 20));
    const sending = container.hasAttribute('data-sending');
    await hook._mod.destroy(hook);
    return [sending, container.hasAttribute('data-sending')];
  });
  assert.deepEqual(states, [true, false]);
});

test('accepting focuses the editor once the composer replies to that post', async () => {
  await clickReplyWith(true);
  const focused = await page.evaluate(async () => {
    document.querySelector('.ProseMirror').blur();
    document.querySelector('[name="reply_to[reply_to_id]"]').value = 'post-2'; // what the server's reply sets
    await new Promise(resolve => setTimeout(resolve, 300));
    return document.activeElement?.classList.contains('ProseMirror');
  });
  assert.equal(focused, true);
});

test('pressing a control marked data-keep-editor-focus keeps the editor focused', async () => {
  await openEditor();
  const prevented = await page.evaluate(() => {
    hook.el.insertAdjacentHTML('beforeend', '<button type="button" data-keep-editor-focus>Original post</button>');
    document.querySelector('.ProseMirror').focus();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    hook.el.querySelector('[data-keep-editor-focus]').dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, true);
});

test('Reply on the post already being replied to does not ask', async () => {
  const result = await clickReplyWith(false, 'post-2');
  assert.deepEqual([result.asked, result.reachedLiveView, result.text], [0, 1, 'My post draft']);
});

// "Insert in text" on an upload preview: the file isn't uploaded yet, so its place is `upload:<ref>` (swapped for its URL at publish), shown meanwhile from the preview LiveView made for it
const previewSrc = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

test('inserting markdown at the cursor places an upload as an image, sent as upload:<ref>', async () => {
  await openEditor();
  const result = await page.evaluate(async () => {
    window.events.insert_at_cursor({ text: '![](upload:7)', markdown: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    // not counting the separator ProseMirror adds after an inline node that ends its line
    return { markdown: editorTest.serialize(), images: editorTest.view().dom.querySelectorAll('img:not(.ProseMirror-separator)').length };
  });
  assert.equal(result.markdown, '![](upload:7)\n\n');
  assert.equal(result.images, 1);
});

test('an upload placed in the text shows from its preview, not from upload:<ref>', async () => {
  await openEditor();
  const shown = await page.evaluate(async src => {
    document.body.insertAdjacentHTML('beforeend', `<img data-phx-entry-ref="7" src="${src}">`);
    window.events.insert_at_cursor({ text: '![](upload:7)', markdown: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    return editorTest.view().dom.querySelector('img')?.getAttribute('src');
  }, previewSrc);
  assert.equal(shown, previewSrc);
});

// an upload preview's "Insert in text" button dispatches this on the editor, without a server round trip
test('a bonfire:insert_at_cursor DOM event on the editor inserts as the server event does', async () => {
  await openEditor();
  const markdown = await page.evaluate(async () => {
    hook.el.dispatchEvent(new CustomEvent('bonfire:insert_at_cursor', { detail: { text: '![](upload:7)', markdown: true }, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return editorTest.serialize();
  });
  assert.equal(markdown, '![](upload:7)\n\n');
});

// pasted or dropped files go to the composer's LiveView upload (`uploadTo`, stubbed here: it records the call and gives each file a ref, as LiveView does), and an image, video or audio is placed where the cursor is
// `refDelay`: LiveView gives a file its ref when it sends the form's change, which can be debounced, so after `uploadTo` returns
async function withUploadStub(refDelay = null) {
  await openEditor();
  await page.evaluate(refDelay => {
    window.uploadedTo = [];
    let nextRef = 100;
    hook.uploadTo = (target, name, files) => {
      const giveRefs = () => { for (const file of files) file._phxRef = String(nextRef++); };
      if (refDelay === null) giveRefs();
      else setTimeout(giveRefs, refDelay);
      uploadedTo.push({ target: typeof target === 'string' ? target : target?.id, name, names: Array.from(files).map(file => file.name) });
    };
  }, refDelay);
}

// LiveView's preview of the entry (`<img data-phx-entry-ref>`) only comes with the server's reply: meanwhile the image shows from the pasted file itself
test('a pasted image shows at once, from the file, before LiveView has a preview of it', async () => {
  await withUploadStub();
  const src = await page.evaluate(async fileTransfer => {
    const transfer = eval(fileTransfer)([['photo.png', 'image/png']]);
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return editorTest.view().dom.querySelector('img:not(.ProseMirror-separator)')?.getAttribute('src');
  }, fileTransfer);
  assert.match(src || '', /^blob:/);
});

// a placed file is alone on its line, as the body needs it to show as media (a URL that ends its line), and what's typed next goes on the line after
test('text typed after a pasted image goes on its own line', async () => {
  await withUploadStub();
  await page.evaluate(async fileTransfer => {
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: eval(fileTransfer)([['photo.png', 'image/png']]), bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }, fileTransfer);
  await page.keyboard.type('test');
  const markdown = await page.evaluate(() => editorTest.serialize());
  assert.equal(markdown, '![](upload:100)\n\ntest\n');
});

test('an image pasted after text on a line goes on the line after it, and what follows on the next', async () => {
  await withUploadStub();
  await page.evaluate(() => editorTest.view().focus());
  await page.keyboard.type('before');
  await page.evaluate(async fileTransfer => {
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: eval(fileTransfer)([['photo.png', 'image/png']]), bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }, fileTransfer);
  await page.keyboard.type('after');
  const markdown = await page.evaluate(() => editorTest.serialize());
  assert.equal(markdown, 'before\n\n![](upload:100)\n\nafter\n');
});

// the same image pasted again isn't uploaded again while the first is still an upload of the composer (its entry in the upload list, `[data-role=upload_entry][data-ref]`): it's placed again, with the same ref
test('the same image pasted twice is uploaded once and placed twice', async () => {
  await withUploadStub();
  const result = await page.evaluate(async fileTransfer => {
    document.querySelector('#composer').insertAdjacentHTML('beforeend', '<div data-role="upload_entry" data-ref="100"></div>');
    const paste = async files => {
      editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: eval(fileTransfer)(files), bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    await paste([['photo.png', 'image/png']]);
    await paste([['photo copy.png', 'image/png']]);
    return { uploads: uploadedTo.length, markdown: editorTest.serialize() };
  }, fileTransfer);
  assert.equal(result.uploads, 1);
  assert.equal(result.markdown, '![](upload:100)\n\n![](upload:100)\n\n');
});

test('control: an image pasted again after its upload was removed is uploaded again', async () => {
  await withUploadStub();
  const uploads = await page.evaluate(async fileTransfer => {
    for (const name of ['photo.png', 'photo copy.png']) {
      editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: eval(fileTransfer)([[name, 'image/png']]), bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return uploadedTo.length;
  }, fileTransfer);
  assert.equal(uploads, 2);
});

// once published, the composer resets and its uploads are gone: the same image pasted in the next post is uploaded for it, even if an entry with the old ref is still in the page (eg. the upload list not patched yet)
test('the same image pasted after the composer reset is uploaded again', async () => {
  await withUploadStub();
  const result = await page.evaluate(async fileTransfer => {
    document.querySelector('#composer').insertAdjacentHTML('beforeend', '<div data-role="upload_entry" data-ref="100"></div>');
    const paste = async name => {
      editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: eval(fileTransfer)([[name, 'image/png']]), bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    await paste('photo.png');
    events['smart_input:reset']();
    await new Promise(resolve => setTimeout(resolve, 50));
    await paste('photo copy.png');
    return { uploads: uploadedTo.length, markdown: editorTest.serialize() };
  }, fileTransfer);
  assert.equal(result.uploads, 2);
  assert.equal(result.markdown, '![](upload:101)\n\n');
});

test('a pasted image is placed once LiveView gives it a ref, even after the paste', async () => {
  await withUploadStub(100);
  const result = await page.evaluate(async fileTransfer => {
    const transfer = eval(fileTransfer)([['photo.png', 'image/png']]);
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    return editorTest.serialize();
  }, fileTransfer);
  assert.equal(result, '![](upload:100)\n\n');
});

const fileTransfer = `(files => { const transfer = new DataTransfer(); for (const [name, type] of files) transfer.items.add(new File(['x'], name, { type })); return transfer; })`;

test('a pasted image is uploaded with the composer and placed in the text', async () => {
  await withUploadStub();
  const result = await page.evaluate(async fileTransfer => {
    const transfer = eval(fileTransfer)([['photo.png', 'image/png']]);
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return { uploadedTo, markdown: editorTest.serialize() };
  }, fileTransfer);
  // the form the editor is in (the test page's is `#composer`)
  assert.deepEqual(result.uploadedTo, [{ target: 'composer', name: 'files', names: ['photo.png'] }]);
  assert.equal(result.markdown, '![](upload:100)\n\n');
});

test('a dropped image is uploaded with the composer and placed in the text', async () => {
  await withUploadStub();
  const result = await page.evaluate(async fileTransfer => {
    const transfer = eval(fileTransfer)([['photo.png', 'image/png']]);
    const rect = editorTest.view().dom.getBoundingClientRect();
    editorTest.view().dom.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: rect.left + 10, clientY: rect.top + 10, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return { uploadedTo, markdown: editorTest.serialize() };
  }, fileTransfer);
  assert.deepEqual(result.uploadedTo.map(upload => upload.names), [['photo.png']]);
  assert.equal(result.markdown, '![](upload:100)\n\n');
});

test('a pasted document is uploaded as an attachment, not placed in the text', async () => {
  await withUploadStub();
  const result = await page.evaluate(async fileTransfer => {
    const transfer = eval(fileTransfer)([['notes.pdf', 'application/pdf']]);
    editorTest.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return { uploadedTo, markdown: editorTest.serialize() };
  }, fileTransfer);
  assert.deepEqual(result.uploadedTo.map(upload => upload.names), [['notes.pdf']]);
  assert.equal(result.markdown.trim(), '');
});

// a composer mode without the editor (a poll's question) takes the same insertion in a plain field, as markdown text
test('a plain field marked data-insert-at-cursor takes the insertion at its cursor', async () => {
  await openEditor();
  const result = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="plain" data-insert-at-cursor value="Which one? ">');
    const field = document.querySelector('#plain');
    field.setSelectionRange(field.value.length, field.value.length);
    let inputs = 0;
    field.addEventListener('input', () => inputs++);
    field.dispatchEvent(new CustomEvent('bonfire:insert_at_cursor', { detail: { text: '![](upload:7)', markdown: true }, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    return { value: field.value, inputs, editor: editorTest.serialize() };
  });
  assert.equal(result.value, 'Which one? ![](upload:7)');
  assert.equal(result.inputs, 1);
  assert.equal(result.editor.trim(), '', 'control: the editor took nothing');
});

// an upload preview's "Insert in text" dispatches on itself: the insertion goes to the plain field last written in (a poll's question or one of its options), else to the editor
test('Insert in text from a button goes to the plain field last focused', async () => {
  await openEditor();
  const result = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="question" data-insert-at-cursor><input id="option" data-insert-at-cursor><button id="insert">Insert in text</button>');
    document.querySelector('#option').focus();
    document.querySelector('#insert').focus();
    document.querySelector('#insert').dispatchEvent(new CustomEvent('bonfire:insert_at_cursor', { detail: { text: '![](upload:7)', markdown: true }, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return { question: document.querySelector('#question').value, option: document.querySelector('#option').value, editor: editorTest.serialize() };
  });
  assert.deepEqual(result, { question: '', option: '![](upload:7)', editor: '' });
});

test('Insert in text from a button goes to the editor when no plain field was written in', async () => {
  await openEditor();
  const markdown = await page.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="insert">Insert in text</button>');
    document.querySelector('#insert').dispatchEvent(new CustomEvent('bonfire:insert_at_cursor', { detail: { text: '![](upload:7)', markdown: true }, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
    return editorTest.serialize();
  });
  assert.equal(markdown, '![](upload:7)\n\n');
});

test('control: inserting without markdown keeps the text literal', async () => {
  await openEditor();
  const markdown = await page.evaluate(async () => {
    window.events.insert_at_cursor({ text: '![](upload:7)' });
    await new Promise(resolve => setTimeout(resolve, 50));
    return editorTest.serialize();
  });
  assert.equal(markdown, '!\\[]\\(upload:7)\n');
});
