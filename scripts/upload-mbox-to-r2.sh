#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 5 ]]; then
  echo 'Usage: bash scripts/upload-mbox-to-r2.sh FILE ACCOUNT_ID [BUCKET] [OBJECT_KEY] [AWS_PROFILE]' >&2
  exit 2
fi
mbox_path=$1
r2_account_id=$2
r2_bucket=${3:-mailflare-raw}
r2_object_key=${4:-mbox-imports/workspace-002.mbox}
r2_profile=${5:-mailflare-r2}
if [[ ! -f "$mbox_path" ]]; then echo 'The local MBOX file does not exist.' >&2; exit 2; fi
if [[ ! "$r2_account_id" =~ ^[[:xdigit:]]{32}$ ]]; then echo 'Enter the 32-character Cloudflare account ID.' >&2; exit 2; fi
if [[ "$r2_object_key" != mbox-imports/*.mbox && "$r2_object_key" != mbox-imports/*.mbx ]]; then echo 'Choose a .mbox object key inside mbox-imports/.' >&2; exit 2; fi
if ! command -v aws >/dev/null 2>&1; then echo 'Install AWS CLI first, then configure the mailflare-r2 profile with R2 S3 credentials.' >&2; exit 2; fi
aws configure set s3.multipart_threshold 64MB --profile "$r2_profile"
aws configure set s3.multipart_chunksize 64MB --profile "$r2_profile"
AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  aws s3 cp "$mbox_path" "s3://$r2_bucket/$r2_object_key" \
  --profile "$r2_profile" --region auto \
  --endpoint-url "https://$r2_account_id.r2.cloudflarestorage.com" \
  --content-type application/mbox
printf '\nUpload complete. Enter this object key in Mailflare Settings → Import:\n%s\n' "$r2_object_key"
