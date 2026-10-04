#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
project=${TUTS_GCP_PROJECT:-palladiumscholars-firebase}
region=${TUTS_GCP_REGION:-europe-west1}
zone=${TUTS_GCP_ZONE:-europe-west1-b}
vm=${TUTS_GCP_VM:-tuts-app}
revision=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Commit the deployment source before deploying.' >&2
  exit 1
fi
gcloud projects describe "$project" --format='value(projectId)'
gcloud services enable compute.googleapis.com iap.googleapis.com --project "$project" --quiet
if ! gcloud compute networks describe tuts-network --project "$project" >/dev/null 2>&1; then
  gcloud compute networks create tuts-network --subnet-mode=custom --project "$project" --quiet
fi
if ! gcloud compute networks subnets describe tuts-subnet --region "$region" --project "$project" >/dev/null 2>&1; then
  gcloud compute networks subnets create tuts-subnet --network=tuts-network --range=10.42.0.0/24 --region "$region" --project "$project" --quiet
fi
if ! gcloud compute addresses describe tuts-ip --region "$region" --project "$project" >/dev/null 2>&1; then
  gcloud compute addresses create tuts-ip --region "$region" --project "$project" --quiet
fi
ip=$(gcloud compute addresses describe tuts-ip --region "$region" --project "$project" --format='value(address)')
if ! gcloud compute firewall-rules describe tuts-web --project "$project" >/dev/null 2>&1; then
  gcloud compute firewall-rules create tuts-web --network=tuts-network --allow=tcp:80,tcp:443,udp:443 --source-ranges=0.0.0.0/0 --target-tags=tuts-web --project "$project" --quiet
fi
if ! gcloud compute firewall-rules describe tuts-iap-ssh --project "$project" >/dev/null 2>&1; then
  gcloud compute firewall-rules create tuts-iap-ssh --network=tuts-network --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=tuts-web --project "$project" --quiet
fi
if ! gcloud compute resource-policies describe tuts-daily-backup --region "$region" --project "$project" >/dev/null 2>&1; then
  gcloud compute resource-policies create snapshot-schedule tuts-daily-backup --region "$region" --daily-schedule --start-time=04:00 --max-retention-days=7 --storage-location=eu --on-source-disk-delete=keep-auto-snapshots --project "$project" --quiet
fi
if ! gcloud compute instances describe "$vm" --zone "$zone" --project "$project" >/dev/null 2>&1; then
  gcloud compute instances create "$vm" --project "$project" --zone "$zone" --machine-type=e2-standard-2 --image-family=debian-12 --image-project=debian-cloud --subnet=tuts-subnet --address="$ip" --tags=tuts-web --boot-disk-size=80GB --boot-disk-type=pd-balanced --no-boot-disk-auto-delete --deletion-protection --shielded-secure-boot --no-service-account --no-scopes --metadata=block-project-ssh-keys=true --labels=app=tuts,environment=production --quiet
  gcloud compute disks add-resource-policies "$vm" --resource-policies=tuts-daily-backup --zone "$zone" --project "$project" --quiet
fi
archive=$(mktemp -t tuts-release.XXXXXXXX)
trap 'rm -f "$archive"' EXIT
git archive --format=tar.gz "$revision" > "$archive"
ssh_flags=(--project "$project" --zone "$zone" --tunnel-through-iap --quiet)
gcloud compute scp "$archive" "$vm:/tmp/tuts-release-$revision.tar.gz" "${ssh_flags[@]}"
gcloud compute ssh "$vm" "${ssh_flags[@]}" --command="sudo mkdir -p /opt/tuts/releases/$revision && sudo tar -xzf /tmp/tuts-release-$revision.tar.gz -C /opt/tuts/releases/$revision && if ! command -v docker >/dev/null; then sudo bash /opt/tuts/releases/$revision/infra/production/install-host.sh; fi && sudo bash /opt/tuts/releases/$revision/infra/production/activate-release.sh /opt/tuts/releases/$revision $revision"
printf '\nGoDaddy DNS: A record, name tuts, value %s, TTL 600.\n' "$ip"
printf 'After DNS resolves, verify https://tuts.palladiumscholars.com and registration before reporting deployment complete.\n'
