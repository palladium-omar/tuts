#!/bin/bash
set -euo pipefail
cd /opt/tuts/current
umask 077
export RELEASE_TAG
RELEASE_TAG=$(cat /opt/tuts/RELEASE)
[[ "$RELEASE_TAG" =~ ^[a-f0-9]{40}$ ]] || exit 1
backup_root=/var/backups/tuts
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_root/$stamp"
mkdir -p "$target"
compose=(docker compose --env-file /opt/tuts/.env.production -f compose.production.yaml)
for service in platform clients scheduling learning billing payments notifications integrations planning reporting; do
  "${compose[@]}" exec -T postgres pg_dump -U postgres --format=custom "$service" > "$target/$service.dump"
done
"${compose[@]}" run --rm --no-deps --entrypoint sh -T learning -c 'tar -czf - -C /data uploads' > "$target/uploads.tar.gz"
cp /opt/tuts/.env.production "$target/environment"
cp /opt/tuts/RELEASE "$target/release"
touch "$target/COMPLETE"
# Keep incomplete backups for diagnosis; expire only complete daily backups.
find "$backup_root" -mindepth 2 -maxdepth 2 -name COMPLETE -mtime +13 -print0 | while IFS= read -r -d '' marker; do
  rm -rf -- "${marker%/COMPLETE}"
done
