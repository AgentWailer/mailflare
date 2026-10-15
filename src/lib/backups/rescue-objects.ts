import { newId } from "@/lib/ids";
import { encryptRescuePacket, PACKET_OVERHEAD } from "./rescue-crypto";
import { COPY_BYTES, hashBytes } from "./rescue-storage";
import type { RescueObject, RescueObjectCopy } from "./rescue-types";

type Copy = RescueObjectCopy & {copyId:string};
const encryptedSize=(size:number)=>size+Math.max(1,Math.ceil(size/COPY_BYTES))*PACKET_OVERHEAD;

export async function copyRescueObject(env: CloudflareEnv, row: RescueObject, publicKey: JsonWebKey): Promise<boolean> {
	const target=env.RESCUE_BUCKET!;
	if(!row.source_etag)throw new Error("A referenced live object is missing");
	const expectedSize=encryptedSize(row.size);
	if(row.state==="pending"){
		const previous=await env.DB.prepare("SELECT destination_etag,checksums,metadata FROM backup_snapshot_objects WHERE blob_key=? AND state='verified' LIMIT 1").bind(row.blob_key).first<{destination_etag:string;checksums:string;metadata:string}>();
		const head=previous?await target.head(row.blob_key):null;
		if(previous&&head?.etag===previous.destination_etag&&head.size===expectedSize){
			const source=await env.BUCKET.head(row.source_key);if(!source||source.etag!==row.source_etag||source.size!==row.size)throw new Error("Live object changed during rescue copy");
			await env.DB.prepare("UPDATE backup_snapshot_objects SET state='verified',destination_etag=?,checksums=?,metadata=? WHERE backup_id=? AND source_key=?").bind(head.etag,previous.checksums,JSON.stringify({http:source.httpMetadata,custom:source.customMetadata}),row.backup_id,row.source_key).run();return true;
		}
	}
	if(row.size<=COPY_BYTES){
		const source=await env.BUCKET.get(row.source_key,{onlyIf:{etagMatches:row.source_etag}});
		if(!source||!("body" in source)||source.size!==row.size)throw new Error("Live object changed during rescue copy");
		const raw=new Uint8Array(await source.arrayBuffer());const packet=await encryptRescuePacket(publicKey,raw),sha=hashBytes(packet);
		const written=await target.put(row.blob_key,packet,{httpMetadata:{contentType:"application/octet-stream"}});
		const read=await target.get(row.blob_key);if(!written||!read||read.size!==expectedSize||hashBytes(new Uint8Array(await read.arrayBuffer()))!==sha)throw new Error("Rescue object verification failed");
		await env.DB.prepare("UPDATE backup_snapshot_objects SET state='verified',destination_etag=?,checksums=?,metadata=? WHERE backup_id=? AND source_key=?").bind(written.etag,JSON.stringify([sha]),JSON.stringify({http:source.httpMetadata,custom:source.customMetadata}),row.backup_id,row.source_key).run();return true;
	}
	let copy=row.checkpoint?JSON.parse(row.checkpoint) as Copy:null;
	if(!copy){
		const copyId=newId("copy"),upload=await target.createMultipartUpload(row.blob_key,{httpMetadata:{contentType:"application/octet-stream"},customMetadata:{copyId}});
		copy={copyId,uploadId:upload.uploadId,parts:[],hashes:[],offset:0,verify:0,uploaded:false};
		await saveCopy(env,row,copy,"copying");
	}
	const upload=target.resumeMultipartUpload(row.blob_key,copy.uploadId);
	if(copy.offset<row.size){
		const source=await env.BUCKET.get(row.source_key,{onlyIf:{etagMatches:row.source_etag},range:{offset:copy.offset,length:Math.min(COPY_BYTES,row.size-copy.offset)}});
		if(!source||!("body" in source)||source.size!==row.size)throw new Error("Live object changed during rescue copy");
		const raw=new Uint8Array(await source.arrayBuffer());if(raw.length!==Math.min(COPY_BYTES,row.size-copy.offset))throw new Error("Incomplete live object range");
		const packet=await encryptRescuePacket(publicKey,raw),number=copy.parts.length+1;
		if(number>10000)throw new Error("Rescue object exceeds multipart capacity");
		const part=await upload.uploadPart(number,packet);copy.parts.push(part);copy.hashes.push(hashBytes(packet));copy.offset+=raw.length;
		await saveCopy(env,row,copy,"copying",JSON.stringify({http:source.httpMetadata,custom:source.customMetadata}));return false;
	}
	if(!copy.uploaded){
		const head=await target.head(row.blob_key);
		if(head?.customMetadata?.copyId!==copy.copyId||head.size!==expectedSize)await upload.complete(copy.parts);
		copy.uploaded=true;await saveCopy(env,row,copy,"verifying");return false;
	}
	if(copy.verify<copy.hashes.length){
		const index=copy.verify,length=Math.min(COPY_BYTES,row.size-index*COPY_BYTES)+PACKET_OVERHEAD;
		const read=await target.get(row.blob_key,{range:{offset:index*(COPY_BYTES+PACKET_OVERHEAD),length}});
		if(!read||!("body" in read)||hashBytes(new Uint8Array(await read.arrayBuffer()))!==copy.hashes[index])throw new Error("Rescue object verification failed");
		copy.verify++;await saveCopy(env,row,copy,"verifying");return false;
	}
	const head=await target.head(row.blob_key);if(!head||head.size!==expectedSize)throw new Error("Completed rescue object missing");
	await env.DB.prepare("UPDATE backup_snapshot_objects SET state='verified',checkpoint=NULL,destination_etag=?,checksums=? WHERE backup_id=? AND source_key=?").bind(head.etag,JSON.stringify(copy.hashes),row.backup_id,row.source_key).run();return true;
}

async function saveCopy(env:CloudflareEnv,row:RescueObject,copy:Copy,state:string,metadata=row.metadata){
	await env.DB.prepare("UPDATE backup_snapshot_objects SET checkpoint=?,state=?,metadata=? WHERE backup_id=? AND source_key=?").bind(JSON.stringify(copy),state,metadata,row.backup_id,row.source_key).run();
}
