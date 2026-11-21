#!/bin/sh
set -eu
stamp=$(date -u +%Y%m%dT%H%M%SZ)
sqlite3 "$DATABASE_PATH" ".backup /tmp/shiftgate-$stamp.sqlite"
aws s3 cp "/tmp/shiftgate-$stamp.sqlite" "${BACKUP_S3_URI}${stamp}.sqlite" --only-show-errors
rm -f "/tmp/shiftgate-$stamp.sqlite"
