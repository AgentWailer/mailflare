import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/cookies";
import { assertPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";
import { recoveryKeyFingerprint, validateRescuePublicKey } from "@/lib/backups/rescue-crypto";
import { createBackupRecord } from "@/lib/backups/service";
import { enqueueDatabaseBackup } from "@/lib/backups/runner";

export async function POST(request:Request){
	const env=getEnv();
	let user;try{user=await requireUser(env,request);assertPrimaryAdmin(user);}catch{return NextResponse.json({error:"Forbidden"},{status:403});}
	try{
		if(!env.RESCUE_BUCKET)return NextResponse.json({error:"A separate rescue bucket is required"},{status:400});
		const input=await request.json() as {publicKey?:unknown};
		if(Object.keys(input).some(key=>key!=="publicKey"))throw new Error("Only a public key is accepted");
		const key=validateRescuePublicKey(input.publicKey);
		const updated=await env.DB.prepare("UPDATE backup_settings SET rescue_public_key=?,enabled=1,schedule_type='weekly',schedule_value=0,retention_enabled=0,excluded_table_groups='[]',updated_at=? WHERE id='default' AND rescue_public_key IS NULL RETURNING id").bind(JSON.stringify(key),Math.floor(Date.now()/1000)).first();
		if(!updated)return NextResponse.json({error:"A recovery key is already configured. Keep the existing private key."},{status:409});
		// Initial copy starts automatically. A lost send is recovered by the five-minute cron.
		const backupId=await createBackupRecord(env,"manual",user.id);
		await enqueueDatabaseBackup(env,backupId).catch(()=>{});
		return NextResponse.json({ok:true,fingerprint:recoveryKeyFingerprint(key),backupId});
	}catch{return NextResponse.json({error:"Use a valid RSA-3072 public recovery key. Private keys are never accepted."},{status:400});}
}
