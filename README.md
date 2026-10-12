<div align="center">

<a href="https://dormeto.com"><img src="https://dormeto.com/img/icon.svg" alt="Dormeto" width="96" height="96"></a>

# Dormeto router

[Website](https://dormeto.com) · [Get started](https://dormeto.com/get-started.html) · [Product](https://dormeto.com/product.html) · [Manager](https://github.com/Dormeto/manager)

</div>

Data plane of [Dormeto](https://dormeto.com) ("nap" in Esperanto): it puts idle web workloads to
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

**The manager's lists** (`ip_lists_catalog` on the `router` module, router 0.24.0): with a manager, the lists are
downloaded once by its list function, checked (a version that lost more than half its entries is refused) and published
to its bucket with a manifest each. Set `ip_lists_catalog` to the manager's output of the same name
(`s3://<bucket>/catalog.json`): the waker reads the catalog and the manifests every 5 minutes with conditional GETs, and a
list's data only when its version changes, checked against the manifest's SHA-256; nothing goes to the router table, and
the idle check plays no part. A list of `ip_lists` with the same name wins. Routers installed by the manager get the
catalog without any setting, and a change of the manager's `ip_lists` reaches them within 5 minutes.

**Failed wakes (router 0.25.0):** a failure says why — `capacity`, `quota`, `permission`, `configuration`, `unhealthy`
(the backends started, no target became healthy), `throttled`, `timeout` or `unknown` — with the backend and the AWS
message, on the run until a successful wake, in the `FAILED` event to the manager, and on the waiting page with the next
attempt. A failed Auto Scaling launch or an ECS task that cannot be placed is seen while the wake waits (every 30 s), not
at its timeout; no capacity is waited out, as Auto Scaling and ECS keep trying. An EC2 or RDS start refused for capacity
is tried again within the wake (30 s, 60 s, then every 120 s), and an EC2 instance may fall back to the next type of the
workload's `fallback_instance_types`, given back its own type after its next nap (or, if that nap failed, before its
next start); the controller may change only an instance's type, and only the `dormeto:instance-type` tag. Between failed
wakes, requests wait `failed_retry_seconds`, doubled after each consecutive failure, at most 30 minutes, also once the
workload is back to sleep with its failure. A failed workload whose backends run without a healthy target is stopped
once its idle window has passed (unless paused), so a failure never keeps paying.

**State history (router 0.26.0):** each state change dates the run (`stateAt`, in summaries and the status) with the
instant of its `Workload state changed` event, and an event of a nap or a wake asked from the manager says who (`by`).
The manager keeps the history from these events and fills a lost one from the next check (the same instant names the
same transition); the router keeps none.

**What a nap stops (router 0.27.0):** before stopping, a nap describes its backends by what prices them — EC2 instance
types and OS (an Auto Scaling group at its desired capacity), a Fargate service's task size × desired count, RDS and
Aurora classes, Aurora Serverless v2 at its minimum capacity — and the event of its end carries them (`stopped`) for the
manager's savings. A backend it cannot describe is said as unknown; the nap goes on. A Fargate size needs
`ecs:DescribeTaskDefinition`, in the router's role and DmtRouterBoundary. Since router 0.28.0 an item says what ran on
Spot (`spot: true`): an instance whose lifecycle is `spot` (alone or in an Auto Scaling group: on-demand and Spot
instances of one type are two items), and a Fargate service's share on `FARGATE_SPOT`, its desired count split by its
capacity provider strategy as ECS places tasks (the base first, then the weights); a share on EC2 capacity is not
counted. It reads what the nap already describes: no new permission. Since router 0.29.0 a Kubernetes workload's pods
are described too: on Fargate as a Fargate item per size (the size in the pod's `CapacityProvisioned` annotation, else
its requests plus 256 MB for the Kubernetes components, rounded up to a Fargate size), on EC2 nodes as a `k8s-pods` item
(replicas, each pod's CPU and memory requests, its node's instance type, operating system, allocatable and capacity type,
and whether a node autoscaler removes the nodes they free: Karpenter's labels, or the configuration's `autoscaler`). Pods
without requests are said as unknown.

**Kubernetes on EKS (router 0.29.0):** a workload whose application target group serves the pods of one Deployment or
StatefulSet of an EKS cluster, behind an ALB of the AWS Load Balancer Controller (from an Ingress or a
TargetGroupBinding), is napped by scaling its owner to 0 through the `scale` subresource once its pods are drained, and
woken by giving back its recorded replicas (at least 1). A KEDA ScaledObject is paused at 0
(`autoscaling.keda.sh/paused-replicas: "0"`) for the nap and given back its own pause at the wake; an HPA needs nothing
(it leaves a target at 0 replicas alone). The router calls the cluster's API over HTTPS with an EKS token its role
signs and the certificate authority from `eks:DescribeCluster` (no Kubernetes library in the bundles); the endpoint must
be public and open to every address (a private cluster waits for the in-cluster agent, R10.6). The configuration's
`kubernetes` (written by the onboarding) names the cluster, namespace, owner, the switching mode and, for an Ingress,
its name and the Service it routes to; Kubernetes workloads come from the manager's onboarding (the `workload` module
has no Kubernetes setting). Their wake timeout defaults to 300 s (pods may wait for a node).

