import { newId } from "@/lib/ids";
import { safeErrorCategory } from "@/lib/security/logging";
import { planDatabaseBackup } from "./stream";
import { nextRescueDatabaseChunk, getRescueRelations } from "./rescue-database";
import { copyRescueObject } from "./rescue-objects";
import { recoveryKeyFingerprint, RESCUE_ALGORITHM, validateRescuePublicKey, PACKET_OVERHEAD } from "./rescue-crypto";
import { COPY_BYTES, CURRENT_RESCUE_KEY, getJson, hashBytes, objectBlobKey, putVerifiedChunk, snapshotPrefix } from "./rescue-storage";
import type { RescueCheckpoint, RescueManifest, RescueObject } from "./rescue-types";

const LEASE_MS=5*60_000;
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
type State=RescueCheckpoint & {verifyPart?:number};

/** One durable, bounded step. The public encryption key is sufficient for every step. */
export async function processRescueBackup(env:CloudflareEnv,id:string):Promise<void>{
	if(!env.RESCUE_BUCKET||env.RESCUE_BUCKET===env.BUCKET)throw new Error("A separate rescue bucket is required");
	const target=env.RESCUE_BUCKET,now=Date.now(),lease=newId("lease");
	const job=await env.DB.prepare("UPDATE backups SET status='running',started_at=coalesce(started_at,?),lease_token=?,lease_until=? WHERE id=? AND status IN ('queued','running') AND lease_until<? RETURNING checkpoint")
		.bind(Math.floor(now/1000),lease,now+LEASE_MS,id,now).first<{checkpoint:string|null}>();
	if(!job)return;
	let state:State|undefined;
	try{
		if(job.checkpoint)state=JSON.parse(job.checkpoint) as State;
		else{
			const settings=await env.DB.prepare("SELECT rescue_public_key FROM backup_settings WHERE id='default'").first<{rescue_public_key:string|null}>();
			const publicKey=validateRescuePublicKey(settings?.rescue_public_key?JSON.parse(settings.rescue_public_key):null);
			const plan=await planDatabaseBackup(env.DB);
			const schema=(await env.DB.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT GLOB 'messages_fts_*' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all<{type:string;name:string;sql:string}>()).results;
			const migrations=(await env.DB.prepare("SELECT * FROM d1_migrations ORDER BY id").all<Record<string,string|number|null>>()).results;
			state={version:2,phase:"database",plan,publicKey,keyFingerprint:recoveryKeyFingerprint(publicKey),cursor:{table:0,after:null},parts:[],manifestAfter:null,shards:[],objectCount:0,objectBytes:0,objectCipherBytes:0,storedBytes:0,failures:0,schema,migrations,relations:await getRescueRelations(env.DB,plan)};
			await save(env,id,lease,state);
		}
		const prefix=snapshotPrefix(id);
		if(state.phase==="database"){
			const part=await nextRescueDatabaseChunk(env.DB,state.plan,state.cursor,state.relations);
			if(!part){state.phase="inventory";}
			else{
				// Commit required references before the cursor. A missing source can never silently disappear from the rescue set.
				for(let offset=0;offset<part.references.length;offset+=50)await env.DB.batch(part.references.slice(offset,offset+50).map(key=>env.DB.prepare("INSERT OR IGNORE INTO backup_snapshot_objects(backup_id,source_key) VALUES(?,?)").bind(id,key)));
				for(let offset=0;offset<part.links.length;offset+=50)await env.DB.batch(part.links.slice(offset,offset+50).map(link=>env.DB.prepare("INSERT OR IGNORE INTO backup_snapshot_links(backup_id,kind,token) VALUES(?,?,?)").bind(id,link.kind,link.token)));
				const chunk=await putVerifiedChunk(target,`${prefix}database-${String(state.parts.length).padStart(6,"0")}.mfr`,part.raw,state.publicKey);
				state.parts.push(chunk);state.storedBytes+=chunk.bytes;state.cursor=part.cursor;if(part.done)state.phase="inventory";
			}
		}else if(state.phase==="inventory"){
			const page=await env.BUCKET.list({limit:100,...(state.inventoryCursor?{cursor:state.inventoryCursor}:{})});
			const objects=page.objects.filter(object=>!object.key.startsWith("backups/")&&!object.key.startsWith("rescue/"));
			if(objects.length)await env.DB.batch(objects.map(object=>env.DB.prepare("INSERT INTO backup_snapshot_objects(backup_id,source_key,source_etag,size,blob_key) VALUES(?,?,?,?,?) ON CONFLICT(backup_id,source_key) DO UPDATE SET source_etag=excluded.source_etag,size=excluded.size,blob_key=excluded.blob_key").bind(id,object.key,object.etag,object.size,objectBlobKey(object.key,object.etag,state!.keyFingerprint))));
			if(page.truncated)state.inventoryCursor=page.cursor;
			else{
				const dangling=await env.DB.prepare("SELECT token FROM backup_snapshot_links r WHERE r.backup_id=? AND r.kind='required' AND NOT EXISTS(SELECT 1 FROM backup_snapshot_links p WHERE p.backup_id=r.backup_id AND p.kind='present' AND p.token=r.token) LIMIT 1").bind(id).first();if(dangling)throw new Error("Database changed during rescue export; a required parent record is missing");
				const missing=await env.DB.prepare("SELECT source_key FROM backup_snapshot_objects WHERE backup_id=? AND source_etag='' LIMIT 1").bind(id).first();if(missing)throw new Error("A database-referenced object is missing from live storage");
				state.phase="objects";
			}
		}else if(state.phase==="objects"){
			const pending=(await env.DB.prepare("SELECT * FROM backup_snapshot_objects WHERE backup_id=? AND state IN ('pending','copying','verifying') ORDER BY state,source_key LIMIT 8").bind(id).all<RescueObject>()).results;
			for(const object of pending){const done=await copyRescueObject(env,object,state.publicKey);if(!done)break;state.objectCount++;state.objectBytes+=object.size;state.objectCipherBytes+=object.size+Math.max(1,Math.ceil(object.size/COPY_BYTES))*PACKET_OVERHEAD;}
			if(!pending.length){
				// Reconcile once, including a step whose upload committed just before a lost D1 response.
				const count=await env.DB.prepare("SELECT count(*) AS count,coalesce(sum(size),0) AS bytes,coalesce(sum(size+max(1,(size+?)/?)*?),0) AS encrypted_bytes FROM backup_snapshot_objects WHERE backup_id=? AND state='verified'").bind(COPY_BYTES-1,COPY_BYTES,PACKET_OVERHEAD,id).first<{count:number;bytes:number;encrypted_bytes:number}>();
				state.objectCount=count?.count??0;state.objectBytes=count?.bytes??0;state.objectCipherBytes=count?.encrypted_bytes??0;state.phase="manifest";
			}
		}else if(state.phase==="manifest"){
			const rows=(await env.DB.prepare("SELECT * FROM backup_snapshot_objects WHERE backup_id=? AND state='verified' AND (? IS NULL OR source_key>?) ORDER BY source_key LIMIT 100").bind(id,state.manifestAfter,state.manifestAfter).all<RescueObject>()).results;
			if(!rows.length)state.phase="publish";
			else{
				for(const row of rows){const head=await target.head(row.blob_key);if(!head||head.etag!==row.destination_etag)throw new Error("Verified rescue object changed before publication");}
				const entries=rows.map(row=>({key:row.source_key,etag:row.source_etag,size:row.size,blobKey:row.blob_key,destinationEtag:row.destination_etag,checksums:JSON.parse(row.checksums),metadata:JSON.parse(row.metadata)}));
				const chunk=await putVerifiedChunk(target,`${prefix}objects-${String(state.shards.length).padStart(6,"0")}.mfr`,encode(entries),state.publicKey);state.shards.push(chunk);state.storedBytes+=chunk.bytes;state.manifestAfter=rows.at(-1)!.source_key;
			}
		}else if(state.phase==="publish"){
			const chunks=[...state.parts,...state.shards],index=state.verifyPart??0;
			if(index<chunks.length){const chunk=chunks[index],object=await target.get(chunk.key);if(!object||hashBytes(new Uint8Array(await object.arrayBuffer()))!==chunk.sha256)throw new Error("Rescue chunk verification failed before publication");state.verifyPart=index+1;}
			else{
				const manifest:RescueManifest={format:"mailflare-rescue",version:1,backupId:id,createdAt:state.plan.createdAt,verifiedAt:new Date().toISOString(),keyFingerprint:state.keyFingerprint,database:{format:"mailflare-rescue-table",version:1,parts:state.parts,tables:state.plan.tables.map(table=>table.name),schema:state.schema,migrations:state.migrations},objects:{count:state.objectCount,bytes:state.objectBytes,shards:state.shards},scope:"database-and-live-objects",sourceBucket:"mailflare-raw",backupBucket:"mailflare-rescue"};
				const root=await putVerifiedChunk(target,`${prefix}manifest.mfr`,encode(manifest),state.publicKey);
				const pointer={format:"mailflare-rescue-pointer",version:1,algorithm:RESCUE_ALGORITHM,backupId:id,keyFingerprint:state.keyFingerprint,verifiedAt:manifest.verifiedAt,manifest:root,bucket:manifest.backupBucket};
				// Atomic pointer replacement is the commit point; no old object has been deleted yet.
				await target.put(CURRENT_RESCUE_KEY,encode(pointer),{httpMetadata:{contentType:"application/json"}});
				state.phase="cleanup";state.storedBytes+=root.bytes;
				await env.DB.prepare("UPDATE backups SET verified_at=?,r2_key=?,filename=? WHERE id=? AND lease_token=?").bind(Math.floor(Date.now()/1000),root.key,`mailflare-${id}.rescue.json`,id,lease).run();
			}
		}else if(state.phase==="cleanup"){
			const pointer=await getJson<{backupId:string;keyFingerprint:string;manifest:{key:string;bytes:number;sha256:string}}>(target,CURRENT_RESCUE_KEY),root=pointer?await target.head(pointer.manifest.key):null;
			if(pointer?.backupId!==id||pointer.keyFingerprint!==state.keyFingerprint||root?.size!==pointer.manifest.bytes||root.customMetadata?.sha256!==pointer.manifest.sha256)throw new Error("The published rescue point must remain intact before removing an old copy");
			if(await pruneOneSupersededBackup(env,id)){
				await env.DB.prepare("UPDATE backups SET status='completed',checkpoint=NULL,error=NULL,completed_at=?,lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?").bind(Math.floor(Date.now()/1000),id,lease).run();return;
			}
		}
		state.failures=0;await save(env,id,lease,state);
		await env.DB.prepare("UPDATE backups SET lease_token=NULL,lease_until=0,error=NULL WHERE id=? AND lease_token=?").bind(id,lease).run();
		await env.AGENT_QUEUE?.send({kind:"database.backup",jobId:id}).catch(()=>{});
	}catch(error){
		const saved=await env.DB.prepare("SELECT checkpoint FROM backups WHERE id=? AND lease_token=?").bind(id,lease).first<{checkpoint:string|null}>();
		const checkpoint=saved?.checkpoint?JSON.parse(saved.checkpoint) as State:null;
		if(checkpoint)checkpoint.failures++;
		const failed=!checkpoint||(checkpoint.phase!=="cleanup"&&checkpoint.failures>=5);
		await env.DB.prepare("UPDATE backups SET status=?,checkpoint=?,error=?,lease_token=NULL,lease_until=?,completed_at=? WHERE id=? AND lease_token=?").bind(failed?"failed":"running",checkpoint?JSON.stringify(checkpoint):null,`Rescue interrupted (${safeErrorCategory(error)}). ${checkpoint?.phase==="cleanup"?"The verified rescue point is retained; cleanup will resume.":failed?"The previous rescue point is retained.":"It will resume automatically; the previous rescue point is retained."}`,failed?0:Date.now()+60_000,failed?Math.floor(Date.now()/1000):null,id,lease).run();
	}
}

