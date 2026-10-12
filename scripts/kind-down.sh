#!/usr/bin/env bash
# Deletes the kind cluster of the Kubernetes integration tests (scripts/kind-up.sh).
set -euo pipefail
export KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER:-podman}"
kind delete cluster --name "${DMT_KIND_CLUSTER:-dormeto-k8s-test}"