The controller deletes the listener rules it does not own, so the switch lives in the objects it reads:

- **TargetGroupBinding** (`rule`): the rules belong to the customer, instrumented as any other rule (shadow rules,
  weights).
- **An Ingress in an IngressGroup** (`ingress`): the onboarding adds Dormeto's Ingress `dormeto-<workload id>` (label
  `dormeto.com/managed`) to the group in the workload's namespace, ranked just before the customer's
  (`group.order`), with the customer rule's host, path, conditions and `listen-ports` and its target group annotations
  (health check, success codes, thresholds, protocol, target type, attributes), forwarding by `actions.dormeto` to the
  Service with the application's weight and to the waker target group with the waker's. It carries no tag nor any
  annotation the controller applies to the whole group. The controller gives that Ingress its own target group: while
  Dormeto's rule is there, its target group takes the workload's requests, so the idle check counts both target groups,
  the wake waits for a healthy target in Dormeto's, and the status names the one serving (`servingTargetGroupArn`). The
  customer's Ingress is never changed.
- **An Ingress outside any group** (`patched-ingress`): it owns its ALB, so Dormeto patches it (its rule's backend
  becomes the same weighted `actions.dormeto`) and offboarding restores it exactly. GitOps owners need to ignore that
  annotation (the onboarding dialog gives the snippet).

The rule the controller makes for Dormeto's Ingress has no `dormeto:workload` tag: the router finds it by its forward to
the waker target group. After each switch the router waits until the load balancer's rule shows the weights (120 s,
else a `configuration` failure quoting the Ingress's Warning Events); a nap whose switch does not show is aborted and the
workload stays awake (cause `switch-failed`). Wake failures: pods unschedulable (`FailedScheduling`) are `capacity` and
waited out, image pulls and crash loops `configuration`, a 401 or 403 from the cluster `permission`, an unreachable
cluster or a 5xx the new class `cluster`, each quoting the pods' latest Warning Events. Kubernetes changes do not reach
CloudTrail: the idle check finds the replicas set while asleep (GitOps self-heal: a drift event, not a visitor's wake)
and Dormeto's Ingress or the patch changed or removed, applies the switch again and records the drift.

**Access to a cluster:** the router's controller, waker and onboarder roles have EKS access entries in the Kubernetes
group `dormeto:router`, made by the manager when it installs or upgrades the router (`DmtCommandRole`'s statement
`EksAccessEntries`) or by the `eks-access` module (`terraform/modules/eks-access`), which also gives `DmtDiscoveryRole`
the read-only `AmazonEKSViewPolicy`. The group's rights are in [`kubernetes/dormeto-router.yaml`](kubernetes/dormeto-router.yaml),
supposed to be applied (`kubectl apply -f`, or by the module with the `kubernetes` provider): a ClusterRole with exactly
the rights the router checks (read Deployments, StatefulSets, ReplicaSets, Pods, Services, Events, Ingresses, HPAs and
ScaledObjects; get Nodes; scale Deployments and StatefulSets; patch ScaledObjects; create, patch and delete Ingresses),
its binding, and a ValidatingAdmissionPolicy (Kubernetes 1.30 or later) refusing the group's create and delete of an
Ingress without the `dormeto.com/managed` label, and any change of the group adding or removing that label. A cluster on `aws-auth` only (`CONFIG_MAP`) needs the roles mapped by
hand or a switch to `API_AND_CONFIG_MAP`. The controller's `clusterCheck` action asks the cluster what the router may do
(`SelfSubjectRulesReview`, then a `SelfSubjectAccessReview` per right an incomplete review does not list) and names
what is missing; the onboarding refuses a workload until nothing is.

```bash
kubectl apply -f kubernetes/dormeto-router.yaml
aws lambda invoke --function-name dmt-dev-controller --cli-binary-format raw-in-base64-out --payload '{"action":"clusterCheck","cluster":"eks-demo","namespace":"demo"}' /dev/stdout
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

Health also warns when the account's Lambda concurrency limit in the region (10 in a region the account barely uses)
is below the largest `maxHolders` plus 10: held requests beyond it get errors until a quota increase.

**Onboarding** (`<router>-onboarder`, invoked by the manager): `preview`, `onboard` and `offboard` a workload from its
application target group, with their own role (the controller keeps its least privilege). The workload id is derived
from the target group (16 hexadecimal characters of the SHA-256 of its ARN: `printf %s <arn> | shasum -a 256 | cut -c1-16`);
people see its name, the target group name unless given at onboarding, changed with the controller's `rename` (the
`workload` module's `name` for Terraform workloads). One permission per router (`dormeto-alb`) lets the load balancers
invoke the waker from its target groups `<router>-*`, so router names have at most 15 characters. Upgrading to 0.20:
the router's permission is created first; the per-workload `alb-<id>` statements of earlier versions stay (offboarding
removes those of manager workloads; the `workload` module only forgets its own, remove them by hand if wanted). Onboarding tags the backends
`dormeto:workload` (with the marker `dormeto:tagged = onboarder`), creates and registers the waker target group, writes
the configuration and covers every rule forwarding to the target group; each step finds what exists first, and a failed
onboarding of a new workload is undone. Offboarding (the workload awake) removes only what onboarding added: shadows,
rules back to a plain forward, waker target group, permission, the tags carrying the marker, the configuration. A
workload written by the `workload` module is refused (remove the module instead).

**Shadow rules:** a customer rule is covered by a Dormeto rule just before it on its listener (same conditions, weighted
forward, tags `dormeto:workload` and `dormeto:shadows = <rule ARN>`), so the customer's rule and its infrastructure as
code stay untouched. A shadow only passes over the workload's own rules and rules no request of the customer rule can
match (other literal host headers): never an authentication, a redirect or another target group that could take those
requests. A rule with an action before its forward or a rewrite, or with no free priority, is instrumented in place; a
rule forwarding to other target groups too (blue/green) is left alone (an issue). ELB changes a rule that authenticates
with Amazon Cognito only for whoever may read its user pool client: the controller and the onboarder may, on the user
pools of their account and region (0.23.1; installed routers need the `DmtRouterBoundary` of that release). **Drift:** CloudTrail events on rules,
target groups and `dormeto:workload` tags (any caller but the router's roles, successful calls only) invoke the
onboarder, which repairs the workloads they concern; the idle check asks for a repair when it finds one to make. Each
repair is a drift event (90 days) in the workload status and the router health.

```bash
aws lambda invoke --function-name dmt-dev-onboarder --cli-binary-format raw-in-base64-out --payload '{"action":"preview","workloadId":"onb","targetGroupArn":"<arn>"}' /dev/stdout
```

**Events to the manager** (router 0.21.0, `manager_event_bus_arn` or the blueprint's `${managerBus}`): after each idle
check, the controller sends the router's state (identity, health, pauses, counts, workload summaries, in entries under
64 KB) to the manager's event bus; the controller and the waker send each workload state change as it happens. The idle
check also stores the router's health (Lambda errors and throttles, failure queues, concurrency limit, measured at most
every 15 minutes): the `router` action reads it instead of calling CloudWatch. Publishing never fails the work behind it.

**Installed by the manager:** `npm run package` writes `dist/router-<version>.zip`, `dist/blueprint-<version>.json`
(every resource and IAM policy of a router, placeholders filled by the installer) and `dist/router-boundary.json`
(`DmtRouterBoundary`). The manager installs, upgrades and removes routers from them by API calls (no Terraform or
CloudFormation); `lambda/test/blueprint.test.mjs` keeps the blueprint's IAM actions equal to this module's. Since 0.23.0
the blueprint also describes the **forwarder** of event-driven discovery refresh (one role per account,
`dmtr-<env>-forwarder`, and one rule per region, `dmtr-<env>-discovery`): the load balancer changes discovery reads
(`install/forward-pattern.json`, never target registrations nor Dormeto's own calls, `${commandRole}` included), sent
to the manager's bus.
`terraform/dev-paris` is a customer-style application in eu-west-3 used to test that path (about 18 USD a month).

The `dev` environment has four workloads: `demo` (one EC2 instance, `https://dev.dormeto.com/`), `demo-asg` (an Auto
Scaling group, `https://asg.dev.dormeto.com/`), `demo-ecs` (an ECS Fargate service in browser wake mode, `https://ecs.dev.dormeto.com/`) and
`demo-rds` (an ECS Fargate service with a PostgreSQL instance, `https://rds.dev.dormeto.com/`).

