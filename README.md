# Dormeto router

Data plane of [Dormeto](https://github.com/Dormeto/vision) ("nap" in Esperanto): it puts idle web workloads to
sleep and wakes them just-in-time on the next request.

This MVP manages one EC2 instance behind an ALB:

- `waker` Lambda: ALB target used only while the workload naps. It wakes the workload once, holds the request up to
  `waitSeconds`, then answers a `307` or a self-reloading waiter page.
- `controller` Lambda: switches the ALB rule weights, stops and starts the instance, naps idle workloads (scheduled
  check of the ALB `RequestCount`), and reconciles external changes.

A workload is identified by its **application target group**. Its **rules** are every listener rule of the target
group's load balancer that forwards to it, found at each nap, wake and idle check: a nap switches all of them to the waker
before stopping the backend, a wake switches them back once the targets are healthy. Instrument each rule: a weighted
forward to the application target group (weight 1) and to the workload's waker target group (weight 0), the tag
`dormeto:workload = <workload id>` (the controller may only change tagged rules), and `ignore_changes = [action]` in
Terraform. A rule forwarding to the target group without being instrumented (no waker target group, missing tag, other
target groups, or a listener default rule) is an **issue**: the router never naps the workload while it exists, wakes it
if it appears while the workload sleeps (that rule would reach the stopped backend), and shows it in the status.
Upgrading from 0.14 or earlier: an asleep workload with such a rule (for example an HTTP rule forwarding to the target
group) is woken at the first idle check and stays awake until the rule is instrumented or removed.

Instances are **discovered** from the application target group: every instance target tagged
`dormeto:workload=<workload id>` is managed; other targets are ignored (and shown on the admin dashboard). The nap records
the instances it stopped and the wake starts exactly those. A static `instance_ids` list on the `workload` module is
still supported.

**Auto Scaling groups** tagged `dormeto:workload=<workload id>` and feeding the application target group are managed as
a whole: the nap records their sizes, suspends the scaling processes and scales them to 0; the wake restores the sizes
and resumes the processes. Their instances are never stopped one by one. With a **warm pool** in `Stopped` state and
reuse on scale-in, a nap returns the instances to the pool and a wake restarts them instead of launching new ones (the
application must start at boot); the admin dashboard recommends that configuration when a group has no pool, a running
pool or no reuse on scale-in.

**ECS services** tagged `dormeto:workload=<workload id>` and feeding the application target group (found with the
Resource Groups Tagging API) are napped by `desiredCount = 0`, with their Application Auto Scaling target suspended; the
wake restores both.

**Databases** (RDS DB instances and Aurora DB clusters) tagged `dormeto:workload=<workload id>` are **companions**: the
nap stops them after the application (without waiting), the wake starts them and waits until they are available before
starting the application. A wake that outlasts one Lambda invocation continues in a new one (same wake id) until
`wake_timeout_seconds` (1800 s for workloads with a database). While a workload sleeps, a database restarted by AWS after
7 days is stopped again. Read replicas and Aurora Serverless v1 are ignored.

**No-wake requests** get the waiter page without waking the workload: `HEAD`, bot and scanner user agents, well-known
scanner paths (built in), and the configurable **no-wake rules** (`no_wake_rules` on the `router` module for every
workload, and on the `workload` module). A rule matches when all its conditions match: `source_ips` (addresses or CIDR
ranges, from the last `X-Forwarded-For` entry), `path_prefixes`, `path_pattern`, `user_agent_pattern`, `headers` (exact
`value` or `pattern`). Rules also apply to the waiter page's probe. Ignored requests are logged (`WakeIgnored`, with the
reason) and the rules are shown on the admin dashboard.

```hcl
no_wake_rules = [
  { name = "office", source_ips = ["198.51.100.0/24"] },
  { name = "uptime-monitor", user_agent_pattern = "^dormeto-uptime/" },
  { name = "health", path_prefixes = ["/healthz"], headers = [{ name = "x-monitor", value = "yes" }] },
]
```

