import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// The calendar renders in the device zone; pin it so dates below are unambiguous.
process.env.TZ='Europe/Berlin';
const dir=mkdtempSync(join(process.cwd(),'node_modules','calendar-week-test-'));after(()=>rmSync(dir,{recursive:true,force:true}));
await build({entryPoints:['src/app/(calendar)/calendar/utils.ts'],outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent',alias:{'@':join(process.cwd(),'src')}});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);

test('weeks start on the display language\'s first day, refined by a browser region in the same language',()=>{
 assert.equal(app.firstDayOfWeek('de','en-US'),1,'German weeks start on Monday even in a US-English browser');
 assert.equal(app.firstDayOfWeek('en','en-US'),0);
 assert.equal(app.firstDayOfWeek('en','en-GB'),1,'a British browser moves an English display to Monday');
 assert.equal(app.firstDayOfWeek('en','de-DE'),0,'another language\'s region is not borrowed');
 assert.equal(app.firstDayOfWeek('ar'),6);
 assert.equal(app.firstDayOfWeek('not a locale'),1,'invalid tags fall back to Monday');
});

test('a German week and month grid begin on Monday',()=>{
 const sunday=new Date('2026-11-08T10:00:00Z');
 assert.equal(day(app.startOfWeek(sunday,1)),'2026-11-02');
 assert.equal(day(app.startOfWeek(new Date('2026-11-02T10:00:00Z'),1)),'2026-11-02','Monday is already the start');
 assert.equal(day(app.startOfWeek(sunday,0)),'2026-11-08','a Sunday-first week keeps Sunday');
 assert.equal(day(app.monthGridDates(sunday,1)[0]),'2026-10-26','November 2026 starts on a Sunday, so its grid opens with the previous Monday');
 assert.deepEqual(app.orderedWeekdays(1),[1,2,3,4,5,6,0]);
 assert.deepEqual(app.orderedWeekdays(6),[6,0,1,2,3,4,5]);
});
