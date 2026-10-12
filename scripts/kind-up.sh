#!/usr/bin/env bash
# The router's Kubernetes integration tests (npm run test:k8s, never in npm test): a kind cluster on podman (the default
# provider here, KIND_EXPERIMENTAL_PROVIDER overrides it), KEDA, the published manifest and the test workloads. Kept
# between runs; scripts/kind-down.sh deletes it.
set -euo pipefail

export KIND_EXPERIMENTAL_PROVIDER="${KIND_EXPERIMENTAL_PROVIDER:-podman}"
NAME="${DMT_KIND_CLUSTER:-dormeto-k8s-test}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.build/kind"
mkdir -p "$WORK"
export KUBECONFIG="$WORK/kubeconfig"

if kind get clusters 2>/dev/null | grep -qx "$NAME"; then
  kind export kubeconfig --name "$NAME" --kubeconfig "$KUBECONFIG"
else
  kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s
fi

# KEDA from its chart, the Helm repositories kept apart from the caller's own.
export HELM_REPOSITORY_CONFIG="$WORK/helm/repositories.yaml" HELM_REPOSITORY_CACHE="$WORK/helm/cache"
helm upgrade --install keda keda --repo https://kedacore.github.io/charts --version 2.21.0 \
  --namespace keda --create-namespace --wait --timeout 5m

kubectl apply -f "$ROOT/kubernetes/dormeto-router.yaml"
kubectl apply -f "$ROOT/lambda/test-k8s/fixtures.yaml"
kubectl -n dormeto-test rollout status deployment/web --timeout 120s
kubectl -n dormeto-test rollout status deployment/api --timeout 120s
