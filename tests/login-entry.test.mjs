import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(process.cwd(),'node_modules','mailflare-login-entry-'));after(()=>rmSync(dir,{recursive:true,force:true}));
writeFileSync(join(dir,'headers.mjs'),'export async function cookies(){return {get:name=>name==="ep_session"&&globalThis.__entryToken?{value:globalThis.__entryToken}:undefined}};');
writeFileSync(join(dir,'navigation.mjs'),'export function redirect(path){throw new Error("REDIRECT "+path)};export const useRouter=()=>({replace:()=>{},refresh:()=>{}});export const usePathname=()=>"/";');
await build({stdin:{contents:`export {default as home} from './src/app/page';export {default as login} from './src/app/(auth)/login/page';export {createSession} from './src/lib/auth/session';export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';`,resolveDir:process.cwd()},outfile:join(dir,'app.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',tsconfig:'tsconfig.json',alias:{'next/headers':join(dir,'headers.mjs'),'next/navigation':join(dir,'navigation.mjs'),'next/link':'next/link.js','cloudflare:workers':'./server/runtime/cloudflare-workers.ts'},logLevel:'silent'});
const app=await import(pathToFileURL(join(dir,'app.mjs')).href);
async function fixture(t){const DB=new app.SqliteDatabase(':memory:');await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));const env={DB,MAILFLARE_RUNTIME:'node'};globalThis.__mailflareNodeEnv=env;t.after(()=>{DB.db.close();delete globalThis.__mailflareNodeEnv;delete globalThis.__entryToken;});return {DB,env};}
const addAdmin=f=>f.DB.db.exec("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES('admin','admin@example.test','hash','Admin','admin',1)");
test('the root renders the login flow directly for anonymous visitors without a landing-page redirect',async t=>{
 const f=await fixture(t);addAdmin(f);const page=await app.home();assert.equal(page.props.mode,'public');assert.equal(page.props.allowAuthenticated,false);assert.equal(page.props.children.props.adding,false);
});
test('a signed-in root request redirects directly to inbox; the add-account entry stays available',async t=>{
 const f=await fixture(t);addAdmin(f);globalThis.__entryToken=await app.createSession(f.env,'admin');await assert.rejects(app.home(),/REDIRECT \/inbox/);
 const page=await app.login({searchParams:Promise.resolve({add:'1'})});assert.equal(page.props.allowAuthenticated,true);assert.equal(page.props.children.props.adding,true);
});
test('expired, disabled and unknown sessions render login instead of entering the mailbox',async t=>{
 const f=await fixture(t);addAdmin(f);globalThis.__entryToken=await app.createSession(f.env,'admin');f.DB.db.exec('UPDATE users SET disabled=1');assert.equal((await app.home()).props.mode,'public');f.DB.db.exec('UPDATE users SET disabled=0;UPDATE sessions SET expires_at=0');assert.equal((await app.home()).props.mode,'public');globalThis.__entryToken='invalid';assert.equal((await app.home()).props.mode,'public');
});
test('an unconfigured installation still routes to setup',async t=>{await fixture(t);await assert.rejects(app.home(),/REDIRECT \/setup/);});
