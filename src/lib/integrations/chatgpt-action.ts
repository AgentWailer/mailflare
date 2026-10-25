/** An OpenAPI document, not credentials: authentication is configured separately in the GPT editor. */
export function createChatGptSendAction(origin: string, mailbox: {id:string;address:string}) {
 const url=new URL(origin);
 if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash) throw new Error("Use the public HTTPS Mailflare origin");
 if(!mailbox.id || mailbox.id.length>200 || !mailbox.address.includes("@")) throw new Error("Choose a sending mailbox");
 const recipients={type:"array",maxItems:50,items:{type:"string",format:"email",maxLength:500}};
 return {
  openapi:"3.1.0",info:{title:"Send email through Mailflare",version:"1.0.0",description:"Send only through Mailflare. A successful send is saved in the selected Mailflare mailbox's Sent folder."},
  servers:[{url:url.origin}],security:[{mailflareKey:[]}],
  paths:{"/api/v1/send":{post:{operationId:"sendMailflareEmail",summary:"Send an email through Mailflare and save it in Sent",
   description:"Send only after the user approves the recipients, subject and complete text. Use this action instead of Gmail. Success returns messageId. If the result is uncertain or a timeout occurs, ask the user to check Sent before retrying; never silently send the same email again.",
   "x-openai-isConsequential":true,
   requestBody:{required:true,content:{"application/json":{schema:{type:"object",additionalProperties:false,required:["mailboxId","from","to","subject","text"],properties:{
    mailboxId:{type:"string",enum:[mailbox.id],description:"The selected Mailflare mailbox ID; use exactly this value."},
    from:{type:"string",format:"email",enum:[mailbox.address],description:"The selected Mailflare sending address."},
    to:{...recipients,minItems:1},cc:recipients,bcc:recipients,
    subject:{type:"string",minLength:1,maxLength:500},text:{type:"string",minLength:1,maxLength:20000,description:"Complete email body in plain text, approved by the user."},
   }}}}},
   responses:{"200":{description:"Mailflare accepted and sent the email; its sent copy is stored.",content:{"application/json":{schema:{type:"object",properties:{messageId:{type:"string"}},required:["messageId"]}}}},"400":{description:"Invalid email or sending configuration"},"401":{description:"Missing or invalid Mailflare API key or send permission"},"404":{description:"Sending mailbox unavailable or outside the key's scope"},"500":{description:"Delivery could not be confirmed. Check Mailflare Sent before retrying."}},
  }}},components:{securitySchemes:{mailflareKey:{type:"http",scheme:"bearer",description:"A dedicated Mailflare API key with send permission for this mailbox. Set it in the GPT action authentication field, never in the schema or conversation."}}},
 };
}
