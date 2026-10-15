#!/usr/bin/env python3
"""Download, authenticate and decrypt a Mailflare rescue point locally, with bounded memory.

Requires Python 3.10+, cryptography, and AWS CLI for R2 access. No private key or
password is sent to Cloudflare. Produces a checked SQLite database
and the original R2 files; never writes to the running application.
"""
import argparse
import base64
import getpass
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

COPY_BYTES = 8 * 1024 * 1024
MAX_CHUNK = 64 * 1024 * 1024


def load_private_key(path, password):
    data = json.loads(Path(path).read_text())
    if data.get("format") != "mailflare-rescue-private-key" or data.get("version") != 1:
        raise ValueError("Not a Mailflare recovery key file")
    kdf, cipher = data["kdf"], data["cipher"]
    if kdf["algorithm"] != "PBKDF2-SHA256" or kdf["iterations"] != 600000 or cipher["algorithm"] != "AES-256-GCM":
        raise ValueError("Unsupported recovery key protection")
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=base64.b64decode(kdf["salt"]), iterations=kdf["iterations"]).derive(password.encode())
    private = AESGCM(key).decrypt(base64.b64decode(cipher["iv"]), base64.b64decode(data["encryptedPrivateKey"]), None)
    private_key = serialization.load_der_private_key(private, password=None)
    if private_key.key_size != 3072:
        raise ValueError("The recovery key must be RSA-3072")
    public = data["publicKey"]
    canonical = json.dumps({"kty": public["kty"], "n": public["n"], "e": public["e"]}, separators=(",", ":"))
    expected_n = int.from_bytes(base64.urlsafe_b64decode(public["n"] + "=" * (-len(public["n"]) % 4)), "big")
    if private_key.public_key().public_numbers().n != expected_n:
        raise ValueError("Recovery key fingerprint mismatch")
    return private_key, hashlib.sha256(canonical.encode()).hexdigest()


