import assert from 'node:assert/strict';
import test from 'node:test';
import {formatUserDate,getUserTimeZone,isValidTimeZone,normalizeTimeZone} from '../src/lib/time/utils.ts';

test('list dates reuse Intl formatters while language and user timezone changes apply immediately',t=>{
 let zone='Europe/Berlin';globalThis.window={localStorage:{getItem:()=>JSON.stringify({timeZone:zone})}};globalThis.document={documentElement:{lang:'de-DE'}};t.after(()=>{delete globalThis.window;delete globalThis.document;});
 const original=Intl.DateTimeFormat;let constructions=0;
 t.mock.method(Intl,'DateTimeFormat',function(...args){constructions++;return new original(...args);});
 const options={hour:'2-digit',minute:'2-digit',hourCycle:'h23'},instant='2026-10-25T01:30:00Z';
 const first=formatUserDate(instant,options);
 for(let i=0;i<1000;i++){assert.equal(getUserTimeZone(),'Europe/Berlin');assert.equal(formatUserDate(instant,options),first);}
 assert(constructions<=3,'formatting a list must not construct Intl objects per row');
 zone='America/New_York';assert.equal(formatUserDate(instant,options),new original('de-DE',{...options,timeZone:zone}).format(new Date(instant)));
 document.documentElement.lang='en-US';assert.equal(formatUserDate(instant,{dateStyle:'full'}),new original('en-US',{dateStyle:'full',timeZone:zone}).format(new Date(instant)));
 zone='invalid-zone';assert.equal(isValidTimeZone(zone),false);assert.equal(normalizeTimeZone(zone),'UTC');assert.equal(isValidTimeZone(''),false);
});
