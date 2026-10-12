#!/usr/bin/env bash
# End-to-end acceptance of the Dormeto MVP against the deployed dev environment.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-kloudy-dormeto-prd}"
export AWS_REGION="${AWS_REGION:-eu-west-1}"
TF="${TERRAFORM:-terraform} -chdir=$(dirname "$0")/../terraform/dev"

URL=$($TF output -raw url)
WORKLOAD=$($TF output -raw workload_id)
TABLE=$($TF output -raw table_name)
CONTROLLER=$($TF output -raw controller_function_name)
WAKER=$($TF output -raw waker_function_name)
INSTANCE=$($TF output -raw instance_id)
RULE=$($TF output -raw rule_arn)

pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

run_attr() {
  aws dynamodb get-item --table-name "$TABLE" --consistent-read \
    --key "{\"pk\":{\"S\":\"WL#$WORKLOAD\"},\"sk\":{\"S\":\"RUN\"}}" \
    --query "Item.$1.* | [0]" --output text
}
instance_state() { aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text; }
waker_weight() {
  aws elbv2 describe-rules --rule-arns "$RULE" \
    --query "Rules[0].Actions[?Type=='forward'].ForwardConfig.TargetGroups[] | [?contains(TargetGroupArn, 'targetgroup/dmt-dev-$WORKLOAD/')].Weight | [0]" --output text
}
# A nap can last longer than the default 60 s CLI read timeout; a CLI retry would invoke a second nap.
controller() { AWS_MAX_ATTEMPTS=1 aws lambda invoke --cli-read-timeout 900 --function-name "$CONTROLLER" --cli-binary-format raw-in-base64-out --payload "$1" /dev/stdout >/dev/null; }
wait_for_app() {
  local deadline=$((SECONDS + ${1:-300}))
  until curl -sS "$URL" 2>/dev/null | grep -q 'Dormeto demo'; do
    [ $SECONDS -lt $deadline ] || fail "application not back within ${1:-300}s"
    sleep 3
  done
}
waker_invocations() {
  aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Invocations \
    --dimensions Name=FunctionName,Value="$WAKER" --statistics Sum --period 60 \
    --start-time "$(date -u -v-"${1}"M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --query 'sum(Datapoints[].Sum)' --output text
}

echo "== 1. Awake: served by the app, waker out of the path"
[ "$(run_attr state)" = "AWAKE" ] || controller '{"action":"check"}'
wait_for_app 300
[ "$(waker_weight)" = "0" ] || fail "waker weight is not 0 while awake"
for _ in $(seq 1 100); do curl -sS -o /dev/null "$URL"; done
pass "application served, waker weight 0"

echo "== 2. Nap"
controller "{\"action\":\"nap\",\"workloadId\":\"$WORKLOAD\"}"
[ "$(run_attr state)" = "ASLEEP" ] || fail "state is $(run_attr state), expected ASLEEP"
[ "$(instance_state)" = "stopped" ] || fail "instance is $(instance_state)"
[ "$(waker_weight)" = "1" ] || fail "waker weight is not 1 while asleep"
pass "asleep, instance stopped, route on the waker"

# The account Lambda concurrency limit is 10: keep the burst below it (BURST=50 after a quota increase).
BURST="${BURST:-8}"
echo "== 3. Burst of $BURST concurrent requests wakes exactly once"
BEFORE=$(run_attr wakeCount)
CODES=$(seq 1 "$BURST" | xargs -P "$BURST" -I{} curl -sS -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' "$URL" | sort | uniq -c)
echo "$CODES"
echo "$CODES" | awk '{print $2}' | grep -qvE '^(503|307|200)$' && fail "unexpected status codes"
AFTER=$(run_attr wakeCount)
[ "$AFTER" -eq $((BEFORE + 1)) ] || fail "wakeCount went from $BEFORE to $AFTER"
pass "single wake (wakeCount $BEFORE -> $AFTER)"

echo "== 4. Back to awake without manual action"
START=$SECONDS
wait_for_app 300
pass "application back in $((SECONDS - START))s after the burst"
until [ "$(run_attr state)" = "AWAKE" ]; do sleep 2; done
[ "$(waker_weight)" = "0" ] || fail "waker weight is not 0 after wake"
pass "state AWAKE, route back on the app"

echo "== 5. A request during the drain aborts the nap"
aws lambda invoke --function-name "$CONTROLLER" --invocation-type Event --cli-binary-format raw-in-base64-out \
  --payload "{\"action\":\"nap\",\"workloadId\":\"$WORKLOAD\"}" /dev/null >/dev/null
# ALB rule changes take about 12 s to propagate: send the request after it, within the 30 s drain.
sleep 20
curl -sS -o /dev/null -H 'Accept: text/html' "$URL"
sleep 20
[ "$(run_attr state)" = "AWAKE" ] || fail "state is $(run_attr state), expected AWAKE (nap aborted)"
[ "$(instance_state)" = "running" ] || fail "instance is $(instance_state), expected running"
pass "nap aborted, instance never stopped"

echo "== 6. Reconcile an instance started outside Dormeto"
controller "{\"action\":\"nap\",\"workloadId\":\"$WORKLOAD\"}"
[ "$(run_attr state)" = "ASLEEP" ] || fail "nap before reconcile failed"
aws ec2 start-instances --instance-ids "$INSTANCE" >/dev/null
aws ec2 wait instance-running --instance-ids "$INSTANCE"
sleep 30
controller '{"action":"check"}'
[ "$(run_attr state)" = "AWAKE" ] || fail "state is $(run_attr state), expected AWAKE after reconcile"
[ "$(waker_weight)" = "0" ] || fail "route not switched back after reconcile"
wait_for_app 120
pass "external start reconciled"

echo "== 7. Waker invocations while awake (last 2 minutes, after reconcile)"
sleep 120
for _ in $(seq 1 50); do curl -sS -o /dev/null "$URL"; done
sleep 90
COUNT=$(waker_invocations 2)
[ "$COUNT" = "None" ] || [ "${COUNT%.*}" = "0" ] || fail "waker invoked $COUNT times while awake"
pass "no waker invocation while awake"

echo "All end-to-end checks passed."
