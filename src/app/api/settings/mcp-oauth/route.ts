import { z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { controlMcpOauthGrant, mcpOauthStatus } from "@/lib/mcp/oauth-grants";
const headers={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
 const env=getEnv(),auth=await requireSessionUser(env,request);if(auth.error)return auth.error;
 return Response.json(await mcpOauthStatus(env,auth.user,request),{headers});
}
export async function POST(request:Request) {
 const env=getEnv(),auth=await requireSessionUser(env,request);if(auth.error)return auth.error;
 if(!hasValidSessionMutationOrigin(request))return Response.json({error:"Invalid origin"},{status:403,headers});
 try {
  const input=z.object({enabled:z.boolean(),keyId:z.string().min(1).max(100).optional()}).strict().parse(await readJsonBody(request,2048));
  await controlMcpOauthGrant(env,auth.user,request,input);
  return Response.json(await mcpOauthStatus(env,auth.user,request),{headers});
 }catch(error){return Response.json({error:error instanceof Error && ["access_identity_required","mail_mcp_key_required","identity_already_linked"].includes(error.message)?error.message:"oauth_update_failed"},{status:400,headers});}
}
