export { mountEditor, handleServerEvent, destroy, reconnect } from '../js/milkdown_editor.js';
import { editorViewCtx, parserCtx } from '@milkdown/core';
import { TextSelection } from '@milkdown/prose/state';
import { replaceAll } from '@milkdown/utils';
import { serializeMarkdownForSubmit } from '../js/submit_markdown.js';
import { getMentionMatchInfo, insertMention } from '../js/mentions.js';

window.editorTest = {
  view: () => window.hook.editor.action(ctx => ctx.get(editorViewCtx)),
  replace: markdown => window.hook.editor.action(replaceAll(markdown)),
  serialize: () => window.hook.editor.action(ctx => serializeMarkdownForSubmit(ctx, ctx.get(editorViewCtx).state.doc)),
  roundTrip: () => window.hook.editor.action(ctx => ctx.get(parserCtx)(serializeMarkdownForSubmit(ctx, ctx.get(editorViewCtx).state.doc)).toJSON()),
  setDoc(json, position, end = position) {
    const view = this.view();
    const doc = view.state.schema.nodeFromJSON(json);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    tr.setSelection(TextSelection.create(tr.doc, position, end));
    view.dispatch(tr);
    view.focus();
  },
  getMentionMatchInfo,
  insertMention,
};
