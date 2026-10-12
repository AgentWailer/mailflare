#!/usr/bin/env python3
"""Resume an existing R2 multipart upload using the locally configured AWS CLI.

No credentials are read or printed by this script. Existing parts are checked
against the unchanged local source before any missing parts are uploaded.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

MIB = 1024 * 1024
MIN_PART = 5 * MIB
MAX_PART = 5 * 1024 ** 3


def valid_mbox_key(key):
    archive = key.startswith("mbox-imports/") and key.lower().endswith((".mbox", ".mbx"))
    drive = re.fullmatch(r"drive/[A-Za-z0-9_-]+/drv_[A-Za-z0-9_-]+", key) is not None
    return (archive or drive) and ".." not in key.split("/") and not any(ord(char) < 32 for char in key)


class ResumeError(Exception):
    pass


class AwsCli:
    def __init__(self, account_id, profile):
        self.options = ["--profile", profile, "--region", "auto", "--endpoint-url",
                        f"https://{account_id}.r2.cloudflarestorage.com", "--output", "json", "--no-cli-pager"]

    def call(self, operation, *arguments):
        environment = dict(os.environ, AWS_REQUEST_CHECKSUM_CALCULATION="when_required",
                           AWS_RESPONSE_CHECKSUM_VALIDATION="when_required", AWS_PAGER="")
        result = subprocess.run(["aws", "s3api", operation, *arguments, *self.options],
                                capture_output=True, text=True, env=environment)
        if result.returncode:
            raise ResumeError(f"AWS CLI {operation} failed:\n{result.stderr.strip()[:2000]}")
        try:
            return json.loads(result.stdout or "{}")
        except ValueError as error:
            raise ResumeError(f"Invalid AWS CLI response for {operation}") from error


def source_identity(path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def unchanged(path, identity):
    if source_identity(path) != identity:
        raise ResumeError("The local MBOX changed during verification/upload. Stop editing it and retry.")


def part_digest(source, offset, length, output=None):
    source.seek(offset)
    digest = hashlib.md5(usedforsecurity=False)
    remaining = length
    while remaining:
        data = source.read(min(MIB, remaining))
        if not data:
            raise ResumeError("Unexpected end of local MBOX; the source may have changed.")
        digest.update(data)
        if output is not None:
            output.write(data)
        remaining -= len(data)
    return digest.hexdigest()


def read_parts(api, bucket, key, upload_id):
    # AWS CLI automatically follows the S3 pagination and aggregates Parts.
    result = api.call("list-parts", "--bucket", bucket, "--key", key, "--upload-id", upload_id)
    parts = {}
    for part in result.get("Parts", []):
        number = part.get("PartNumber")
        if not isinstance(number, int) or number < 1 or number > 10000 or number in parts:
            raise ResumeError("Invalid or duplicate remote multipart part number.")
        etag = str(part.get("ETag", "")).strip('"').lower()
        if not re.fullmatch(r"[0-9a-f]{32}", etag):
            raise ResumeError("Remote part ETags are not MD5 values; verification cannot safely resume this upload.")
        size = part.get("Size")
        if not isinstance(size, int) or size < 1:
            raise ResumeError("Invalid remote multipart part size.")
        parts[number] = {"size": size, "digest": etag, "etag": part["ETag"]}
    return parts


def resume(api, source_path, bucket, key, upload_id=None, part_size=None, emit=print):
    source_path = Path(source_path)
    if not source_path.is_file():
        raise ResumeError("The local MBOX file does not exist.")
    identity = source_identity(source_path)
    size = identity[2]
    if not size:
        raise ResumeError("The local MBOX is empty.")
    result = api.call("list-multipart-uploads", "--bucket", bucket, "--prefix", key)
    uploads = [upload for upload in result.get("Uploads", []) if upload.get("Key") == key]
    if upload_id:
        uploads = [upload for upload in uploads if upload.get("UploadId") == upload_id]
    if not uploads:
        raise ResumeError("No ongoing multipart upload exists for this exact object key. Check whether it already completed or was aborted.")
    if len(uploads) != 1:
        choices = "\n".join(f"  {upload.get('UploadId')} (started {upload.get('Initiated', 'unknown')})" for upload in uploads)
        raise ResumeError("Multiple ongoing uploads exist. Choose the original with --upload-id:\n" + choices)
    upload_id = uploads[0]["UploadId"]
    remote = read_parts(api, bucket, key, upload_id)
    if part_size is None:
        if not remote:
            raise ResumeError("No existing part size can be inferred. Specify --part-size-mib 64 if that was the original upload setting.")
        part_size = max(part["size"] for part in remote.values())
    count = math.ceil(size / part_size)
    if part_size < MIN_PART or part_size > MAX_PART or count > 10000:
        raise ResumeError("Cannot safely infer valid multipart boundaries. Set --part-size-mib to the original upload part size.")
    lengths = {number: min(part_size, size - (number - 1) * part_size) for number in range(1, count + 1)}
    for number, part in remote.items():
        if number not in lengths or part["size"] != lengths[number]:
            raise ResumeError("Remote parts do not match the local file size/part boundaries. Check the file and original part size.")
    emit(f"Existing upload: {len(remote)}/{count} parts, {sum(part['size'] for part in remote.values()) / 1024**3:.2f} GiB already uploaded.")
    emit("Verifying existing parts against the local MBOX; no existing parts are being downloaded or overwritten.")
    with source_path.open("rb") as source:
        for number, part in sorted(remote.items()):
            unchanged(source_path, identity)
            digest = part_digest(source, (number - 1) * part_size, lengths[number])
            if digest != part["digest"]:
                raise ResumeError(f"Local data differs from uploaded part {number}. Nothing was completed. Use the original unchanged MBOX.")
        unchanged(source_path, identity)
        emit("Existing parts verified.")
        with tempfile.TemporaryDirectory(prefix="mailflare-r2-resume-") as temporary:
            temporary = Path(temporary)
            part_path = temporary / "part.bin"
            for number in range(1, count + 1):
                if number in remote:
                    continue
                unchanged(source_path, identity)
                with part_path.open("wb") as output:
                    digest = part_digest(source, (number - 1) * part_size, lengths[number], output)
                unchanged(source_path, identity)
                emit(f"Uploading missing part {number}/{count} ({lengths[number] / MIB:.1f} MiB)...")
                uploaded = api.call("upload-part", "--bucket", bucket, "--key", key,
                                    "--upload-id", upload_id, "--part-number", str(number), "--body", str(part_path))
                etag = str(uploaded.get("ETag", ""))
                if etag.strip('"').lower() != digest:
                    raise ResumeError(f"Uploaded part {number} did not pass the integrity check. Retry without starting a new upload.")
                remote[number] = {"size": lengths[number], "digest": digest, "etag": etag}
                part_path.unlink()
            unchanged(source_path, identity)
            current = read_parts(api, bucket, key, upload_id)
            if current != remote:
                raise ResumeError("Remote parts changed while resuming. Stop other upload processes before retrying.")
            manifest = temporary / "complete.json"
            manifest.write_text(json.dumps({"Parts": [{"PartNumber": number, "ETag": remote[number]["etag"]}
                                                    for number in range(1, count + 1)]}), encoding="utf-8")
            unchanged(source_path, identity)
            expected = hashlib.md5(b"".join(bytes.fromhex(remote[number]["digest"]) for number in range(1, count + 1)), usedforsecurity=False).hexdigest() + f"-{count}"
            emit("All parts verified. Completing the existing multipart upload...")
            try:
                api.call("complete-multipart-upload", "--bucket", bucket, "--key", key,
                         "--upload-id", upload_id, "--multipart-upload", "file://" + str(manifest))
            except ResumeError:
                # A lost completion response may still have published the full object.
                final = api.call("head-object", "--bucket", bucket, "--key", key)
                if final.get("ContentLength") != size or str(final.get("ETag", "")).strip('"').lower() != expected:
                    raise
            final = api.call("head-object", "--bucket", bucket, "--key", key)
            if final.get("ContentLength") != size or str(final.get("ETag", "")).strip('"').lower() != expected:
                raise ResumeError("Completion could not be verified: final object size/checksum differs. Do not start the import yet.")
    emit(f"Upload complete and verified: s3://{bucket}/{key} ({size} bytes).")
    emit(f"Mailflare Settings → Import → R2 object key: {key}")
    return {"size": size, "parts": count, "etag": expected, "upload_id": upload_id}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="Path to the original unchanged local MBOX")
    parser.add_argument("account_id", help="32-character Cloudflare account ID")
    parser.add_argument("--bucket", default="mailflare-raw")
    parser.add_argument("--key", default="mbox-imports/workspace-002.mbox")
    parser.add_argument("--profile", default="mailflare-r2")
    parser.add_argument("--upload-id", help="Select an existing upload if more than one exists")
    parser.add_argument("--part-size-mib", type=int, help="Original multipart part size if it cannot be inferred")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F]{32}", args.account_id):
        parser.error("Enter the 32-character Cloudflare account ID")
    if not valid_mbox_key(args.key):
        parser.error("Use a .mbox key inside mbox-imports/ or the exact drive/OWNER/drv_ID key of your MBOX")
    if not shutil.which("aws"):
        parser.error("Install AWS CLI and configure the mailflare-r2 profile first")
    if args.part_size_mib is not None and not 5 <= args.part_size_mib <= 5120:
        parser.error("Part size must be between 5 and 5120 MiB")
    try:
        resume(AwsCli(args.account_id, args.profile), args.file, args.bucket, args.key,
               args.upload_id, args.part_size_mib * MIB if args.part_size_mib else None,
               emit=lambda message: print(message, flush=True))
    except (ResumeError, OSError, KeyboardInterrupt) as error:
        print(f"Resume stopped: {error}\nExisting parts are retained. Fix the issue and run this same command again.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