Design: `docs/specs/2026-10-03-mvp-alb-ec2-design.md` in the Dormeto/vision repository (private).

## Layout

| Path | Content |
|---|---|
| `lambda/src` | Lambda code (Node.js 24, no bundled dependency) |
| `lambda/test` | Unit tests (`node --test`) |
| `terraform/modules/router` | DynamoDB table, Lambdas, IAM, idle check schedule |
| `terraform/modules/workload` | Waker target group and workload configuration |
| `terraform/dev` | `dev` environment: demo VPC, ALB, EC2 on `dev.dormeto.com`, router wiring |
| `scripts/e2e.sh` | End-to-end acceptance against `dev` |
| `kubernetes/dormeto-router.yaml` | The rights of the group `dormeto:router` in an EKS cluster (ClusterRole, binding, admission policy) |
| `terraform/modules/eks-access` | The router roles' access entries, `DmtDiscoveryRole`'s view policy, the manifest |
| `terraform/dev-eks` | `dev-eks`: an EKS cluster written as a customer would, with six demo workloads (about 155 USD a month while it exists) |
| `lambda/test-k8s`, `scripts/kind-*.sh` | Kubernetes integration tests in kind (podman by default) |

## Usage

Requirements: Node.js ≥ 24, Terraform 1.16.5 (tfenv reads `.terraform-version`), AWS CLI v2, profile
`kloudy-dormeto-prd`.

```bash
npm test                                   # unit tests
npm run test:k8s                           # Kubernetes integration tests in kind on podman (KIND_EXPERIMENTAL_PROVIDER=docker for Docker; scripts/kind-down.sh after)
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
