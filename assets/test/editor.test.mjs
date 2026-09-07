import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const assets = fileURLToPath(new URL('..', import.meta.url));
let browser, server, origin, page;
const pageErrors = [];
const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><style>
.hidden, .milkdown-menu[data-show="false"] { display:none }
.milkdown-menu[data-show="true"] { display:block }
.milkdown-menu { position:absolute; background:white; padding:8px; border:1px solid; list-style:none }
#editor { min-height:120px } .ProseMirror { min-height:100px }
</style></head><body><form id="composer">
<div id="editor_milkdown_container" data-editor-bundle="/editor.js">
<input type="hidden" id="editor_hidden_input" name="body" value="" data-persist-draft>
<div id="editor" data-placeholder="Scrivi qualcosa…"></div>
</div><button id="submit" type="submit">Send</button></form>
<script type="module">
import Hook from '/hook.js';
window.events = {};
window.hook = { ...Hook, el: document.querySelector('#editor_milkdown_container'), handleEvent(name, handler) { window.events[name] = handler; } };
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
    return { document: view.state.doc.textContent, input: document.querySelector('input').value };
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

test('reply insertion preserves a trailing space without a sentinel and reset flushes immediately', async () => {
  await openEditor();
  const result = await page.evaluate(() => {
    events.mention_suggestions({text:'foo_bar'});
    const mention = editorTest.view().state.doc.textContent;
    const caret = editorTest.view().state.selection.from;
    const markdown = editorTest.serialize();
    events['smart_input:reset']({});
    return {mention, caret, markdown, input: document.querySelector('input').value};
  });
  assert.equal(result.mention, '@foo_bar ');
  assert.equal(result.caret, 10);
  assert.equal(result.markdown, '@foo_bar \n');
  assert.equal(result.input.trim(), '');
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
    document.querySelector('input').addEventListener('input', () => notifications++);
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
    document.querySelector('input').addEventListener('input', () => notifications++);
  });
  await page.locator('.ProseMirror').fill('@alice');
  await page.waitForFunction(() => document.querySelector('input').value.includes('@alice'));
  assert.equal(requests, 0);
  assert.equal(await page.evaluate(() => notifications), 1);
});
