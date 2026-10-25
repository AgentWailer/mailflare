/** Cloudflare handles OAuth/DCR; the origin independently verifies its user assertion. */
export type AccessIdentity = {issuer:string;subject:string;email:string};
const MAX_ASSERTION_BYTES=16*1024,MAX_CERT_BYTES=128*1024;
type Certificates={issuer:string;expiresAt:number;lastAttempt:number;keys:Map<string,CryptoKey>;failed?:boolean;pending?:Promise<void>};
let certificates:Certificates|undefined;

export function mcpAccessConfiguration(env: CloudflareEnv) {
 const issuer=env.MCP_ACCESS_ISSUER?.trim().replace(/\/$/,"") ?? "",audience=env.MCP_ACCESS_AUDIENCE?.trim() ?? "";
 let validIssuer=false;
 try {
  const url=new URL(issuer);
  validIssuer=url.protocol==="https:" && !url.username && !url.password && !url.port && url.pathname==="/" && !url.search && !url.hash && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i.test(url.hostname) && url.origin===issuer;
 }catch{ /* Missing or untrusted issuer fails closed. */ }
 return {configured:validIssuer && /^[a-f0-9]{64}$/i.test(audience),issuer,audience};
}
function decode(value:string):Uint8Array<ArrayBuffer> {
 if(!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length%4===1)throw new Error("Invalid assertion encoding");
 const text=atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="));
 return Uint8Array.from(text,c=>c.charCodeAt(0));
}
function parse(value:string):Record<string,unknown> {
 const data:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decode(value)));
 if(!data || typeof data!=="object" || Array.isArray(data))throw new Error("Invalid assertion");
 return data as Record<string,unknown>;
}
async function fetchCertificates(state:Certificates) {
 const response=await fetch(`${state.issuer}/cdn-cgi/access/certs`,{redirect:"error",headers:{Accept:"application/json"},signal:AbortSignal.timeout(5000)});
 if(!response.ok || Number(response.headers.get("Content-Length")??0)>MAX_CERT_BYTES || !response.body)throw new Error("Access certificate service unavailable");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try {
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_CERT_BYTES){await reader.cancel();throw new Error("Access certificate response too large");}chunks.push(value);}
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const data=JSON.parse(new TextDecoder().decode(bytes)) as {keys?: (JsonWebKey & {kid?:string})[]};
 if(!Array.isArray(data.keys) || data.keys.length>16)throw new Error("Invalid Access certificates");
 const keys=new Map<string,CryptoKey>();
 for(const key of data.keys){
  if(key.kty!=="RSA" || key.alg && key.alg!=="RS256" || key.use && key.use!=="sig" || !key.kid || key.kid.length>256 || !key.n || key.n.length<342 || key.n.length>1400)continue;
  keys.set(key.kid,await crypto.subtle.importKey("jwk",key,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]));
 }
 if(!keys.size)throw new Error("No Access signing certificates");
 state.keys=keys;state.expiresAt=Date.now()+5*60_000;
}
async function signingKey(issuer:string,kid:string) {
 if(certificates?.issuer!==issuer)certificates={issuer,expiresAt:0,lastAttempt:0,keys:new Map()};
 const state=certificates,now=Date.now();
 if(!state.pending && (state.expiresAt<=now || !state.keys.has(kid)) && now-state.lastAttempt>=(state.failed?5000:60_000)){
  // Unknown key IDs have a longer cooldown; temporary certificate-service
  // failures can recover promptly without accepting stale or unverified keys.
  state.lastAttempt=now;state.pending=fetchCertificates(state).then(()=>{state.failed=false;},error=>{state.failed=true;throw error;}).finally(()=>{state.pending=undefined;});
 }
 if(state.pending)await state.pending;
 if(state.expiresAt<=Date.now())return null;
 return state.keys.get(kid)??null;
}
export type AccessIdentityStatus = "verified" | "not_configured" | "missing_assertion" | "invalid_assertion" | "issuer_mismatch" | "audience_mismatch" | "expired_assertion" | "not_yet_valid" | "not_user_identity" | "certificates_unavailable" | "invalid_signature";
export type AccessIdentityCheck = {identity:AccessIdentity|null;status:AccessIdentityStatus;source?:"header"|"cookie"};

function accessApplicationCookie(request:Request):string|null {
 // Cloudflare's application cookie contains the same signed application JWT.
 // Never substitute an unverified email header or the Mailflare login session.
 const cookie=request.headers.get("Cookie")??"";
 const match=cookie.split(";").map(part=>part.trim()).find(part=>part.startsWith("CF_Authorization="));
 if(!match)return null;
 let value=match.slice("CF_Authorization=".length);
 if(value.startsWith('"') && value.endsWith('"'))value=value.slice(1,-1);
 try{return decodeURIComponent(value);}catch{return null;}
}
export async function inspectAccessIdentity(env:CloudflareEnv,request:Request):Promise<AccessIdentityCheck> {
 const config=mcpAccessConfiguration(env);
 if(!config.configured)return {identity:null,status:"not_configured"};
 const header=request.headers.get("Cf-Access-Jwt-Assertion"),assertion=header || accessApplicationCookie(request),source=header?"header" as const:"cookie" as const;
 const fail=(status:AccessIdentityStatus):AccessIdentityCheck=>({identity:null,status,source});
 if(!assertion)return fail("missing_assertion");
 if(assertion.length>MAX_ASSERTION_BYTES)return fail("invalid_assertion");
 try {
  const segments=assertion.split(".");if(segments.length!==3)return fail("invalid_assertion");
  const protectedHeader=parse(segments[0]),claims=parse(segments[1]),now=Math.floor(Date.now()/1000);
  if(protectedHeader.alg!=="RS256" || typeof protectedHeader.kid!=="string" || !protectedHeader.kid || protectedHeader.kid.length>256 || protectedHeader.crit!==undefined)return fail("invalid_assertion");
  if(claims.iss!==config.issuer)return fail("issuer_mismatch");
  const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(!audiences.includes(config.audience))return fail("audience_mismatch");
  if(typeof claims.exp!=="number" || !Number.isFinite(claims.exp) || typeof claims.iat!=="number" || !Number.isFinite(claims.iat) || claims.iat>=claims.exp)return fail("invalid_assertion");
  if(claims.exp<=now)return fail("expired_assertion");
  if(claims.iat>now+30 || claims.nbf!==undefined && (typeof claims.nbf!=="number" || !Number.isFinite(claims.nbf) || claims.nbf>now+30))return fail("not_yet_valid");
  if(claims.type!=="app" || typeof claims.sub!=="string" || !claims.sub || claims.sub.length>256 || typeof claims.email!=="string" || claims.email.length>320 || !/^[^\s<>]+@[^\s<>]+$/.test(claims.email) || claims.email_verified===false || claims.common_name!=null && claims.common_name!=="")return fail("not_user_identity");
  let key:CryptoKey|null;
  try{key=await signingKey(config.issuer,protectedHeader.kid);}catch{return fail("certificates_unavailable");}
  if(!key)return fail("certificates_unavailable");
  if(!await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,decode(segments[2]),new TextEncoder().encode(segments[0]+"."+segments[1])))return fail("invalid_signature");
  return {identity:{issuer:config.issuer,subject:claims.sub,email:claims.email.toLowerCase()},status:"verified",source};
 }catch{return fail("invalid_assertion");}
}
export async function verifyAccessIdentity(env:CloudflareEnv,request:Request):Promise<AccessIdentity|null> {
 return (await inspectAccessIdentity(env,request)).identity;
}
