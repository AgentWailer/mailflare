import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<div id="root"></div>',{url:'https://mailflare.test/inbox'});
for(const key of ['window','document','localStorage','navigator','Event','CustomEvent','HTMLElement','HTMLInputElement','Element','Node','NodeFilter','MutationObserver','getComputedStyle'])Object.defineProperty(globalThis,key,{configurable:true,value:typeof dom.window[key]==='function'&&key==='getComputedStyle'?dom.window[key].bind(dom.window):dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const directory=mkdtempSync(join(process.cwd(),'node_modules','wallet-attachment-test-'));
after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
writeFileSync(join(directory,'env.ts'),'export const getEnv=()=>globalThis.__walletEnv;');
writeFileSync(join(directory,'headers.ts'),`export async function cookies(){return {get(name){const value=globalThis.__walletRequest.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);return value?{value}:undefined;}};}`);
writeFileSync(join(directory,'pdf.tsx'),'export default function PdfPreview(){throw Error("Wallet must not load a PDF renderer");}');
await build({stdin:{contents:`export {GET} from './src/app/api/messages/[messageId]/attachments/[attachmentId]/route';export {SqliteDatabase} from './server/runtime/sqlite-database';export {applyMigrations} from './server/runtime/migrate';export {getAttachmentPreviewKind,getAttachmentFileUrl} from './src/components/message-attachment-viewer-utils';export {getAttachmentVisual} from './src/components/message-attachment-card-utils';export {MessageAttachmentViewer} from './src/components/message-attachment-viewer';export {MessageAttachmentCard} from './src/components/message-attachment-card';`,resolveDir:process.cwd()},outfile:join(directory,'app.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',tsconfig:'tsconfig.json',alias:{'next/server':'next/server.js','next/headers':join(directory,'headers.ts'),'@/lib/cloudflare':join(directory,'env.ts')},plugins:[{name:'unused-pdf-preview',setup(builder){builder.onResolve({filter:/^\.\/pdf-attachment-preview$/},()=>({path:join(directory,'pdf.tsx')}));}}],logLevel:'silent'});
const app=await import(pathToFileURL(join(directory,'app.mjs')).href),React=await import('react'),{act}=React,{createRoot}=await import('react-dom/client');
const token='local-test-session',pass={id:'pass',filename:'Ticket.PKPASS',type:'application/octet-stream',size:4,disposition:'attachment'};
async function fixture(t){
 const DB=new app.SqliteDatabase(':memory:');t.after(()=>DB.db.close());await app.applyMigrations(DB,join(process.cwd(),'drizzle/migrations'));
 DB.db.exec(`INSERT INTO users(id,email,password_hash,name,created_at) VALUES('owner','owner@example.test','hash','Owner',1),('other','other@example.test','hash','Other',1);
 INSERT INTO domains(id,user_id,hostname,zone_id,status,created_at) VALUES('domain','owner','example.test','local','active',1);
 INSERT INTO mailboxes(id,user_id,domain_id,local_part,type,created_at) VALUES('box','owner','domain','owner','personal',1);
 INSERT INTO messages(id,user_id,mailbox_id,direction,from_addr,to_addr,status,created_at) VALUES('mail','owner','box','inbound','sender@example.test','owner@example.test','received',1);
 INSERT INTO message_attachments(id,message_id,r2_key,filename,content_type,size,disposition,created_at) VALUES('pass','mail','pass-object','Ticket.PKPASS','application/octet-stream',4,'attachment',1);`);
 for(const [user,session]of [['owner',token],['other','other-session']])DB.db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,1)').run(user+'-session',user,createHash('sha256').update(session).digest('hex'),Math.floor(Date.now()/1000)+600);
 let reads=0;globalThis.__walletEnv={DB,BUCKET:{get:async()=>{reads++;return {body:new Blob(['PASS']).stream(),writeHttpMetadata:headers=>headers.set('Content-Type','application/octet-stream')};}}};
 async function get(query='?open=1',headers={cookie:'ep_session='+token}){globalThis.__walletRequest=new Request('https://mailflare.test/api/messages/mail/attachments/pass'+query,{headers});return app.GET(globalThis.__walletRequest,{params:Promise.resolve({messageId:'mail',attachmentId:'pass'})});}
 return {DB,get,reads:()=>reads};
}

test('Wallet passes are recognized by standard MIME type or filename, including generic imported attachments',()=>{
 for(const type of ['application/vnd.apple.pkpass','Application/Vnd.Apple.Pkpass; charset=binary'])assert.equal(app.getAttachmentPreviewKind({type}),'wallet');
 for(const type of ['application/octet-stream','application/zip'])assert.equal(app.getAttachmentPreviewKind({...pass,type}),'wallet');
 assert.equal(app.getAttachmentVisual(pass).labelKey,'attachment.wallet');assert.equal(app.getAttachmentVisual(pass).thumbnail,null);
 assert.equal(app.getAttachmentPreviewKind({type:'application/pdf',filename:'receipt.pdf'}),'pdf');assert.equal(app.getAttachmentPreviewKind({type:'image/svg+xml',filename:'image.svg'}),'unsupported');
 assert.equal(app.getAttachmentPreviewKind({type:'application/octet-stream',filename:'pass.pkpass.exe'}),'unsupported');
 assert.equal(app.getAttachmentFileUrl('mail','pass','open'),'/api/messages/mail/attachments/pass?open=1');
});

test('the native open URL streams original pass bytes with Wallet MIME, inline disposition and live cookie authentication',async t=>{
 const f=await fixture(t),response=await f.get();assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/vnd.apple.pkpass');assert.match(response.headers.get('Content-Disposition'),/^inline;/);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.match(response.headers.get('Content-Security-Policy'),/sandbox/);assert.equal(await response.text(),'PASS');assert.equal(f.reads(),1);
 const download=await f.get('?open=1&download=1');assert.equal(download.headers.get('Content-Type'),'application/vnd.apple.pkpass');assert.match(download.headers.get('Content-Disposition'),/^attachment;/);await download.body.cancel();
});

test('opening a Wallet pass cannot bypass expired sessions, another mailbox owner or a disabled mailbox',async t=>{
 const f=await fixture(t);assert.equal((await f.get('?open=1',{})).status,401);assert.equal((await f.get('?open=1',{cookie:'ep_session=expired'})).status,401);
 assert.equal((await f.get('?open=1',{cookie:'ep_session='+token,Authorization:'Bearer other-session'})).status,404);assert.equal(f.reads(),0);
 f.DB.db.prepare('UPDATE mailboxes SET disabled=1 WHERE id=?').run('box');assert.equal((await f.get()).status,404);assert.equal(f.reads(),0);
});

test('ordinary PDFs and unsupported active files retain their original preview/download behavior',async t=>{
 const f=await fixture(t);f.DB.db.prepare("UPDATE message_attachments SET filename='receipt.pdf',content_type='application/pdf'").run();
 let response=await f.get('?preview=1');assert.equal(response.headers.get('Content-Type'),'application/pdf');assert.match(response.headers.get('Content-Disposition'),/^inline;/);await response.body.cancel();
 f.DB.db.prepare("UPDATE message_attachments SET filename='image.svg',content_type='image/svg+xml'").run();response=await f.get('?open=1');assert.equal(response.headers.get('Content-Type'),'image/svg+xml');assert.match(response.headers.get('Content-Disposition'),/^attachment;/);await response.body.cancel();
});

test('Wallet cards open a native link directly and the fallback viewer offers Wallet without an unsafe-file warning',async()=>{
 document.body.innerHTML='<div id="root"></div>';const root=createRoot(document.getElementById('root'));let previews=0;
 try{
  await act(async()=>root.render(React.createElement(app.MessageAttachmentCard,{attachment:pass,messageId:'mail',onPreview:()=>previews++})));
  let link=document.querySelector('a');assert.equal(link.getAttribute('href'),'/api/messages/mail/attachments/pass?open=1');assert.equal(link.target,'_blank');assert.equal(link.hasAttribute('download'),false);assert.equal(link.rel,'noopener noreferrer');assert(document.body.textContent.includes('Apple Wallet pass'));assert.equal(previews,0);
  await act(async()=>root.render(React.createElement(app.MessageAttachmentViewer,{attachment:pass,messageId:'mail',open:true,onOpenChange:()=>{}})));
  const dialog=document.querySelector('[role=dialog]');assert(dialog);assert(!dialog.textContent.includes('cannot be previewed safely'));assert.equal(dialog.querySelectorAll('iframe,canvas').length,0);
  link=[...dialog.querySelectorAll('a')].find(anchor=>anchor.textContent==='Open in Apple Wallet');assert(link);assert.equal(link.getAttribute('href'),'/api/messages/mail/attachments/pass?open=1');assert.equal(link.target,'_blank');assert.equal(link.hasAttribute('download'),false);
 }finally{await act(async()=>root.unmount());}
});
