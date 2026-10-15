"use client";

import { useState } from "react";
import { Download, KeyRound, ShieldCheck } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const base64=(value:ArrayBuffer|Uint8Array)=>btoa(String.fromCharCode(...new Uint8Array(value)));

export function RecoveryKeySetup({onConfigured}:{onConfigured:()=>void}){
	const {t}=useLanguage();
	const [password,setPassword]=useState(""),[confirmation,setConfirmation]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(false),[stored,setStored]=useState(false);
	const [prepared,setPrepared]=useState<{publicKey:JsonWebKey;file:string}|null>(null);
	async function prepare(){
		setBusy(true);setError(false);
		try{
			const pair=await crypto.subtle.generateKey({name:"RSA-OAEP",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["encrypt","decrypt"]);
			const exported=await crypto.subtle.exportKey("jwk",pair.publicKey),publicKey={kty:"RSA",n:exported.n!,e:exported.e!};
			const privateBytes=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey));
			const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
			const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveKey"]);
			const key=await crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:600000,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt"]);
			const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,privateBytes);privateBytes.fill(0);
			setPrepared({publicKey,file:JSON.stringify({format:"mailflare-rescue-private-key",version:1,publicKey,kdf:{algorithm:"PBKDF2-SHA256",iterations:600000,salt:base64(salt)},cipher:{algorithm:"AES-256-GCM",iv:base64(iv)},encryptedPrivateKey:base64(encrypted)},null,2)});
			setPassword("");setConfirmation("");
		}catch{setError(true);}finally{setBusy(false);}
	}
	function download(){if(!prepared)return;const url=URL.createObjectURL(new Blob([prepared.file],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="mailflare-wiederherstellungsschluessel.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
	async function activate(){
		if(!prepared||!stored)return;setBusy(true);setError(false);
		try{const response=await authFetch("/api/backups/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({publicKey:prepared.publicKey})});if(!response.ok)throw new Error("Key setup failed");setPrepared(null);onConfigured();}catch{setError(true);}finally{setBusy(false);}
	}
	return <section className="rounded-3xl bg-white p-6" data-recovery-key-setup>
		<div className="flex items-start gap-3"><KeyRound className="mt-1 h-5 w-5 shrink-0 text-blue-600"/><div><h2 className="font-medium">{t("backups.keyTitle")}</h2><p className="mt-1 text-sm text-neutral-600">{t("backups.keyDescription")}</p></div></div>
		{!prepared?<form className="mt-5 grid max-w-lg gap-3" onSubmit={event=>{event.preventDefault();void prepare();}}>
			<label className="grid gap-1 text-sm">{t("backups.keyPassword")}<Input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={event=>setPassword(event.target.value)} /></label>
			<label className="grid gap-1 text-sm">{t("backups.keyPasswordConfirm")}<Input type="password" autoComplete="new-password" required value={confirmation} onChange={event=>setConfirmation(event.target.value)} /></label>
            <Button type="submit" className="h-auto min-h-11 whitespace-normal px-4 py-2 text-center" disabled={busy||password.length<12||password!==confirmation}>{busy?t("common.loading"):t("backups.keyCreate")}</Button>
		</form>:<div className="mt-5 grid max-w-lg gap-4">
			<Button type="button" className="h-auto min-h-11 whitespace-normal px-4 py-2 text-center" variant="outline" onClick={download}><Download className="h-4 w-4 shrink-0"/>{t("backups.keyDownload")}</Button>
			<label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={stored} onChange={event=>setStored(event.target.checked)}/>{t("backups.keyStored")}</label>
			<Button type="button" className="h-auto min-h-11 whitespace-normal px-4 py-2 text-center" onClick={()=>void activate()} disabled={busy||!stored}><ShieldCheck className="h-4 w-4 shrink-0"/>{busy?t("common.saving"):t("backups.keyActivate")}</Button>
		</div>}
		{error&&<p role="alert" className="mt-3 text-sm text-red-700">{t("backups.keyError")}</p>}
	</section>;
}
