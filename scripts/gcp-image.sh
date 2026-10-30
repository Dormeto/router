#!/usr/bin/env bash
# The router's Google Cloud image: scripts/gcp-image.sh <version> [--push <repository>]
# Builds gcp/Containerfile with podman for linux/amd64 (Cloud Run), tagged dormeto-router:<version>. With --push, logs in
# to the repository's registry with the `dormeto-dev` gcloud configuration's token (no IAM change: the caller's own
# access) and pushes <repository>:<version>, for example europe-west1-docker.pkg.dev/dormeto-dev/dormeto/router.
# DMT_IMAGE_DRY_RUN=1 prints the commands instead of running them (the arguments' tests).
set -euo pipefail

usage() { echo "usage: scripts/gcp-image.sh <version> [--push <repository>]" >&2; exit 2; }

[[ $# -ge 1 && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
VERSION="$1"
shift
REPOSITORY=""
if [[ $# -gt 0 ]]; then
  [[ $# -eq 2 && "$1" == "--push" && -n "$2" ]] || usage
  REPOSITORY="$2"
fi

cd "$(dirname "$0")/.."
LOCAL="dormeto-router:$VERSION"

run() {
  if [[ -n "${DMT_IMAGE_DRY_RUN:-}" ]]; then echo "$*"; else eval "$*"; fi
}

run "podman build --platform linux/amd64 -f gcp/Containerfile -t $LOCAL ."
if [[ -n "$REPOSITORY" ]]; then
  REGISTRY="${REPOSITORY%%/*}"
  run "gcloud --configuration dormeto-dev auth print-access-token | podman login -u oauth2accesstoken --password-stdin $REGISTRY"
  run "podman push $LOCAL docker://$REPOSITORY:$VERSION"
fi
