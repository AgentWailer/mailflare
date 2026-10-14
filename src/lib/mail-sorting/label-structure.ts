import { getDb } from "@/db";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { newId } from "@/lib/ids";

/** Simplify the sidebar without deleting label identities, filters, or historical memberships. */
export async function simplifyLabelStructure(env: CloudflareEnv, user: SessionUser, mailboxId: string) {
 const access = await getMailboxAccessLevel(getDb(env), user, mailboxId);
 if (!access?.canManage) throw new Error("Mailbox not found");
 const before = (await env.DB.prepare("SELECT id,name,parent_id FROM folders WHERE mailbox_id=? ORDER BY created_at,id").bind(mailboxId).all<{ id: string; name: string; parent_id: string | null }>()).results;
 const labels = new Map(before.map(label => [label.name, label]));
 const statements: D1PreparedStatement[] = [];
 for (const name of ["Antworten", "Warten"]) if (!labels.has(name)) {
  const label = { id: newId("fld"), name, parent_id: null }; labels.set(name, label);
  statements.push(env.DB.prepare("INSERT INTO folders(id,user_id,mailbox_id,name,color,created_at) VALUES(?,?,?,?,?,?)").bind(label.id, access.mailbox.userId, mailboxId, name, name === "Antworten" ? "#2563eb" : "#d97706", Math.floor(Date.now() / 1000)));
 }
 // Preserve duplicate IDs for existing links, imported membership and saved rule targets.
 // Add the canonical label too, so its view is complete; future import normalization prevents more duplicates.
 const aliases: Record<string, string> = { 'Kategorie ""Reisen""': "Reisen", 'Kategorie "Reisen"': "Reisen", Shopping: "Einkäufe" };
 const hidden = new Set<string>();
 for (const [source, destination] of Object.entries(aliases)) {
  const old = labels.get(source); if (!old) continue;
  let target = labels.get(destination);
  if (!target) {
   target = { id: newId("fld"), name: destination, parent_id: null }; labels.set(destination, target);
   statements.push(env.DB.prepare("INSERT INTO folders(id,user_id,mailbox_id,name,created_at) VALUES(?,?,?,?,?)").bind(target.id, access.mailbox.userId, mailboxId, destination, Math.floor(Date.now() / 1000)));
  }
  hidden.add(old.id);
  statements.push(env.DB.prepare("INSERT OR IGNORE INTO message_labels(message_id,folder_id) SELECT ml.message_id,? FROM message_labels ml JOIN messages m ON m.id=ml.message_id WHERE ml.folder_id=? AND m.mailbox_id=?").bind(target.id, old.id, mailboxId));
  // Remap live label actions while retaining the old identity for immutable queued snapshots.
  statements.push(env.DB.prepare(`UPDATE routing_rules SET label_ids=(SELECT json_group_array(value) FROM (SELECT DISTINCT CASE WHEN value=? THEN ? ELSE value END value FROM json_each(label_ids))) WHERE mailbox_id=? AND json_valid(label_ids) AND json_type(label_ids)='array' AND EXISTS(SELECT 1 FROM json_each(label_ids) WHERE value=?)`).bind(old.id, target.id, mailboxId, old.id));
 }
 const processed = labels.get("processed"), paperless = labels.get("Paperless");
 if (processed && paperless && !labels.has("Verarbeitet")) {
  statements.push(env.DB.prepare("UPDATE folders SET name='Verarbeitet',parent_id=? WHERE id=? AND mailbox_id=?").bind(paperless.id, processed.id, mailboxId));
  labels.delete("processed"); labels.set("Verarbeitet", { ...processed, name: "Verarbeitet", parent_id: paperless.id });
 }
 for (const label of labels.values()) if (["Neuigkeiten", "Unerwünscht", "Dringend", "Einkäufe", "Rechnung", "Foren", "Gmail", "Outlook", "Migrated Chat", "Notion", "Test"].includes(label.name)) hidden.add(label.id);
 const visibleNames = ["Antworten", "Warten", "Aperturo", "Projekte", "Privat", "Reisen", "Paperless"];
 const visible = visibleNames.flatMap(name => labels.has(name) ? [labels.get(name)!.id] : []);
 const rootOrder = [...visible, ...[...labels.values()].filter(label => !label.parent_id && !visible.includes(label.id)).map(label => label.id)];
 // One atomic preference change preserves unrelated mailbox settings and hidden labels.
 statements.push(env.DB.prepare(`UPDATE users SET hidden_label_ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(CASE WHEN json_valid(hidden_label_ids) AND json_type(hidden_label_ids)='array' THEN hidden_label_ids ELSE '[]' END) WHERE type='text' AND value NOT IN(SELECT value FROM json_each(?)) UNION SELECT value FROM json_each(?))),label_order=json_set(CASE WHEN json_valid(label_order) AND json_type(label_order)='object' THEN label_order ELSE '{}' END,?,json(?)) WHERE id=?`).bind(JSON.stringify(visible), JSON.stringify([...hidden]), `$."${mailboxId}"."root"`, JSON.stringify(rootOrder), user.id));
 await env.DB.batch(statements);
 return { visibleLabels: visibleNames.filter(name => labels.has(name)), hiddenLabels: hidden.size, retainedLabels: before.length };
}
