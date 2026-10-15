import type { BackupExportPlan } from "./stream";
import type { DatabaseRecord } from "./types";
import { referencedObjectKeys } from "./rescue-storage";
import type { RescueRelation } from "./rescue-types";

const identifier = (name: string) => `"${name.replaceAll('"','""')}"`;

/** Complete records only: no plaintext carry objects or private decrypting key in the Worker. */
export async function nextRescueDatabaseChunk(db: D1Database, plan: BackupExportPlan, previous: {table:number;after:number|null;pageRows?:number}, relations:RescueRelation[]=[]) {
	const cursor = {...previous}, table = plan.tables[cursor.table], records: DatabaseRecord[] = [], references = new Set<string>();
	const links=new Map<string,{kind:string;token:string}>();
	if (!table) return null;
	let bytes = 0, done = false;
	while (table.upper !== null && bytes < 4 * 1024 * 1024 && records.length < 1000) {
		const filter = cursor.after === null ? "rowid <= ?" : "rowid > ? AND rowid <= ?";
		const params = cursor.after === null ? [table.upper] : [cursor.after,table.upper];
		const expression = table.columns.map(name=>`coalesce(length(CAST(${identifier(name)} AS BLOB)),0)`).join("+") || "0";
		const pageRows=Math.max(1,Math.min(500,cursor.pageRows??32));
		const candidates = (await db.prepare(`SELECT rowid AS id,(${expression}) AS bytes FROM ${identifier(table.name)} WHERE ${filter} ORDER BY rowid LIMIT ${pageRows}`).bind(...params).all<{id:number;bytes:number}>()).results;
		if (!candidates.length) {done=true;break;}
		let pageBytes=0,boundary:number|null=null;
		for (const row of candidates) {if(boundary!==null&&pageBytes+row.bytes>256*1024)break;boundary=row.id;pageBytes+=row.bytes;}
		const selected=cursor.after===null?[boundary]:[cursor.after,boundary];
		const rows=(await db.prepare(`SELECT rowid AS __mailflare_backup_rowid,* FROM ${identifier(table.name)} WHERE ${filter} ORDER BY rowid LIMIT ${pageRows}`).bind(...selected).all<DatabaseRecord & {__mailflare_backup_rowid:number}>()).results;
		for (const row of rows) {
			const {__mailflare_backup_rowid:rowid,...record}=row;records.push(record);cursor.after=rowid;bytes+=JSON.stringify(record).length;for(const key of referencedObjectKeys(table.name,record))references.add(key);
			for(const relation of relations){
				const kind=relation.target===table.name?"present":relation.table===table.name?"required":null;
				if(kind){const columns=kind==="present"?relation.targetColumns:relation.columns,values=columns.map(column=>record[column]);if(values.every(value=>value!==null&&value!==undefined)){const token=JSON.stringify([relation.target,relation.targetColumns,values]);links.set(`${kind}:${token}`,{kind,token});}}
				// Self references need both the row identity and its parent demand.
				if(relation.table===table.name&&relation.target===table.name){const values=relation.columns.map(column=>record[column]);if(values.every(value=>value!==null&&value!==undefined)){const token=JSON.stringify([relation.target,relation.targetColumns,values]);links.set(`required:${token}`,{kind:"required",token});}}
			}
		}
		cursor.after=boundary;
		cursor.pageRows=Math.max(1,Math.min(500,Math.floor(256*1024/Math.max(1,pageBytes/Math.max(1,rows.length)))));
	}
	if(table.upper===null||done){cursor.table++;cursor.after=null;cursor.pageRows=32;}
	return {raw:new TextEncoder().encode(JSON.stringify({format:"mailflare-rescue-table",version:1,table:table.name,records})),references:[...references],links:[...links.values()],cursor,done:cursor.table===plan.tables.length};
}

export async function getRescueRelations(db:D1Database,plan:BackupExportPlan):Promise<RescueRelation[]>{
	const relations:RescueRelation[]=[];
	for(const table of plan.tables){
		const rows=(await db.prepare(`PRAGMA foreign_key_list(${identifier(table.name)})`).all<{id:number;seq:number;table:string;from:string;to:string}>()).results;
		for(const id of new Set(rows.map(row=>row.id))){
			const group=rows.filter(row=>row.id===id).sort((a,b)=>a.seq-b.seq);let targetColumns=group.map(row=>row.to);
			if(targetColumns.some(column=>!column))targetColumns=(await db.prepare(`PRAGMA table_info(${identifier(group[0].table)})`).all<{name:string;pk:number}>()).results.filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk).map(column=>column.name);
			if(targetColumns.length!==group.length)throw new Error("Unsupported foreign-key definition");
			relations.push({table:table.name,columns:group.map(row=>row.from),target:group[0].table,targetColumns});
		}
	}
	return relations;
}