async function save(env:CloudflareEnv,id:string,lease:string,state:State){
	await env.DB.prepare("UPDATE backups SET checkpoint=?,size=?,object_count=?,object_bytes=? WHERE id=? AND lease_token=?").bind(JSON.stringify(state),state.storedBytes+state.objectCipherBytes,state.objectCount,state.objectBytes,id,lease).run();
}

/** All shared blobs referenced by the newly published generation are retained. */
async function pruneOneSupersededBackup(env:CloudflareEnv,currentId:string):Promise<boolean>{
	const old=await env.DB.prepare("SELECT id,kind,r2_key FROM backups WHERE id<>? ORDER BY created_at LIMIT 1").bind(currentId).first<{id:string;kind:string;r2_key:string|null}>();
	if(!old){const result=await env.DB.prepare("DELETE FROM backup_snapshot_links WHERE rowid IN (SELECT rowid FROM backup_snapshot_links WHERE backup_id=? LIMIT 500)").bind(currentId).run();return result.meta.changes===0;}
	if(old.kind==="rescue"){
		const rows=(await env.DB.prepare("SELECT * FROM backup_snapshot_objects WHERE backup_id=? LIMIT 50").bind(old.id).all<RescueObject>()).results;
		for(const row of rows){
			const used=await env.DB.prepare("SELECT 1 AS present FROM backup_snapshot_objects WHERE backup_id=? AND blob_key=? LIMIT 1").bind(currentId,row.blob_key).first();
			if(!used&&row.blob_key){if(!/^rescue\/objects\/[0-9a-f]{64}$/.test(row.blob_key))throw new Error("Unexpected rescue object location");if(row.checkpoint){const copy=JSON.parse(row.checkpoint) as {uploadId?:string};if(copy.uploadId)await env.RESCUE_BUCKET!.resumeMultipartUpload(row.blob_key,copy.uploadId).abort().catch(()=>{});}await env.RESCUE_BUCKET!.delete(row.blob_key);}
			await env.DB.prepare("DELETE FROM backup_snapshot_objects WHERE backup_id=? AND source_key=?").bind(old.id,row.source_key).run();
		}
		if(rows.length)return false;
		const page=await env.RESCUE_BUCKET!.list({prefix:snapshotPrefix(old.id),limit:100});if(page.objects.length){await env.RESCUE_BUCKET!.delete(page.objects.map(object=>object.key));return false;}
	}else{
		if(old.r2_key){if(!old.r2_key.startsWith("backups/"))throw new Error("Unexpected legacy backup location");await env.BUCKET.delete(old.r2_key);}
		const page=await env.BUCKET.list({prefix:`backups/database/${old.id}/`,limit:100});if(page.objects.length){await env.BUCKET.delete(page.objects.map(object=>object.key));return false;}
	}
	const links=await env.DB.prepare("DELETE FROM backup_snapshot_links WHERE rowid IN (SELECT rowid FROM backup_snapshot_links WHERE backup_id=? LIMIT 500)").bind(old.id).run();if(links.meta.changes)return false;
	await env.DB.prepare("DELETE FROM backups WHERE id=?").bind(old.id).run();return false;
}
