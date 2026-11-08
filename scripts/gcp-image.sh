#!/usr/bin/env bash
# The router's Google Cloud image:
#   scripts/gcp-image.sh <version> [--push --configuration <name> --repository <host>/<project>/<repo> [--repository ...]]
# Builds gcp/Containerfile with podman for linux/amd64 (Cloud Run), tagged dormeto-router:<version>. With --push, logs in
# to each repository's registry with the token of the gcloud configuration named by --configuration (no IAM change: the
# caller's own access) and pushes <repository>/router:<version>, printing each pushed image's digest. There is no default
# configuration and no default project: --push needs --configuration and at least one --repository. For example, the
# release pushes with --configuration dormeto-releases to europe-docker.pkg.dev/dormeto-releases/router,
# us-docker.pkg.dev/dormeto-releases/router and asia-docker.pkg.dev/dormeto-releases/router.
# DMT_IMAGE_DRY_RUN=1 prints the commands instead of running them (the arguments' tests).
set -euo pipefail

usage() {
  echo "usage: scripts/gcp-image.sh <version> [--push --configuration <name> --repository <host>/<project>/<repo> [--repository ...]]" >&2
  exit 2
}

[[ $# -ge 1 && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
VERSION="$1"
shift
PUSH=""
CONFIGURATION=""
REPOSITORIES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --configuration | --repository)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || usage
      if [[ "$1" == "--configuration" ]]; then CONFIGURATION="$2"; else REPOSITORIES+=("$2"); fi
      shift 2 ;;
    *) usage ;;
  esac
done
if [[ -n "$PUSH" ]]; then
  [[ -n "$CONFIGURATION" && ${#REPOSITORIES[@]} -gt 0 ]] || usage
  for repository in "${REPOSITORIES[@]}"; do
    [[ "$repository" =~ ^[a-z0-9.-]+/[a-z0-9-]+/[a-z0-9._/-]+$ ]] || usage
  done
elif [[ -n "$CONFIGURATION" || ${#REPOSITORIES[@]} -gt 0 ]]; then
  usage
fi

cd "$(dirname "$0")/.."
LOCAL="dormeto-router:$VERSION"

run() {
  if [[ -n "${DMT_IMAGE_DRY_RUN:-}" ]]; then echo "$*"; else eval "$*"; fi
}

run "podman build --platform linux/amd64 -f gcp/Containerfile -t $LOCAL ."
if [[ -n "$PUSH" ]]; then
  DIGESTS="$(mktemp)"
  trap 'rm -f "$DIGESTS"' EXIT
  LOGGED=" "
  for repository in "${REPOSITORIES[@]}"; do
    REGISTRY="${repository%%/*}"
    if [[ "$LOGGED" != *" $REGISTRY "* ]]; then
      run "gcloud --configuration $CONFIGURATION auth print-access-token | podman login -u oauth2accesstoken --password-stdin $REGISTRY"
      LOGGED="$LOGGED$REGISTRY "
    fi
    IMAGE="$repository/router:$VERSION"
    run "podman push --digestfile $DIGESTS $LOCAL docker://$IMAGE"
    if [[ -z "${DMT_IMAGE_DRY_RUN:-}" ]]; then echo "pushed $IMAGE $(cat "$DIGESTS")"; fi
  done
fi