def decrypt_packet(data, private_key):
    if len(data) < 418 or data[:4] != b"MFR1":
        raise ValueError("Invalid encrypted rescue packet")
    wrapped_length = int.from_bytes(data[4:6], "big")
    if wrapped_length != 384:
        raise ValueError("Invalid wrapped key length")
    end = 6 + wrapped_length
    key = private_key.decrypt(data[6:end], padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    return AESGCM(key).decrypt(data[end:end + 12], data[end + 12:], data[:end + 12])


class Store:
    def __init__(self, account_id=None, bucket="mailflare-rescue", profile="mailflare-r2", directory=None):
        self.directory = Path(directory).resolve() if directory else None
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Invalid bucket name")
        if not self.directory and not re.fullmatch(r"[0-9a-f]{32}", account_id or ""):
            raise ValueError("Use --account-id with your 32-character Cloudflare account ID")
        self.bucket, self.profile = bucket, profile
        self.endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    def read(self, key, offset=None, length=None):
        if not key.startswith("rescue/") or ".." in key.split("/"):
            raise ValueError("Unexpected rescue object key")
        if length is not None and (length < 0 or length > MAX_CHUNK):
            raise ValueError("Rescue range exceeds the memory limit")
        if self.directory:
            path = self.directory / key
            if path.is_symlink() or not path.resolve().is_relative_to(self.directory):
                raise ValueError("Unsafe local object path")
            with path.open("rb") as source:
                if offset is not None:
                    source.seek(offset)
                return source.read(length if length is not None else MAX_CHUNK + 1)
        with tempfile.TemporaryDirectory(prefix="mailflare-rescue-") as temporary:
            path = Path(temporary) / "packet"
            command = ["aws", "s3api", "get-object", "--bucket", self.bucket, "--key", key, "--profile", self.profile,
                       "--region", "auto", "--endpoint-url", self.endpoint, "--no-cli-pager"]
            if offset is not None:
                command += ["--range", f"bytes={offset}-{offset + length - 1}"]
            command += [str(path)]
            for attempt in range(4):
                result = subprocess.run(command, capture_output=True, check=False)
                if result.returncode == 0:
                    if path.stat().st_size > MAX_CHUNK:
                        raise ValueError("Downloaded packet exceeds the memory limit")
                    return path.read_bytes()
                if attempt < 3:
                    time.sleep(2 ** attempt)
            raise RuntimeError("R2 download failed. Check the selected AWS profile and bucket read permissions.")


def read_chunk(store, descriptor, private_key):
    if not (0 <= descriptor["bytes"] <= MAX_CHUNK and 0 <= descriptor["rawBytes"] <= MAX_CHUNK):
        raise ValueError("Invalid rescue chunk size")
    encrypted = store.read(descriptor["key"])
    if len(encrypted) != descriptor["bytes"] or hashlib.sha256(encrypted).hexdigest() != descriptor["sha256"]:
        raise ValueError("Rescue chunk checksum mismatch")
    compressed = decrypt_packet(encrypted, private_key)
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
        raw = source.read(descriptor["rawBytes"] + 1)
    if len(raw) != descriptor["rawBytes"]:
        raise ValueError("Rescue chunk decompression size mismatch")
    return json.loads(raw)


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def insert_row(database, table, row):
    if not row:
        return
    names = list(row)
    database.execute(f"INSERT INTO {quote(table)} ({','.join(map(quote, names))}) VALUES ({','.join('?' for _ in names)})", [row[name] for name in names])


def normalize(table, row):
    row = dict(row)
    if "lease_token" in row:
        row["lease_token"] = None
    if "lease_until" in row:
        row["lease_until"] = 0
    if table in ("mbox_import_jobs", "gmail_import_jobs", "mbox_sorting_jobs", "mail_content_audit_jobs", "message_bulk_jobs", "paperless_jobs") and row.get("status") in ("pending", "queued", "running", "waiting", "failed"):
        row["status"] = "paused"
    if table == "message_bulk_jobs":
        row["pending_chunk"] = None
    if table == "backup_settings":
        row.update(enabled=0, retention_enabled=0, schedule_type="weekly", schedule_value=0)
    if table in ("paperless_connections", "mailbox_agent_settings"):
        row["enabled"] = 0
    if table == "agent_jobs" and row.get("status") in ("pending", "running"):
        row.update(status="failed", reason="restore_requires_review")
    if table == "agent_send_approvals" and row.get("status") in ("pending", "claimed", "unknown"):
        row["status"] = "cancelled"
    if table == "outbound_jobs" and row.get("status") == "queued":
        row.update(status="failed", error="restore_requires_review")
    return row


def recover(store, private_key, fingerprint, output, descriptor=None):
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("Choose an empty output directory; an existing recovery is never overwritten")
    pointer = descriptor or json.loads(store.read("rescue/current.json"))
    if pointer.get("format") != "mailflare-rescue-pointer" or pointer.get("version") != 1 or pointer.get("keyFingerprint") != fingerprint:
        raise ValueError("This recovery key does not match the rescue point")
    manifest = read_chunk(store, pointer["manifest"], private_key)
    if manifest.get("format") != "mailflare-rescue" or manifest.get("version") != 1 or manifest.get("backupId") != pointer["backupId"] or manifest.get("keyFingerprint") != fingerprint:
        raise ValueError("Invalid rescue manifest")
    (output / "recovery.json").write_text(json.dumps(pointer, indent=2))
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    database = sqlite3.connect(output / "mailflare.sqlite")
    schema = manifest["database"]["schema"]
    for item in schema:
        if item["type"] == "table":
            database.execute(item["sql"])
    tables = set(manifest["database"]["tables"])
    for chunk in manifest["database"]["parts"]:
        part = read_chunk(store, chunk, private_key)
        table = part.get("table")
        if part.get("format") != "mailflare-rescue-table" or part.get("version") != 1 or table not in tables:
            raise ValueError("Unexpected database table chunk")
        if table not in ("backups", "sessions", "password_reset_tokens", "login_challenges"):
            for row in part["records"]:
                insert_row(database, table, normalize(table, row))
        database.commit()
    for row in manifest["database"]["migrations"]:
        insert_row(database, "d1_migrations", row)
    timestamp = int(__import__("datetime").datetime.fromisoformat(manifest["verifiedAt"].replace("Z", "+00:00")).timestamp())
    insert_row(database, "backups", {"id": manifest["backupId"], "kind": "rescue", "status": "completed", "trigger": "manual", "r2_key": pointer["manifest"]["key"], "filename": f"mailflare-{manifest['backupId']}.rescue.json", "verified_at": timestamp, "object_count": manifest["objects"]["count"], "object_bytes": manifest["objects"]["bytes"], "created_at": timestamp, "completed_at": timestamp})
    (output / "objects").mkdir(mode=0o700)
    total, total_bytes = 0, 0
    with (output / "objects.ndjson").open("w") as index:
        for shard in manifest["objects"]["shards"]:
            for item in read_chunk(store, shard, private_key):
                size = item["size"]
                expected_parts = max(1, (size + COPY_BYTES - 1) // COPY_BYTES)
                if size < 0 or len(item["checksums"]) != expected_parts:
                    raise ValueError("Invalid original file length")
                filename = hashlib.sha256(item["key"].encode()).hexdigest()
                digest = hashlib.sha256()
                with (output / "objects" / filename).open("wb") as destination:
                    offset = 0
                    for number, checksum in enumerate(item["checksums"]):
                        plain_length = min(COPY_BYTES, size - number * COPY_BYTES)
                        length = plain_length + 418
                        packet = store.read(item["blobKey"], offset, length)
                        if len(packet) != length or hashlib.sha256(packet).hexdigest() != checksum:
                            raise ValueError("Original file checksum mismatch")
                        plain = decrypt_packet(packet, private_key)
                        if len(plain) != plain_length:
                            raise ValueError("Original file length mismatch")
                        destination.write(plain)
                        digest.update(plain)
                        offset += length
                index.write(json.dumps({"key": item["key"], "file": filename, "metadata": item["metadata"], "sha256": digest.hexdigest(), "size": size}) + "\n")
                insert_row(database, "backup_snapshot_objects", {"backup_id": manifest["backupId"], "source_key": item["key"], "source_etag": item["etag"], "size": size, "blob_key": item["blobKey"], "destination_etag": item["destinationEtag"], "metadata": json.dumps(item["metadata"]), "checksums": json.dumps(item["checksums"]), "state": "verified"})
                total += 1
                total_bytes += size
            database.commit()
    if total != manifest["objects"]["count"] or total_bytes != manifest["objects"]["bytes"]:
        raise ValueError("Rescue file inventory does not match")
    for item in schema:
        if item["type"] in ("index", "trigger"):
            database.execute(item["sql"])
    if any(item["name"] == "messages_fts" for item in schema):
        database.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    if database.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("Recovered database has broken references")
    if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("Recovered database integrity check failed")
    database.commit()
    database.close()
    (output / "VERIFIED").write_text(f"{manifest['backupId']}\n{total} files\n{total_bytes} bytes\n")
    return {"backupId": manifest["backupId"], "objects": total, "bytes": total_bytes}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id")
    parser.add_argument("--bucket", default="mailflare-rescue")
    parser.add_argument("--profile", default="mailflare-r2")
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--descriptor", help="Optional downloaded .rescue.json descriptor")
    parser.add_argument("--source-directory", help="Read an already downloaded encrypted bucket locally")
    args = parser.parse_args()
    private_key, fingerprint = load_private_key(args.key_file, getpass.getpass("Passwort der Wiederherstellungsschlüsseldatei: "))
    store = Store(args.account_id, args.bucket, args.profile, args.source_directory)
    descriptor = json.loads(Path(args.descriptor).read_text()) if args.descriptor else None
    result = recover(store, private_key, fingerprint, args.output, descriptor)
    print(f"Geprüfter Rettungsstand lokal wiederhergestellt: {result['objects']} Dateien, {result['bytes']} Bytes.")
    print("Datenbank: mailflare.sqlite. Originaldateien: objects/ mit Zuordnung in objects.ndjson.")
    print("Die laufende Mailflare-Installation wurde nicht verändert.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit("Wiederherstellung unterbrochen. Der Cloudflare-Rettungsstand bleibt unverändert.")
    except Exception as error:
        # Avoid accidentally logging decrypted rows, credentials or key material.
        raise SystemExit(f"Wiederherstellung fehlgeschlagen ({type(error).__name__}). Zugang, Schlüssel und freien Speicher prüfen; vorhandene Rettungsstände bleiben erhalten.")
