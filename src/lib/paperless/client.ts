export type PaperlessCredentials = { token: string; accessId?: string; accessSecret?: string };
export class PaperlessError extends Error {
 constructor(public code: string, public retryable = false, public ambiguous = false) { super(code); }
}
export function normalizePaperlessUrl(value: string) {
 let url: URL; try { url = new URL(value.trim()); } catch { throw new PaperlessError("invalid_url"); }
 const host = url.hostname.toLowerCase();
 if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
  host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
  host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes(".") || host.includes("..")) throw new PaperlessError("invalid_url");
 return url.toString().replace(/\/+$/, "");
}
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function encryptionKey(env: Pick<CloudflareEnv,"PAPERLESS_ENCRYPTION_KEY">) {
 try {
  const bytes = decode(env.PAPERLESS_ENCRYPTION_KEY ?? "");
  if (bytes.length !== 32) throw new Error();
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
 } catch { throw new PaperlessError("encryption_unavailable"); }
}
export async function encryptCredentials(env: CloudflareEnv, mailboxId: string, url: string, credentials: PaperlessCredentials) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`${mailboxId}\n${url}`) }, await encryptionKey(env), encoder.encode(JSON.stringify(credentials)));
 return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}
export async function decryptCredentials(env: CloudflareEnv, mailboxId: string, url: string, value: string): Promise<PaperlessCredentials> {
 try {
  const [version, iv, body] = value.split("."); if (version !== "v1") throw new Error();
  const result = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name:"AES-GCM",iv:decode(iv),additionalData:encoder.encode(`${mailboxId}\n${url}`) },await encryptionKey(env),decode(body))));
  if (typeof result.token !== "string" || !result.token) throw new Error();
  return result;
 } catch { throw new PaperlessError("reconnect_required"); }
}
function headers(credentials: PaperlessCredentials) {
 const result: Record<string,string> = { Authorization: `Token ${credentials.token}`, Accept: "application/json" };
 if (credentials.accessId && credentials.accessSecret) { result["CF-Access-Client-Id"] = credentials.accessId; result["CF-Access-Client-Secret"] = credentials.accessSecret; }
 return result;
}
async function deniedResponseCode(response: Response, uploading: boolean) {
 if (response.headers.get("cf-mitigated") === "challenge") { await response.body?.cancel(); return "cloudflare_challenge"; }
 // Match only known error phrases. Never retain/log an upstream response body.
 const reader=response.body?.getReader();let prefix="",remaining=8192;
 try { if(reader)while(remaining>0){const part=await reader.read();if(part.done)break;const bytes=part.value.subarray(0,remaining);prefix+=new TextDecoder().decode(bytes);remaining-=bytes.length;} } catch { /* Status remains useful when the body is unreadable. */ }
 finally { await reader?.cancel().catch(()=>{}); }
 if (/insufficient permissions|do not have permission|does not have permission/i.test(prefix)) return uploading?"document_permission_denied":"permission_denied";
 if (/invalid token|authentication credentials were not provided|incorrect authentication credentials/i.test(prefix)) return "paperless_token_rejected";
 if (/csrf verification failed|csrf failed/i.test(prefix)) return "paperless_csrf";
 if (/cloudflareaccess\.com|cdn-cgi\/access|<title>\s*access denied/i.test(prefix)) return "cloudflare_access_denied";
 return response.status===401?"unauthorized_401":"unauthorized_403";
}
async function api(baseUrl: string, credentials: PaperlessCredentials, path: string, init: RequestInit = {}, uploading = false) {
 let response: Response;
 try { response = await fetch(`${normalizePaperlessUrl(baseUrl)}/api/${path}`, { ...init, headers: { ...headers(credentials), ...init.headers }, redirect:"manual", signal:AbortSignal.timeout(uploading ? 90_000 : 15_000) }); }
 catch { throw new PaperlessError(uploading ? "upload_uncertain" : "connection_failed", !uploading, uploading); }
 if (!response.ok) {
  if (response.status === 401 || response.status === 403) throw new PaperlessError(await deniedResponseCode(response,uploading));
  if (response.status >= 300 && response.status < 400) {
   let code="redirect_blocked";
   try { const location=new URL(response.headers.get("Location")??"",baseUrl);
    if (location.hostname.endsWith(".cloudflareaccess.com") || location.pathname.startsWith("/cdn-cgi/access")) code="cloudflare_access_login";
   } catch { /* Keep generic redirect message. */ }
   await response.body?.cancel();throw new PaperlessError(code,false,uploading);
  }
  await response.body?.cancel();
  if (response.status === 429) throw new PaperlessError("rate_limited", true);
  if (response.status >= 500) throw new PaperlessError(uploading ? "upload_uncertain" : "server_unavailable", !uploading, uploading);
  throw new PaperlessError(response.status === 413 ? "pdf_too_large" : "request_rejected");
 }
 // Bound and sanitize protocol parsing; never store server bodies or credentials as errors.
 const reader = response.body?.getReader(); let size = 0, text = ""; const decoder = new TextDecoder();
 try { if(reader) for(;;) { const part = await reader.read(); if(part.done) break; size += part.value.byteLength; if(size>262144) { await reader.cancel(); throw new Error(); } text += decoder.decode(part.value,{stream:true}); } return JSON.parse(text + decoder.decode()); }
 catch { throw new PaperlessError(uploading ? "upload_uncertain" : "invalid_response", false, uploading); }
}
export async function testPaperlessConnection(url: string, credentials: PaperlessCredentials) {
 const tasks = await api(url,credentials,"tasks/?page_size=1");
 if (!Array.isArray(tasks) && !Array.isArray(tasks?.results)) throw new PaperlessError("invalid_response");
 const docs = await api(url,credentials,"documents/?page_size=1&fields=id&truncate_content=true");
 if (!Array.isArray(docs) && !Array.isArray(docs?.results)) throw new PaperlessError("invalid_response");
}
export function pdfCandidate(filename: string, type: string) { return /\.pdf$/i.test(filename) || type.split(";",1)[0].trim().toLowerCase() === "application/pdf"; }
export async function uploadPdf(env: CloudflareEnv, baseUrl: string, credentials: PaperlessCredentials, attachment: { filename: string; r2_key: string }) {
 const head = await env.BUCKET.get(attachment.r2_key,{range:{offset:0,length:1024}});
 if (!head) throw new PaperlessError("attachment_missing");
 const signature = new TextDecoder("latin1").decode(await head.arrayBuffer());
 if (!signature.includes("%PDF-")) throw new PaperlessError("invalid_pdf");
 const object = await env.BUCKET.get(attachment.r2_key); if (!object) throw new PaperlessError("attachment_missing");
 const boundary = `mailflare-${crypto.randomUUID()}`;
 const filename = attachment.filename.replace(/[\r\n"\\]/g,"_").slice(0,200) || "document.pdf";
 const before = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`);
 const after = encoder.encode(`\r\n--${boundary}--\r\n`);
 const reader = object.body.getReader(); let phase = 0;
 const body = new ReadableStream<Uint8Array>({ async pull(controller) {
  if (phase === 0) { controller.enqueue(before); phase=1; return; }
  const chunk = await reader.read(); if (!chunk.done) { controller.enqueue(chunk.value); return; }
  controller.enqueue(after); controller.close(); phase=2;
 }, async cancel(reason) { await reader.cancel(reason); } });
 const result = await api(baseUrl,credentials,"documents/post_document/", { method:"POST",body,
  headers:{"Content-Type":`multipart/form-data; boundary=${boundary}`,"Content-Length":String(before.length+object.size+after.length)}, duplex:"half" } as RequestInit, true);
 if (typeof result !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(result)) throw new PaperlessError("upload_uncertain",false,true);
 return result;
}
export async function pollPaperlessTask(baseUrl: string, credentials: PaperlessCredentials, taskId: string) {
 const response = await api(baseUrl,credentials,`tasks/?task_id=${encodeURIComponent(taskId)}&page_size=10`);
 const tasks = Array.isArray(response) ? response : response?.results;
 if (!Array.isArray(tasks)) throw new PaperlessError("invalid_response");
 const task = tasks.find(task => task?.task_id === taskId); if (!task) return {done:false};
 const status = String(task.status).toUpperCase();
 const documentId = Number(task.related_document ?? task.related_document_ids?.[0] ?? task.result_data?.document_id);
 if (status === "SUCCESS" && Number.isSafeInteger(documentId) && documentId>0) return {done:true,documentId};
 if (["FAILURE","REVOKED","SUCCESS"].includes(status)) throw new PaperlessError(status === "SUCCESS" ? "document_unconfirmed" : "processing_failed");
 return {done:false};
}
