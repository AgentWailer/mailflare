// Optional paid research-preview probe. Synthetic text only, no mailbox access.
import {writeFileSync} from 'node:fs';
if(!process.argv.includes('--live'))throw Error('Use --live for paid Cloudflare inference on synthetic examples.');
if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID)throw Error('Cloudflare credentials required');
const fixtures=[
 {id:'collection',state:'Unser Aktenzeichen AZ-123. Die offene Forderung beträgt 148,50 EUR. Bitte zahlen Sie bis zum 15. November 2026 oder teilen Sie uns Ihren Widerspruch mit.',expected:{case_reference:'AZ-123',deadline:'2026-11-15',amount:148.5}},
 {id:'acknowledgement',state:'Vielen Dank für Ihren Widerspruch zum Aktenzeichen CASE-456. Wir werden den Vorgang prüfen und uns bei Ihnen melden. Sie müssen derzeit nichts unternehmen.',expected:{case_reference:'CASE-456',deadline:null,amount:null,action:null}},
 {id:'advert',state:'Nur noch bis zum 15. November 2026: Unsere Software für 19,99 EUR! Kaufen Sie jetzt und sparen Sie 50 Prozent. Abmelden vom Newsletter.',expected:{case_reference:null,deadline:null,amount:null,action:null}},
 {id:'application',state:'Guten Tag, zu Ihrem Antrag fehlen noch Unterlagen. Bitte senden Sie den unterschriebenen Nachweis bis zum 20. November 2026, damit wir Ihren Antrag bearbeiten können.',expected:{case_reference:null,deadline:'2026-11-20',amount:null}},
 {id:'support',state:'Danke für Ihre Rückmeldung. Bitte senden Sie uns die Seriennummer Ihres defekten Geräts, damit wir die Reparatur beauftragen können.',expected:{case_reference:null,deadline:null,amount:null}},
 {id:'paid-receipt',state:'Quittung RE-789. Wir haben Ihre Zahlung über 49,90 EUR erhalten. Es besteht kein offener Betrag. Es ist nichts weiter zu tun.',expected:{case_reference:null,deadline:null,amount:null,action:null}},
 {id:'english-claim',state:'Case reference EN-234. The outstanding balance is EUR 75.25. Please respond to this claim by November 30, 2026.',expected:{case_reference:'EN-234',deadline:'2026-11-30',amount:75.25}},
 {id:'legal-newsletter',state:'Webinar: Erfolgreiches Inkasso. Lernen Sie am 15. November 2026, wie man Zahlungsfristen setzt. Buchen Sie jetzt unser Seminar für 49 EUR.',expected:{case_reference:null,deadline:null,amount:null,action:null}}
];
const fields={
 case_reference:{type:'text',instructions:'Extract only the exact case reference or Aktenzeichen for an actual personal case. Do not extract a product, invoice or order number. Null when absent.'},
 deadline:{type:'date',instructions:'The explicit deadline by which the recipient must respond or act on an actual personal case, claim or application. Exclude sales expiry dates, webinars, events and marketing. Null when absent.'},
 amount:{type:'number',decimals:2,instructions:'The explicitly outstanding amount owed by the recipient for an actual existing claim or bill. Exclude advertised prices, discounts, paid receipts and refunds. Null if no outstanding amount is stated.'},
 action:{type:'text',instructions:'Copy the exact sentence requesting action on an actual personal case, application or support request. Exclude invitations to buy, subscribe or attend marketing. If the message says no action is needed, return null.'}
};
const results=[];
for(const fixture of fixtures){const start=performance.now();try{
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clairic`,{method:'POST',headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({model:'clairic',state:fixture.state,fields,reference_date:'2026-10-28'}),signal:AbortSignal.timeout(20000)});
 const j=await r.json();if(!r.ok||!j.success)throw Error('Inference HTTP '+r.status+' '+JSON.stringify(j.errors));
 const mismatches=Object.entries(fixture.expected).filter(([field,expected])=>j.result.answers?.[field]?.value!==expected).map(([field])=>field);
 const row={id:fixture.id,elapsedMs:Math.round(performance.now()-start),expected:fixture.expected,answers:j.result.answers,usage:j.result.usage,truncated:j.result.truncated,mismatches};results.push(row);console.log(JSON.stringify(row));
 }catch(error){const row={id:fixture.id,error:error instanceof Error?error.message:'Inference failed'};results.push(row);console.log(JSON.stringify(row));}}
writeFileSync(process.env.CLAIRIC_OUTPUT||'/tmp/mailflare-clairic-probe.json',JSON.stringify({date:new Date().toISOString(),method:'Synthetic extraction probe, not a classification benchmark; early research preview',results},null,2));