**Wake mode** (`wake_mode` on the `workload` module): `any` (default) wakes on every request that passes the filters;
`browser` wakes only on the waiter page's JavaScript probe, the `x-dormeto-wake: 1` header (API clients, scripts) or a
**wake rule** (`wake_rules`, same format as the no-wake rules, for example `path_prefixes = ["/api/"]`). Other requests
get the waiter page at once (or JSON naming the wake header), so scanners that do not run JavaScript never wake the
workload; a request arriving during a wake is held as usual. The filters (no-wake rules, `HEAD`, bots, scanner paths)
apply to the probe too.

**IP reputation lists** (`ip_lists` on the `router` module): lists of networks (scanners, cloud ranges) downloaded by
the controller (daily by default) and used by the waker for every workload. `action = "defer"` (default) handles a
listed source as in browser mode: it gets the waiter page and only the page's probe wakes, so a real visitor loses about
one round trip while a scanner that does not run JavaScript never wakes the workload; `action = "ignore"` never wakes.
The `x-dormeto-wake: 1` header and wake rules override the lists. Formats: JSON (every address or CIDR string, for
example AWS `ip-ranges.json`) or text (first column of each line: ipsum, FireHOL, Spamhaus, CSV). Private and reserved
ranges are dropped at download. Behind a CDN or proxy the source address is the proxy's: do not use cloud range lists
there.

A list can also be an S3 object (`s3://bucket/key`), read with the S3 API: private lists, or lists prepared elsewhere.
The module grants the controller `s3:GetObject` on that object only; a bucket in another account must allow the
controller role in its bucket policy, and a customer managed KMS key in its key policy. Without `s3:ListBucket`, a
missing object is reported as `S3 AccessDenied`.

```hcl
ip_lists = [
  { name = "ipsum", url = "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt" },
  { name = "aws", url = "https://ip-ranges.amazonaws.com/ip-ranges.json" },
  { name = "censys", url = "s3://my-ip-lists/scanners/censys.txt", action = "ignore" },
]
```

**Statistics:** while a workload is not awake, the waker counts ignored requests per reason, deferred requests (browser
mode) and wakes per trigger in a daily item of the state table (`STATS#<day>`, kept 35 days); the admin dashboard shows
today and the last 7 days. With `metrics_enabled` on the `router` module, the same events also publish the CloudWatch
metrics `IgnoredRequests`, `DeferredRequests` and `Wakes` (namespace `Dormeto`, dimensions `Router`, `WorkloadId`)
through the embedded metric format of the log lines: no API call, about 0.30 USD per metric and month.

**Pause** (router management): a router or a workload can be paused, with a reason, its author and an optional
automatic resume (`until`, at most 366 days ahead). A paused workload, or every workload of a paused router, is never
napped: the idle check skips it and a nap request is refused (`SKIPPED`, reason `paused`, also when the pause arrives
during the drain); the reconcile still runs and requests still wake. Pausing wakes the asleep and failed workloads (a
napping one gets a pending wake) unless `keepAsleep`. Pauses live in the state table (`ROUTER / PAUSE`,
`WL#<id> / PAUSE`, and `WL#<id> / PAUSE#<exclusion>` for a manager exclusion), never in the configuration item that
Terraform writes; an expired pause no longer counts and the next idle check deletes it (`PauseExpired`). The manager
pauses and resumes from its Routers and workload views:

```bash
aws lambda invoke --function-name dmt-dev-controller --cli-binary-format raw-in-base64-out --payload '{"action":"pause","workloadId":"demo","by":"ops@example.com","reason":"load test","until":"2026-10-06T08:00:00Z"}' /dev/stdout
aws lambda invoke --function-name dmt-dev-controller --cli-binary-format raw-in-base64-out --payload '{"action":"resume","workloadId":"demo","by":"ops@example.com"}' /dev/stdout
```

