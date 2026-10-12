import { decodeWords } from "postal-mime";
import { gmailPlacement } from "./gmail-jobs";

const SYSTEM_LABELS: Record<string, string> = {
 inbox: "INBOX", posteingang: "INBOX", unread: "UNREAD", ungelesen: "UNREAD", starred: "STARRED", markiert: "STARRED",
 sent: "SENT", gesendet: "SENT", draft: "DRAFT", drafts: "DRAFT", entwurf: "DRAFT", entwürfe: "DRAFT",
 spam: "SPAM", trash: "TRASH", papierkorb: "TRASH", important: "IMPORTANT", wichtig: "IMPORTANT",
 'category promotions': "CATEGORY_PROMOTIONS", 'category social': "CATEGORY_SOCIAL", 'category updates': "CATEGORY_UPDATES",
 'category forums': "CATEGORY_FORUMS", 'category personal': "CATEGORY_PERSONAL", archived: "ARCHIVED", archiviert: "ARCHIVED",
};

export function mboxPlacement(raw: ArrayBuffer) {
 const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, 64 * 1024));
 const header = new TextDecoder().decode(bytes).split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[\t ]+/g, " ");
 const value = header.match(/^X-Gmail-Labels:\s*(.*)$/im)?.[1];
 const labels = value?.split(",").map(value => decodeWords(value.trim())).filter(Boolean) ?? [];
 const customLabels = [...new Set(labels.filter(label => !(Object.hasOwn(SYSTEM_LABELS, label.toLowerCase()))))];
 if (customLabels.length > 100) throw new Error("This message has more than 100 custom labels; process it separately or explicitly skip it");
 const placement = gmailPlacement(labels.map(label => Object.hasOwn(SYSTEM_LABELS, label.toLowerCase()) ? SYSTEM_LABELS[label.toLowerCase()] : label));
 // An ordinary MBOX has no Gmail placement information: retain it as read archived mail.
 if (value === undefined) placement.metadata.read = true;
 return { ...placement, labels: customLabels };
}
