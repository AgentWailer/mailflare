import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-snippet-tests-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export {buildReadableSnippet,cleanSnippetText} from './src/lib/email/snippet';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',logLevel:'silent'});
const {buildReadableSnippet,cleanSnippetText}=await import(pathToFileURL(join(dir,'app.mjs')).href);

test('tracking URLs, markdown targets and escaped line breaks give way to actual content',()=>{
 const raw='![Logo](https://tracker.test/logo)\\n[Rechnung ansehen](https://tracker.test/?token=secret)\\nIhre Rechnung über 49,90 Euro ist verfügbar.';
 assert.equal(cleanSnippetText(raw),'Rechnung ansehen Ihre Rechnung über 49,90 Euro ist verfügbar.');
 assert.equal(buildReadableSnippet('https://tracking.test/'+('a'.repeat(400))+'\nGet 33% off today on your next order.',null),'Get 33% off today on your next order.');
});
test('HTML fallback notices use readable HTML content, including the preheader',()=>{
 const text='Please use an email client supporting HTML email, or click this link to view the email online:\nhttps://click.example.test/a';
 const html='<html><head><style>.x{color:red}</style></head><body><div style="display:none">Entdecke unsere neuen Outdoor-Angebote.</div><p>20% Rabatt auf ausgewählte Jacken.</p></body></html>';
 assert.equal(buildReadableSnippet(text,html),'Entdecke unsere neuen Outdoor-Angebote. 20% Rabatt auf ausgewählte Jacken.');
 assert.equal(buildReadableSnippet('https://tracking.test/link','<p>Ihre Bestellung wurde heute versandt.</p>'),'Ihre Bestellung wurde heute versandt.');
});
test('short replies remain intact and old quoted mail is not substituted',()=>{
 assert.equal(buildReadableSnippet('Ja, passt. Danke!\n\nOn Monday Alex wrote:\n> Alte Nachricht mit einer langen Bestellung','<p>Ja, passt. Danke!</p><blockquote>Alte Nachricht</blockquote>'),'Ja, passt. Danke!');
 assert.equal(buildReadableSnippet('Bitte rufe mich an: +49 30 12345. support@example.test',null),'Bitte rufe mich an: +49 30 12345. support@example.test');
});
test('browser boilerplate, invisible padding and numeric entities do not obscure previews',()=>{
 assert.equal(cleanSnippetText('[Diese E-Mail im Browser anzeigen](https://news.test/link)\n&#128230; Paket ist unterwegs &amp; kommt morgen.\u200b'),'📦 Paket ist unterwegs & kommt morgen.');
 assert.equal(buildReadableSnippet(null,null),'');assert.equal(buildReadableSnippet('abc',null,0),'');
 const preview=buildReadableSnippet('Ein verständlicher Satz '.repeat(20),null,200);assert(preview.length<=200);assert(!preview.endsWith('verständli'));
});
