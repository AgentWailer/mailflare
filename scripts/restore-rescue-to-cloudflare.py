#!/usr/bin/env python3
"""Import a locally verified rescue into a NEW, EMPTY D1 database and a NEW, EMPTY R2 bucket.

Run recover-rescue.py first. Private keys/passwords are not used or sent here.
Bind parameters keep large email bodies out of SQL statement text. This tool
refuses non-empty destinations and never deletes a running mailbox.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import urllib.request


def quote(name):
    return '"' + name.replace('"', '""') + '"'


class D1:
    def __init__(self, account, database, token):
        if not re.fullmatch(r"[0-9a-f]{32}", account) or not re.fullmatch(r"[0-9a-f-]{36}", database):
            raise ValueError("Invalid account or database ID")
        if not token:
            raise ValueError("Set CLOUDFLARE_API_TOKEN securely in the environment")
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
        self.token = token

    def query(self, sql, params=()):
        body = json.dumps({"sql": sql, "params": list(params)}).encode()
        request = urllib.request.Request(self.url, data=body, method="POST", headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        # No automatic retry of writes: an ambiguous response must not duplicate rows.
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.load(response)
        if not data.get("success") or not all(item.get("success", True) for item in data["result"]):
            raise RuntimeError("D1 rejected an import step; application bindings remain unchanged")
        return data["result"][0].get("results", [])


class R2:
    def __init__(self, account, bucket, profile):
        if not re.fullmatch(r"[0-9a-f]{32}", account) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Invalid account or bucket")
        self.bucket = bucket
        self.common = ["--profile", profile, "--region", "auto", "--endpoint-url", f"https://{account}.r2.cloudflarestorage.com", "--no-cli-pager"]

    def empty(self):
        result = subprocess.run(["aws", "s3api", "list-objects-v2", "--bucket", self.bucket, "--max-keys", "1"] + self.common, capture_output=True, check=True)
        return not json.loads(result.stdout).get("Contents")

    def put(self, entry, path):
        command = ["aws", "s3", "cp", str(path), f"s3://{self.bucket}/{entry['key']}", "--no-progress", "--only-show-errors"] + self.common
        metadata = entry.get("metadata", {})
        for field, option in (("contentType", "--content-type"), ("cacheControl", "--cache-control"), ("contentDisposition", "--content-disposition"), ("contentLanguage", "--content-language"), ("contentEncoding", "--content-encoding")):
            if metadata.get("http", {}).get(field):
                command += [option, str(metadata["http"][field])]
        if metadata.get("custom"):
            command += ["--metadata", json.dumps(metadata["custom"])]
        subprocess.run(command, capture_output=True, check=True)
        result = subprocess.run(["aws", "s3api", "head-object", "--bucket", self.bucket, "--key", entry["key"]] + self.common, capture_output=True, check=True)
        if json.loads(result.stdout)["ContentLength"] != entry["size"]:
            raise ValueError("Restored R2 object size mismatch")


def restore(directory, target, objects):
    directory = Path(directory).resolve()
    if not (directory / "VERIFIED").is_file():
        raise ValueError("Run recover-rescue.py successfully before importing")
    manifest = json.loads((directory / "manifest.json").read_text())
    existing = target.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name<>'d1_migrations'")
    if existing or not objects.empty():
        raise ValueError("Restore requires a new empty database AND a new empty object bucket")
    # Copy the original files before making any mailbox database rows available.
    with (directory / "objects.ndjson").open() as index:
        for line in index:
            entry = json.loads(line)
            if not re.fullmatch(r"[0-9a-f]{64}", entry["file"]):
                raise ValueError("Invalid local object filename")
            path = directory / "objects" / entry["file"]
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
                    digest.update(chunk)
            if path.stat().st_size != entry["size"] or digest.hexdigest() != entry["sha256"]:
                raise ValueError("A local recovered file changed before import")
            objects.put(entry, path)
    database = sqlite3.connect(directory / "mailflare.sqlite")
    schema = manifest["database"]["schema"]
    for item in schema:
        if item["type"] == "table":
            sql = item["sql"]
            if item["name"] == "d1_migrations":
                sql = re.sub(r"CREATE TABLE", "CREATE TABLE IF NOT EXISTS", sql, count=1, flags=re.I)
            target.query(sql)
    fts_insert = next((item for item in schema if item["name"] == "messages_fts_ai"), None)
    if fts_insert:
        target.query(fts_insert["sql"])
    names = manifest["database"]["tables"] + ["d1_migrations", "backup_snapshot_objects"]
    for name in names:
        cursor = database.execute(f"SELECT * FROM {quote(name)}")
        columns = [column[0] for column in cursor.description]
        if len(columns) > 100:
            raise ValueError("Table exceeds the supported bind parameter count")
        batch, params, size = [], [], 0

        def flush():
            nonlocal batch, params, size
            if batch:
                target.query(f"INSERT INTO {quote(name)} ({','.join(map(quote, columns))}) VALUES " + ",".join(batch), params)
                batch, params, size = [], [], 0

        for record in cursor:
            values = list(record)
            if name == "folders":
                values[columns.index("parent_id")] = None
            encoded_size = len(json.dumps(values).encode())
            if batch and (len(params) + len(values) > 100 or size + encoded_size > 512 * 1024):
                flush()
            batch.append("(" + ",".join("?" for _ in values) + ")")
            params.extend(values)
            size += encoded_size
        flush()
    for folder_id, parent_id in database.execute("SELECT id,parent_id FROM folders WHERE parent_id IS NOT NULL"):
        target.query("UPDATE folders SET parent_id=? WHERE id=?", [parent_id, folder_id])
    for item in schema:
        if item["type"] in ("index", "trigger") and item["name"] != "messages_fts_ai":
            target.query(item["sql"])
    if target.query("PRAGMA foreign_key_check"):
        raise ValueError("Restored D1 database failed its reference check")
    for name in names:
        count = database.execute(f"SELECT count(*) FROM {quote(name)}").fetchone()[0]
        if target.query(f"SELECT count(*) AS count FROM {quote(name)}")[0]["count"] != count:
            raise ValueError("Restored D1 table row count mismatch")
    database.close()
    return {"tables": len(names), "objects": manifest["objects"]["count"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recovered", required=True)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--target-database-id", required=True)
    parser.add_argument("--target-bucket", required=True)
    parser.add_argument("--profile", default="mailflare-r2")
    parser.add_argument("--apply-to-empty-targets", action="store_true", required=True)
    args = parser.parse_args()
    target = D1(args.account_id, args.target_database_id, os.environ.get("CLOUDFLARE_API_TOKEN"))
    objects = R2(args.account_id, args.target_bucket, args.profile)
    result = restore(args.recovered, target, objects)
    print(f"Wiederhergestellt und geprüft: {result['tables']} Tabellen, {result['objects']} Dateien.")
    print("Die Mailflare-Bindings wurden nicht geändert. Erst nach Prüfung auf die neuen Ressourcen umstellen.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Import unterbrochen. Die bisherige Installation und der Rettungsstand bleiben erhalten.")
    except Exception as error:
        raise SystemExit(f"Import fehlgeschlagen ({type(error).__name__}). Die Zielressourcen können unvollständig sein; die bisherige Installation bleibt erhalten. Mit neuen leeren Zielen erneut beginnen.")
