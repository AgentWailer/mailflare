import { and, eq, lt, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { apiKeys, mcpKeyMailboxes, mcpOauthGrants, users } from "@/db/schema";
import { parseScopes, verifyApiKey } from "@/lib/api-keys";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import type { McpPrincipal } from "./types";

import { isMailMcpScope } from "./scopes";
import { mcpAccessConfiguration, verifyAccessIdentity } from "./access-identity";
const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

type Authentication = {principal:McpPrincipal|null;reason?:"grant_required"};

async function principalForKey(env:CloudflareEnv,candidate:typeof apiKeys.$inferSelect,oauth=false):Promise<McpPrincipal|null> {
 const db=getDb(env),allScopes=parseScopes(candidate.scopes);
 const isMailKey=allScopes.length>0 && allScopes.every(isMailMcpScope);
 const isAdminKey=allScopes.length>0 && allScopes.every(scope=>ADMIN_SCOPES.has(scope));
 if(!isMailKey && (!isAdminKey || oauth))return null;
 const [user]=await db.select().from(users).where(eq(users.id,candidate.userId)).limit(1);
 if(!user || user.disabled || isAdminKey && user.role!=="admin")return null;
 const allowed=isMailKey?await db.select({mailboxId:mcpKeyMailboxes.mailboxId}).from(mcpKeyMailboxes).where(eq(mcpKeyMailboxes.keyId,candidate.id)):[];
 const mailboxIds:string[]=[];
 for(const {mailboxId} of allowed)if((await getMailboxAccessLevel(db,user,mailboxId))?.canRead)mailboxIds.push(mailboxId);
 const stale=new Date(Date.now()-60_000);
 await db.update(apiKeys).set({lastUsedAt:new Date()}).where(and(eq(apiKeys.id,candidate.id),or(isNull(apiKeys.lastUsedAt),lt(apiKeys.lastUsedAt,stale))));
 return {keyId:candidate.id,user,scopes:allScopes,mailboxIds};
}

export async function getMcpAuthentication(env:CloudflareEnv,request:Request):Promise<Authentication> {
 const authorization=request.headers.get("Authorization")??"";
 if(authorization && !authorization.startsWith("Bearer "))return {principal:null};
 const token=authorization.slice(7).trim();if(token.length>4096)return {principal:null};
 const db=getDb(env);
 if(token.startsWith("ep_")){
  if(token.length>256)return {principal:null};
  const candidates=await db.select().from(apiKeys).where(and(eq(apiKeys.prefix,token.slice(0,12)),eq(apiKeys.kind,"mcp")));
  for(const candidate of candidates)if(verifyApiKey(token,candidate.keyHash))return {principal:await principalForKey(env,candidate)};
  // A wrong/revoked key never falls back to a more permissive OAuth identity.
  return {principal:null};
 }
 const identity=await verifyAccessIdentity(env,request);if(!identity)return {principal:null};
 const config=mcpAccessConfiguration(env);
 const [grant]=await db.select({key:apiKeys}).from(mcpOauthGrants)
  .innerJoin(apiKeys,and(eq(apiKeys.id,mcpOauthGrants.keyId),eq(apiKeys.userId,mcpOauthGrants.userId),eq(apiKeys.kind,"mcp")))
  .where(and(eq(mcpOauthGrants.enabled,true),eq(mcpOauthGrants.issuer,identity.issuer),eq(mcpOauthGrants.audience,config.audience),eq(mcpOauthGrants.subject,identity.subject),eq(mcpOauthGrants.email,identity.email))).limit(1);
 const principal=grant?await principalForKey(env,grant.key,true):null;
 return {principal,...(!principal?{reason:"grant_required" as const}:{})};
}

export async function authenticateMcpRequest(env:CloudflareEnv,request:Request):Promise<McpPrincipal|null> {
 return (await getMcpAuthentication(env,request)).principal;
}
