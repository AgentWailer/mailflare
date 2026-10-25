import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpOauthGrants } from "@/db/schema";
import { parseScopes } from "@/lib/api-keys";
import type { SessionUser } from "@/lib/auth/types";
import { mcpAccessConfiguration, verifyAccessIdentity } from "./access-identity";
import { isMailMcpScope } from "./scopes";

export async function mcpOauthStatus(env:CloudflareEnv,user:SessionUser,request:Request) {
 const configuration=mcpAccessConfiguration(env),identity=await verifyAccessIdentity(env,request);
 const [grant]=await getDb(env).select().from(mcpOauthGrants).where(eq(mcpOauthGrants.userId,user.id)).limit(1);
 return {configured:configuration.configured,serverUrl:new URL("/mcp",env.APP_URL || new URL(request.url).origin).toString(),identity:identity?{email:identity.email}:null,
  grant:grant?{keyId:grant.keyId,enabled:grant.enabled,email:grant.email,identityMatches:!!identity && grant.issuer===identity.issuer && grant.audience===configuration.audience && grant.subject===identity.subject && grant.email===identity.email}:null};
}
export async function controlMcpOauthGrant(env:CloudflareEnv,user:SessionUser,request:Request,input:{enabled:boolean;keyId?:string}) {
 const db=getDb(env);
 if(!input.enabled){await db.update(mcpOauthGrants).set({enabled:false,updatedAt:Date.now()}).where(eq(mcpOauthGrants.userId,user.id));return;}
 const configuration=mcpAccessConfiguration(env),identity=await verifyAccessIdentity(env,request);
 if(!configuration.configured || !identity)throw new Error("access_identity_required");
 const [key]=input.keyId?await db.select({id:apiKeys.id,scopes:apiKeys.scopes}).from(apiKeys).where(and(eq(apiKeys.id,input.keyId),eq(apiKeys.userId,user.id),eq(apiKeys.kind,"mcp"))).limit(1):[];
 const scopes=parseScopes(key?.scopes??"[]");
 if(!key || !scopes.length || !scopes.every(isMailMcpScope))throw new Error("mail_mcp_key_required");
 const [linked]=await db.select({userId:mcpOauthGrants.userId}).from(mcpOauthGrants).where(and(eq(mcpOauthGrants.issuer,identity.issuer),eq(mcpOauthGrants.subject,identity.subject))).limit(1);
 if(linked && linked.userId!==user.id)throw new Error("identity_already_linked");
 // The owner explicitly consents while authenticated in BOTH Mailflare and Access.
 // Access login email may differ from the local mailbox address; bind the stable subject.
 await db.insert(mcpOauthGrants).values({userId:user.id,keyId:key.id,issuer:identity.issuer,audience:configuration.audience,subject:identity.subject,email:identity.email,enabled:true,createdAt:Date.now(),updatedAt:Date.now()})
  .onConflictDoUpdate({target:mcpOauthGrants.userId,set:{keyId:key.id,issuer:identity.issuer,audience:configuration.audience,subject:identity.subject,email:identity.email,enabled:true,updatedAt:Date.now()}});
}
