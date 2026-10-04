#!/bin/bash
set -euo pipefail
# Run as root: activate-release.sh /opt/tuts/releases/<commit> <commit>
release_dir=$(realpath "$1")
revision=$2
[[ "$release_dir" == /opt/tuts/releases/* && "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 1
cd "$release_dir"
if [[ ! -f /opt/tuts/.env.production ]]; then
  docker run --rm --entrypoint node -v "$release_dir:/source" -w /source node:24-alpine scripts/setup-production.mjs
  mv .env.production /opt/tuts/.env.production
fi
export RELEASE_TAG="$revision"
compose=(docker compose --env-file /opt/tuts/.env.production -f compose.production.yaml)
"${compose[@]}" config --quiet
# Sequential image builds keep Next.js and the database below the VM memory limit.
for service in platform clients scheduling learning billing payments notifications integrations gateway web; do
  "${compose[@]}" build "$service"
done
if [[ -L /opt/tuts/current ]]; then
  /opt/tuts/current/infra/production/backup.sh
fi
"${compose[@]}" up -d --wait --wait-timeout 240
ln -sfn "$release_dir" /opt/tuts/current
printf '%s\n' "$revision" > /opt/tuts/RELEASE
install -m 0644 infra/production/tuts-backup.service /etc/systemd/system/
install -m 0644 infra/production/tuts-backup.timer /etc/systemd/system/
chmod 0750 infra/production/backup.sh
systemctl daemon-reload
systemctl enable --now tuts-backup.timer
/opt/tuts/current/infra/production/backup.sh
"${compose[@]}" ps
