import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/components/messages/native-app-links.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {preferNativeAmazonLinks}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
test('iOS Home Screen keeps direct Amazon universal links on the user gesture without rewriting destinations',()=>{
 const dom=new JSDOM('<a target="_blank" href="https://www.amazon.de/progress-tracker/package?orderId=123">Track</a><a target="_blank" href="https://amazon.de.evil.test/">Other</a><a target="_blank" href="https://tracker.example/amazon">Tracker</a><a target="_blank" href="http://amazon.de/">HTTP</a>');
 const links=[...dom.window.document.querySelectorAll('a')],url=links[0].href;preferNativeAmazonLinks(dom.window.document,true);assert.equal(links[0].target,'_top');assert.equal(links[0].href,url);assert(links.slice(1).every(a=>a.target==='_blank'));
});
test('desktop and normal browser links preserve existing behavior',()=>{const dom=new JSDOM('<a target="_blank" href="https://www.amazon.de/">Amazon</a>');preferNativeAmazonLinks(dom.window.document,false);assert.equal(dom.window.document.querySelector('a').target,'_blank');});
