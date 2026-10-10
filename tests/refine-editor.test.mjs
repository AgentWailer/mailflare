import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM('', { url: 'https://mailflare.test/' });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'DOMParser']) globalThis[key] = dom.window[key];
const built = await build({ entryPoints: ['src/components/compose/refine-utils.ts'], bundle: true, write: false, platform: 'browser', format: 'esm' });
const { captureRefineTarget, applyRefinement, refinedHtml, previewRefinement } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function editor(html) { const e=document.createElement('div'); e.innerHTML=html; document.body.replaceChildren(e); return e; }
function select(start, startOffset, end=start, endOffset=start.textContent.length) {
 const range=document.createRange(); range.setStart(start,startOffset); range.setEnd(end,endOffset);
 const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection;
}

test('a saved selection replaces only that passage, preserving surrounding markup after focus changes', () => {
 const e=editor('<p>Before <b>bad wording</b> after.</p>');
 const selection=select(e.querySelector('b').firstChild,0);
 const target=captureRefineTarget(e,'selection',selection); assert.equal(target.text,'bad wording');
 selection.removeAllRanges();
 assert.equal(applyRefinement(e,target,'clear wording'),true);
 assert.equal(e.innerHTML,'<p>Before <b>clear wording</b> after.</p>');
});

test('entire email refinement preserves signature and quoted content exactly', () => {
 const e=editor('<p>Please lets meet.</p><div data-mailflare-signature="1"><br><b>Sam</b><img src="/signature.png"></div><div data-mailflare-quote="1">Old message</div>');
 const signature=e.querySelector('[data-mailflare-signature]').outerHTML;
 const quote=e.querySelector('[data-mailflare-quote]').outerHTML;
 const target=captureRefineTarget(e,'message',null);
 assert.equal(target.text,'Please lets meet.'); assert.equal(target.images.length,0);
 assert.equal(applyRefinement(e,target,'Let’s meet.\n\nThank you.'),true);
 assert.equal(e.querySelector('[data-mailflare-signature]').outerHTML,signature);
 assert.equal(e.querySelector('[data-mailflare-quote]').outerHTML,quote);
 assert.equal(e.firstChild.innerHTML,'Let’s meet.<br><br>Thank you.');
});

test('collapsed, external, mixed, signature and quote selections are not refinable', () => {
 const e=editor('<p>Text</p><div data-mailflare-signature="1">Sam</div><div data-mailflare-quote="1">Old</div>');
 assert.equal(captureRefineTarget(e,'selection',select(e.firstChild.firstChild,0,e.firstChild.firstChild,0)),null);
 assert.equal(captureRefineTarget(e,'selection',select(e.querySelector('[data-mailflare-signature]').firstChild,0)),null);
 assert.equal(captureRefineTarget(e,'selection',select(e.querySelector('[data-mailflare-quote]').firstChild,0)),null);
 const other=document.createElement('div'); other.textContent='Other'; document.body.appendChild(other);
 assert.equal(captureRefineTarget(e,'selection',select(other.firstChild,0)),null);
 assert.equal(captureRefineTarget(e,'selection',select(e.firstChild.firstChild,0,other.firstChild,4)),null);
});

test('editing or replacing the original DOM invalidates a pending suggestion', () => {
 const e=editor('<p>Original</p>'); let target=captureRefineTarget(e,'message',null);
 e.firstChild.textContent='New text'; assert.equal(applyRefinement(e,target,'Suggestion'),false); assert.equal(e.textContent,'New text');
 target=captureRefineTarget(e,'selection',select(e.firstChild.firstChild,0));
 const snapshot=e.innerHTML; e.innerHTML=snapshot;
 assert.equal(applyRefinement(e,target,'Suggestion'),false);
});

test('model markup remains literal text and cannot execute', () => {
 const e=editor('<p>Hello</p>'); const target=captureRefineTarget(e,'message',null);
 assert.equal(applyRefinement(e,target,'<script>alert(1)</script>\n<img src=x onerror=alert(1)>'),true);
 assert.equal(e.querySelector('script'),null); assert.equal(e.querySelector('img'),null);
 assert.ok(e.textContent.includes('<script>'));
});

test('inline images keep their original markup and cannot be lost or duplicated by AI output', () => {
 const e=editor('<p>Here is the image:</p><img src="/api/messages/m/attachments/a?preview=1" alt="diagram"><p>Thanks.</p>');
 const original=e.querySelector('img').outerHTML; const target=captureRefineTarget(e,'message',null);
 assert.equal(target.images.length,1); assert.ok(target.text.includes(target.images[0].token));
 assert.equal(refinedHtml(target,'No image'),null);
 assert.equal(refinedHtml(target,target.text+target.images[0].token),null);
 assert.equal(applyRefinement(e,target,target.text.replace('Here is the image:','Please see the image:')),true);
 assert.equal(e.querySelector('img').outerHTML,original);
});

test('an empty or signature-only message cannot be generated', () => {
 assert.equal(captureRefineTarget(editor('<div><br></div>'),'message',null),null);
 assert.equal(captureRefineTarget(editor('<div data-mailflare-signature="1">Sam</div>'),'message',null),null);
 assert.equal(captureRefineTarget(editor('<img src="/x.png">'),'message',null),null);
});


test('selection boundary whitespace is preserved so adjacent words never join', () => {
 const e=editor('<p>Before bad phrase after</p>');
 const target=captureRefineTarget(e,'selection',select(e.firstChild.firstChild,6,e.firstChild.firstChild,18));
 assert.equal(target.text,'bad phrase');assert.equal(applyRefinement(e,target,'clear phrase'),true);
 assert.equal(e.textContent,'Before clear phrase after');
});


test('inline preview shows replacement in context without mutating live DOM, range or images', () => {
 const e=editor('<p>Before <b>bad wording</b> after.</p><div data-mailflare-signature="1">Sam</div>');
 const target=captureRefineTarget(e,'selection',select(e.querySelector('b').firstChild,0));
 const original=e.innerHTML; const start=target.range.startContainer;
 assert.equal(previewRefinement(e,target,'clear wording'),'<p>Before <b>clear wording</b> after.</p><div data-mailflare-signature="1">Sam</div>');
 assert.equal(e.innerHTML,original);assert.equal(target.range.startContainer,start);
 assert.equal(applyRefinement(e,target,'clear wording'),true);
});

test('invalid and stale suggestions cannot appear as inline previews', () => {
 const e=editor('<p>Original</p><img src="/image.png">');
 const target=captureRefineTarget(e,'message',null);
 assert.equal(previewRefinement(e,target,'Missing image'),null);
 assert.ok(previewRefinement(e,target,target.text).includes('<img src="/image.png">'));
 e.firstChild.textContent='New text';assert.equal(previewRefinement(e,target,target.text),null);
});


test('an empty editable range accepts a new reply while preserving the signature and quoted history', () => {
 const e=editor('<div><br></div><div data-mailflare-signature="1">Sam</div><div data-mailflare-quote="1">Previous message</div>');
 assert.equal(captureRefineTarget(e,'message',null),null);
 const target=captureRefineTarget(e,'message',null,true);assert.equal(target.text,'');
 const before=e.innerHTML;assert.ok(previewRefinement(e,target,'A proposed answer.').startsWith('<div>A proposed answer.</div>'));assert.equal(e.innerHTML,before);
 assert.equal(applyRefinement(e,target,'A proposed answer.'),true);assert.equal(e.querySelector('[data-mailflare-signature]').textContent,'Sam');assert.equal(e.querySelector('[data-mailflare-quote]').textContent,'Previous message');
});