**Health** (`router` action, manager Routers view): the last scheduled idle check (late after three periods: an error,
workloads do not nap), Lambda errors and throttles of the controller and the waker over 24 hours and the waker's peak
concurrency, messages waiting in the `check-failures` and `controller-failures` queues, IP lists' last download, failed
workloads; and the router configuration with its source (`terraform`). Metrics and queues are read at most once a minute.

The `dev` environment has four workloads: `demo` (one EC2 instance, `https://dev.dormeto.com/`), `demo-asg` (an Auto
Scaling group, `https://asg.dev.dormeto.com/`), `demo-ecs` (an ECS Fargate service in browser wake mode, `https://ecs.dev.dormeto.com/`) and
`demo-rds` (an ECS Fargate service with a PostgreSQL instance, `https://rds.dev.dormeto.com/`).

Design: [vision/docs/specs/2026-10-03-mvp-alb-ec2-design.md](https://github.com/Dormeto/vision/blob/main/docs/specs/2026-10-03-mvp-alb-ec2-design.md).

## Layout

| Path | Content |
|---|---|
| `lambda/src` | Lambda code (Node.js 24, no bundled dependency) |
| `lambda/test` | Unit tests (`node --test`) |
| `terraform/modules/router` | DynamoDB table, Lambdas, IAM, idle check schedule |
| `terraform/modules/workload` | Waker target group and workload configuration |
| `terraform/dev` | `dev` environment: demo VPC, ALB, EC2 on `dev.dormeto.com`, router wiring |
| `scripts/e2e.sh` | End-to-end acceptance against `dev` |

## Usage

Requirements: Node.js ≥ 24, Terraform 1.16.5 (tfenv reads `.terraform-version`), AWS CLI v2, profile
`kloudy-dormeto-prd`.

```bash
npm test                                   # unit tests
export AWS_PROFILE=kloudy-dormeto-prd
terraform -chdir=terraform/dev init
terraform -chdir=terraform/dev apply
./scripts/e2e.sh                           # end-to-end acceptance (about 10 minutes)
# If `terraform` is not 1.16.5 (for example a mise shim), use: TERRAFORM='tfenv exec' ./scripts/e2e.sh
terraform -chdir=terraform/dev destroy     # the ALB costs about 18 USD per month
```

Operations:

```bash
# Force a nap, run the idle check, read the runtime state
aws lambda invoke --cli-read-timeout 900 --function-name dmt-dev-controller --cli-binary-format raw-in-base64-out --payload '{"action":"nap","workloadId":"demo"}' /dev/stdout
aws lambda invoke --cli-read-timeout 900 --function-name dmt-dev-controller --cli-binary-format raw-in-base64-out --payload '{"action":"check"}' /dev/stdout
aws dynamodb get-item --table-name dmt-dev-router --key '{"pk":{"S":"WL#demo"},"sk":{"S":"RUN"}}'
```

## Version

`package.json` holds the router version. Terraform exposes it to both Lambdas as `DMT_VERSION`, with `DMT_BUILD` (first
12 hex characters of the Lambda zip SHA-256, identifying the exact deployed code). The admin dashboard and `status.json`
show them, and `dormeto-e2e` records them in its reports.

## Admin dashboard (feature flag)

With `admin_dashboard_enabled = true` (default in `dev`), the waker Lambda also serves a lightweight dashboard behind a
secret URL: state, time before nap, underlying resources (route, instance, target health), force nap and force awake.

```bash
terraform -chdir=terraform/dev output -raw admin_url          # open it in a browser
curl -sS "$(terraform -chdir=terraform/dev output -raw admin_url)status.json"
terraform -chdir=terraform/dev apply -replace='random_password.admin[0]'   # rotate the secret
```

The secret is also stored as the SSM SecureString `/dmt-<env>/admin-secret`, named in the workload configuration, so
that operators and `dormeto-e2e` can retrieve it with AWS credentials. The secret URL is the only protection: never share it. Disable the flag with `-var admin_dashboard_enabled=false`.
