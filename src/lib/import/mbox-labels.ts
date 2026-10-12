import { decodeWords } from "postal-mime";
import { gmailPlacement } from "./gmail-jobs";

const SYSTEM_LABELS: Record<string, string> = {
 inbox: "INBOX", posteingang: "INBOX", unread: "UNREAD", ungelesen: "UNREAD", geöffnet: "READ", read: "READ", gelesen: "READ", starred: "STARRED", markiert: "STARRED",
 sent: "SENT", gesendet: "SENT", draft: "DRAFT", drafts: "DRAFT", entwurf: "DRAFT", entwürfe: "DRAFT",
 spam: "SPAM", trash: "TRASH", papierkorb: "TRASH", important: "IMPORTANT", wichtig: "IMPORTANT",
 'category promotions': "CATEGORY_PROMOTIONS", 'category social': "CATEGORY_SOCIAL", 'category updates': "CATEGORY_UPDATES",
 'category forums': "CATEGORY_FORUMS", 'category personal': "CATEGORY_PERSONAL", archived: "ARCHIVED", archiviert: "ARCHIVED",
};

export function mboxPlacement(raw: ArrayBuffer) {
 const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, 64 * 1024));
 const header = new TextDecoder().decode(bytes).split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[\t ]+/g, " ");
 const value = header.match(/^X-Gmail-Labels:\s*(.*)$/im)?.[1];
 // Gmail encodes the complete comma-separated header, often across multiple MIME words.
 // Splitting first cuts those words in half and can turn Inbox/Unread into custom labels.
 const labels = value === undefined ? [] : decodeWords(value).split(",").map(value => value.trim()).filter(Boolean);
 const systemLabel = (label: string) => {
  const normalized = label.toLowerCase();
  if (Object.hasOwn(SYSTEM_LABELS, normalized)) return SYSTEM_LABELS[normalized];
  // Takeout uses localized category names and sometimes doubled quotation marks.
  const category = normalized.replace(/^kategorie\s*:?\s*|^category\s*:?\s*/, "").replace(/"/g, "").trim();
  if (/^(?:kategorie|category)\b/.test(normalized)) {
   if (["werbung", "angebote", "promotions"].includes(category)) return "CATEGORY_PROMOTIONS";
   if (["soziale netzwerke", "soziale medien", "social"].includes(category)) return "CATEGORY_SOCIAL";
   if (["persönlich", "personal"].includes(category)) return "CATEGORY_PERSONAL";
   if (["neuigkeiten", "updates"].includes(category)) return "CATEGORY_UPDATES";
   if (["einkäufe", "purchases"].includes(category)) return "CATEGORY_PURCHASES";
   if (["foren", "forums"].includes(category)) return "CATEGORY_FORUMS";
  }
  return null;
 };
 const customLabels = [...new Set(labels.flatMap(label => {
  const system = systemLabel(label);
  if (!system) return [label];
  // Categories without their own Mailflare tab remain available as readable labels.
  if (["CATEGORY_UPDATES", "CATEGORY_PURCHASES", "CATEGORY_FORUMS"].includes(system)) {
   return [label.replace(/^(?:kategorie|category)\s*:?\s*/i, "").replace(/"/g, "").trim()];
  }
  return [];
 }))];
 if (customLabels.length > 100) throw new Error("This message has more than 100 custom labels; process it separately or explicitly skip it");
 const placement = gmailPlacement(labels.map(label => systemLabel(label) ?? label));
 // An ordinary MBOX has no Gmail placement information: retain it as read archived mail.
 if (value === undefined) placement.metadata.read = true;
 return { ...placement, labels: customLabels };
}
