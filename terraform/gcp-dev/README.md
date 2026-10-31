# gcp-dev

G0's demo workloads in the Google Cloud project `dormeto-dev` (vision `docs/specs/2026-10-29-google-cloud-design.md`,
section 12): web VMs behind a global and a regional external Application Load Balancer, written as a customer would,
with no Dormeto resource. `gcp/tools/measure.mjs` measures them: how fast a URL map switch takes effect, how fast
stopped or suspended VMs come back healthy, Cloud Monitoring's request count delay, and whether Google health checks a
backend service out of service.

- **What it holds** (project `dormeto-dev`, region `europe-west1`, zone `europe-west1-b`): the VPC `dmt-dev` (subnet
  `10.10.0.0/24`, proxy-only subnet `dmt-dev-proxy` `10.10.1.0/24`), the firewall rule `dmt-dev-demo` (Google's front
  ends and health checkers, `35.191.0.0/16` and `130.211.0.0/22`, and the proxy-only subnet, to TCP 80 and 8080 of the
  VMs tagged `dmt-demo`); the VM `dmt-demo` (`e2-small`, Debian 12, no external address) in the unmanaged instance
  group `dmt-demo` (named ports `app` 80, `standin` 8080); the managed group `dmt-demo-mig` (zonal, two VMs from a
  template, autoscaler 2 to 3 on CPU); the health check `dmt-demo` (HTTP 80 `/`, every 5 s, 2 healthy and 2 unhealthy,
  timeout 5 s). Every backend service drains connections for 30 s, the router's drain, instead of Google's 300 s.
- **Each VM** answers on 80 a page "Dormeto demo: app" and on 8080 "Dormeto demo: stand-in" (the stand-in for
  Dormeto's waker), with its name and boot time (`startup.sh`). Compute Engine runs the startup script at every boot,
  not after a resume: a resumed VM shows the boot time it had, a started one a new one.
- **The global external Application Load Balancer** (`EXTERNAL_MANAGED`): the backend services `dmt-demo-app`,
  `dmt-demo-standin` (the VM's two ports) and `dmt-demo-mig-app`; the URL map `dmt-dev`, `gcp.dev.dormeto.com` to
  `dmt-demo-app` and `mig.gcp.dev.dormeto.com` to `dmt-demo-mig-app`; a Google-managed certificate for both names, the
  HTTPS proxy, the address and the forwarding rule `dmt-dev` (443); the Route 53 records in `dormeto.com`.
- **The regional external Application Load Balancer** (HTTP, Standard tier): `http://regional.gcp.dev.dormeto.com/`,
  the URL map `dmt-dev-regional` to the backend services `dmt-demo-regional-app` and `dmt-demo-regional-standin`, with
  their regional health check `dmt-demo-regional`. They use the same unmanaged group as the global ones: Compute Engine
  lets one instance group serve several backend services, global or regional, when their balancing modes are
  compatible ("The same instance group can be used by two or more backend services", Google's
  [backend services overview](https://cloud.google.com/load-balancing/docs/backend-service#restrictions_and_guidance_for_instance_groups);
  every backend here balances by `UTILIZATION`). A VM can be in one load-balanced instance group only, so a second
  group of the same VM is not an option: if Compute Engine refuses the shared group at the apply, the regional backend
  services move to the managed group.
- **The switched services are Dormeto's**: the URL maps ignore changes to their default services and default route
  actions, which the measuring tool switches, as a default service or with weights. The global map also ignores its host
  rules, its path matchers and its error response policy, which the router writes (the scenario page's advice): a later
  edit of a path matcher takes removing the ignore for that apply. The regional map ignores its host rules and path
  matchers too, and so do the optional maps. The autoscaler ignores its mode, which a managed
  group's stop turns off.
- **Optional parts** (`classic.tf`, `neg.tf`, `sql.tf`, `gke.tf`, `gke-demo.yaml`), off by default: see Optional parts below.
- **No IAM, no API**: every IAM change and every API turned on in the project go through `dormeto gcp install` or
  `uninstall`. This root holds no `google_*_iam_*` resource, no service account and no `google_project_service`, and its
  VMs and template run without a service account (attaching one is an IAM grant); `gcp/test/gcp-dev.test.mjs` checks
  it. It needs the `compute` and `monitoring` APIs, which `dormeto gcp install --project dormeto-dev --region
  europe-west1` turns on.
- **Cost** while it exists, at list prices: about $0.11 an hour, $80 a month: the three `e2-small` VMs about $40 a
  month while running, their 10 GB balanced disks $3 (also while stopped; a suspended VM also pays for its memory's
  storage), the two forwarding rules (global and regional) $36; health checks, the certificate and the Route 53
  records nothing of note. Created for G0's measures and destroyed after.

## Optional parts

Four variables, `false` by default: a plan with the defaults shows no change (nothing above is renamed or moved, and
`gcp/test/gcp-dev.test.mjs` checks that each variable defaults to false and that every resource of the optional files
is behind its own). They cost money while they exist, so they are turned on for the measures of the Google Cloud
coverage (vision `docs/specs/2026-10-30-google-cloud-coverage-design.md`, sections 10 and 11) and for its acceptance, on
the user's "run it", and off after (`-var enable_x=true` for the plan; destroy the part by planning without it). None of
them holds an IAM resource or a `service_account`; read the project's IAM policy after each apply, as Google may add a
binding for a resource it makes (a service agent's).

| Variable | Adds | About, per month (list prices) |
|---|---|---|
| `enable_classic` | `classic.tf`: a classic external Application Load Balancer (`EXTERNAL`, HTTP on port 80, no certificate) on the demo group: the backend services `dmt-demo-classic-app` and `dmt-demo-classic-standin`, the URL map `dmt-dev-classic`, its HTTP proxy, address and forwarding rule | $18 (the forwarding rule) |
| `enable_neg` | `neg.tf`: the VM `dmt-demo-neg` (`var.machine_type`, no service account), the zonal `GCE_VM_IP_PORT` NEG `dmt-demo-neg` holding it, the `EXTERNAL_MANAGED` backend service `dmt-demo-neg` on it, and a global load balancer of its own: the URL map `dmt-dev-neg`, an HTTP proxy, an address and a forwarding rule on port 80 | $32: the VM $13, its disk $1, the forwarding rule $18 |
| `enable_sql` | `sql.tf`: the PostgreSQL 16 instance `dmt-demo-sql`, `db-f1-micro`, 10 GB on a hard disk, `deletion_protection = false`, a public address and no authorized network (no connection can be made; no user, no database) | $12 (Cloud SQL keeps a deleted instance's name for about a week) |
| `enable_gke` | `gke.tf`: the zonal Standard cluster `dmt-demo-gke` (its own subnet `dmt-dev-gke`, the DNS endpoint on and reachable from outside, Gateway API standard channel, `deletion_protection = false`), one node pool of one `e2-small` node on the default compute service account, a firewall rule for Google's health checkers to the pods' port 8080, and a global load balancer for the Service's NEG: the backend service `dmt-demo-gke`, its health check, the URL map `dmt-dev-gke`, an HTTP proxy, an address and a forwarding rule on port 80 | $32: the node $13, its disk $1, the forwarding rule $18; the cluster's fee ($73) is within the free tier of one zonal cluster per billing account, if this account's is unused. The Gateway of `gke-demo.yaml` makes GKE create another forwarding rule, about $18 more while it exists: delete the Gateway and the HTTPRoute right after M10 |

**Needs first.** `enable_sql` and `enable_gke` need the `sqladmin` and `container` APIs, which this root does not turn on
(no `google_project_service`, by design): `dormeto gcp install --with cloud-sql,gke` does, and **not in `europe-west1`
before 2026-11-02**. The probe's Cloud Run job (below) needs a router image holding `probe.mjs`: one built and pushed
for the measures (`scripts/gcp-image.sh <version> --push <repository>`).

The NEG VM and the GKE load balancer have no domain name, and the root has no output for them (an output the defaults do
not store would show in a plan): read an address with `gcloud compute addresses describe dmt-dev-neg --global
--format='value(address)' --configuration=dormeto-dev` (`dmt-dev-classic`, `dmt-dev-gke` the same), and give the measuring tool
`--url http://<address>/`. The demo VM still belongs to one workload at a time (G1's rule):
the global, regional and classic load balancers share its group, so the acceptance offboards between them, and a nap on
one takes the others' backends down meanwhile. If Compute Engine refuses the group as the backend of both an `EXTERNAL`
and an `EXTERNAL_MANAGED` service at the apply, the classic backend services move to the managed group.

**The GKE demo's workload is not Terraform**: `gke-demo.yaml` holds the Deployment `dmt-demo-gke` (Google's hello-app,
8080), the Service with the annotation `cloud.google.com/neg` (a standalone NEG named `dmt-demo-gke`), a Gateway and its
HTTPRoute (the Gateway's load balancer is GKE's own: M10 writes a policy on its URL map). The measure applies it, on the
user's "run it", with the owner's own rights (the project owner is cluster-admin through IAM, the DNS endpoint and
`gcloud container clusters get-credentials`): no Role or binding is written for it, the router's RBAC is the CLI's
(`dormeto gcp workloads access`). Then the NEG is attached to the backend service, by `gcloud` with the `dormeto-dev`
configuration (no IAM):

```
gcloud container clusters get-credentials dmt-demo-gke --zone europe-west1-b --dns-endpoint --configuration=dormeto-dev
kubectl apply -f terraform/gcp-dev/gke-demo.yaml
gcloud compute backend-services add-backend dmt-demo-gke --global --network-endpoint-group=dmt-demo-gke \
  --network-endpoint-group-zone=europe-west1-b --balancing-mode=RATE --max-rate-per-endpoint=100 --configuration=dormeto-dev
```

(The backend service ignores its `backend` in Terraform, so a later plan does not remove the NEG.)

**Teardown, in this order**: Google refuses to delete a NEG a backend service still uses, and the NEG was attached by
hand. (1) Detach it: `gcloud compute backend-services remove-backend dmt-demo-gke --global --network-endpoint-group=dmt-demo-gke
--network-endpoint-group-zone=europe-west1-b --configuration=dormeto-dev`. (2) Delete the manifest: `kubectl delete -f
terraform/gcp-dev/gke-demo.yaml` (the Service's NEG and the Gateway's load balancer go with it). (3) `plan -out` with
`enable_gke` off, read it, apply the saved plan. Terraform has no dependency between the cluster and the backend service, so
they are destroyed in parallel: a cluster deleted while the Service still exists leaves its NEG behind, and the NEG then
blocks nothing but stays and costs nothing much; check `gcloud compute network-endpoint-groups list
--configuration=dormeto-dev` after the apply and delete a leftover `dmt-demo-gke` by hand.

### Measure the optional parts

```
addr() { gcloud compute addresses describe "$1" --global --format='value(address)' --configuration=dormeto-dev; }
# S3: a stopped VM in a NEG keeps its endpoint? (M1)
node gcp/tools/measure.mjs neg stop  --url "http://$(addr dmt-dev-neg)/"
node gcp/tools/measure.mjs neg start --url "http://$(addr dmt-dev-neg)/"
# S4: the classic map's switch (M2), health of a service in no map (M3), the classic request count (M5)
node gcp/tools/measure.mjs switch --url-map dmt-dev-classic --url "http://$(addr dmt-dev-classic)/" \
  --from dmt-demo-classic-standin --to dmt-demo-classic-app
node gcp/tools/measure.mjs health --backend-service dmt-demo-classic-app --for 120
node gcp/tools/measure.mjs metric --url-map dmt-dev-classic --url "http://$(addr dmt-dev-classic)/" \
  --metric loadbalancing.googleapis.com/https/request_count
# The regional request count (M5): its URL map as the metric labels it
number="$(gcloud projects describe dormeto-dev --format='value(projectNumber)' --configuration=dormeto-dev)"
node gcp/tools/measure.mjs metric --url-map "URL_MAP/${number}_dmt-dev-regional" --url http://regional.gcp.dev.dormeto.com/ \
  --metric loadbalancing.googleapis.com/https/external/regional/request_count
# S5: Cloud SQL stopped and started by its activation policy, until its operation is done; state and policy read every 10 s (M6)
node gcp/tools/measure.mjs sql stop
node gcp/tools/measure.mjs sql start
# S6: the Deployment scaled to 0 and back through the cluster's DNS endpoint, as the owner (M9)
node gcp/tools/measure.mjs gke scale --replicas 0 --url "http://$(addr dmt-dev-gke)/"
node gcp/tools/measure.mjs gke scale --replicas 1 --url "http://$(addr dmt-dev-gke)/"
```

Each prints a timeline like the others. `metric`'s `series` line prints every resource label as Google gives it, whose
`backend_target_name` M5 reports, regional and classic (the classic one's `url_map_name` is presumed its plain name: a run
with no series means it reads otherwise). `neg` adds the NEG's endpoints (kept or dropped while the VM is stopped);
`sql` follows the operation the PATCH returns until it is `DONE`, whose end is the time, and prints `state` and
`settings.activationPolicy` on each sample: Google documents `RUNNABLE` as "running, or has been stopped by owner" and
`SUSPENDED` as unavailable for billing and the like, so no state tells a stop; `gke scale` reads
the cluster's DNS endpoint from the Container API, reads and puts the Deployment's scale through it with gcloud's token,
and follows the pods, the NEG's endpoints, the backend service's health and the answers.

### Acting as the router (M7, M11)

The owner would bypass a condition or an RBAC rule, so these two calls are made as the router's service account:
`gcp/tools/probe.mjs` is in the router's image and makes one call with the account's token from the metadata server,
printing the status and the body. It runs as a Cloud Run job with `--service-account dmtr-<region>@dormeto-dev.iam.gserviceaccount.com`
(the owner can act as that account: no IAM change, nothing granted; if Google refuses, the measure waits for the
code of S5 or S6 on a workload). What the router holds comes from `dormeto gcp install --with cloud-sql,gke` and its RBAC
from the CLI's onboarding step; nothing is applied by hand.

```
gcloud run jobs deploy dmt-probe --configuration=dormeto-dev --region europe-west1 \
  --image europe-west1-docker.pkg.dev/dormeto-dev/dormeto/router:<version> \
  --service-account dmtr-europe-west1@dormeto-dev.iam.gserviceaccount.com --max-retries 0 \
  --args=gcp/tools/probe.mjs,GET,https://<the cluster's DNS endpoint>/apis/apps/v1/namespaces/default/deployments/dmt-demo-gke/scale
gcloud run jobs execute dmt-probe --configuration=dormeto-dev --region europe-west1 --wait
gcloud run jobs delete dmt-probe --configuration=dormeto-dev --region europe-west1
```

The job's log (Cloud Logging, `gcloud run jobs executions` with `--configuration=dormeto-dev`) holds the status line and the
body. For a call with a JSON body, give the arguments with another delimiter, `--args=^@^gcp/tools/probe.mjs@PUT@https://…@{"spec":{"replicas":0}}`.
Delete the job after (`jobs deploy` again for the next call).

**Needs** gcloud's configuration `dormeto-dev` signed in as the project's owner (spec section 15), and the AWS profile
`kloudy-dormeto-prd` (state, Route 53). Google's credentials are never in the code or a file: each command takes
gcloud's token from the environment, with at least 30 minutes left (`--min-expiry=30m` refreshes one closer to its
expiry; `gcloud auth print-access-token` refreshes only within 5 minutes of it, so its token may not outlast an apply).
The state is in the S3 bucket, key `router/gcp-dev.tfstate`.

```
cd terraform/gcp-dev
tfenv exec init
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud config config-helper --min-expiry=30m --format='value(credential.access_token)' --configuration dormeto-dev)" tfenv exec plan -out gcp-dev.tfplan   # read it
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud config config-helper --min-expiry=30m --format='value(credential.access_token)' --configuration dormeto-dev)" tfenv exec apply gcp-dev.tfplan       # the user's go-ahead
```

The certificate becomes active 15 to 60 minutes after the records resolve (`gcloud compute ssl-certificates describe
dmt-dev --global --configuration dormeto-dev`); until then `https://gcp.dev.dormeto.com/` fails its TLS handshake. The
regional load balancer, HTTP, needs no certificate.

## Measure

From the router's root, with Node 24 and gcloud's `dormeto-dev` configuration: the tool asks `gcloud config
config-helper --min-expiry=20m` for a token and its expiry, asks again 5 minutes before it expires, and after a 401 asks
for a forced refresh and sends the request once more. Each command prints a timeline, one line per event,
`<seconds since start>s  <what>  <value>`, then its summary, and exits 0 when it saw the end, 1 on a timeout or a
refusal, 2 on a bad flag. Run each several times (G0: five). `--help` lists every option.

1. **The URL map switch** (every 250 ms, a new connection each): from the update's end to the first answer from the
   new backend service, the last from the old one, and 20 new ones in a row; with both backend services' health
   (every 2 s) as it changes: `no status`, `unhealthy`, `healthy`.

   ```
   node gcp/tools/measure.mjs switch --from dmt-demo-app --to dmt-demo-standin
   node gcp/tools/measure.mjs switch --from dmt-demo-standin --to dmt-demo-app
   node gcp/tools/measure.mjs switch --region europe-west1 --url-map dmt-dev-regional --url http://regional.gcp.dev.dormeto.com/ \
     --from dmt-demo-regional-app --to dmt-demo-regional-standin
   ```

   The wake direction (stand-in to app) is the decisive one: it is the switch the route grace covers, to a backend
   service of instance groups as a customer's is. The other direction says little of the router: its target, the
   waker's serverless NEG, has no health check, unlike the stand-in here. Google health checks only a backend service
   that a forwarding rule reaches through a URL map (measurement 7), so the app's service may have `no status` at the
   update. Then read the timeline this way:
   - the propagation ends with the last old answer (no front end sends to the stand-in any more);
   - the `http 503` answers until the app's health line turns `healthy` are its health check's warm-up: 2 checks, 5 s
     apart at the default;
   - with the app's service already `healthy` at the update, a 503 gap is not its warm-up.

   If neither (a) nor (b) of measurement 7 keeps the app's service health checked, the route grace must cover that
   warm-up as well as the propagation.

2. **A stopped VM started** and **3. a suspended VM resumed** (the load balancer every 500 ms, the VM's status every
   second, the backend service's health every 2 s): running, healthy, first answer from the app, and whether the VM is
   still in its unmanaged group; the boot time tells a boot from a resume.

   ```
   node gcp/tools/measure.mjs vm stop      # then vm start
   node gcp/tools/measure.mjs vm suspend   # then vm resume
   ```

4. **The managed group's VMs**, through the group: its autoscaler turned off before a stop or suspend and back on
   (`--autoscaler-mode`, default `ON`) after a start or resume, as the router will; the group's target sizes before and
   after (what the standby pool keeps). A group behind a backend service with connection draining stops or suspends its
   VMs "up to 60 seconds after the connection draining duration has elapsed" (Compute Engine's `stopInstances` and
   `suspendInstances`). So the 30 s set here is in the measure, and a customer's draining (300 s unless they set it)
   delays a managed group's nap by that much.

   ```
   node gcp/tools/measure.mjs mig stop     # then mig start
   node gcp/tools/measure.mjs mig suspend  # then mig resume
   ```

5. **The health check at the lowest interval**: plan and apply with `-var health_check_interval=1` (the timeout follows
   it), then 2 to 4 again; back to the default after.

6. **`request_count` in Cloud Monitoring**: the URL map's series read (`resource.labels.url_map_name`, `--url-map`,
   default `dmt-dev`), 20 requests, then the metric read every 10 s until its points count them: the delay, and the
   series' exact metric and resource labels. Only what a point adds to the points published before the requests
   counts; a point covers a minute, so other traffic in the requests' minute would count, and nothing else should
   probe the load balancer meanwhile. For the regional load balancer, its own metric, and its URL map as that metric
   labels it, `URL_MAP/<project number>_<name>` (G0: its plain name matches nothing):

   ```
   node gcp/tools/measure.mjs metric
   number="$(gcloud projects describe dormeto-dev --format='value(projectNumber)' --configuration=dormeto-dev)"
   node gcp/tools/measure.mjs metric --url-map "URL_MAP/${number}_dmt-dev-regional" --url http://regional.gcp.dev.dormeto.com/ \
     --metric loadbalancing.googleapis.com/https/external/regional/request_count
   ```

   M5 reads `backend_target_name`'s real form, regional and classic, in the timeline's `series` line, which prints every
   resource label as Google gives it: so don't `--filter` on that label before reading it.

7. **The health of a backend service out of service** (the nap): `health` reads a backend service's health every 2 s
   for `--for` seconds and prints each change, per instance and for the service, then how long each state lasted;
   `no status` means Google does not health check it. Two cases: (a) the service named in no URL map, after a plain
   switch; (b) the service at weight 0 in a weighted route, after `switch --weighted`. That switch writes the map's and
   its path matcher's `defaultRouteAction.weightedBackendServices`, `--to` at 1000 and `--from` at 0, in place of
   their `defaultService` (Google allows only one of the two). A switch without `--weighted` writes `defaultService`
   again and clears the weights.

   ```
   # (a) dmt-demo-app in no URL map
   node gcp/tools/measure.mjs switch --from dmt-demo-app --to dmt-demo-standin
   node gcp/tools/measure.mjs health --backend-service dmt-demo-app --for 120
   node gcp/tools/measure.mjs switch --from dmt-demo-standin --to dmt-demo-app
   # (b) dmt-demo-app at weight 0
   node gcp/tools/measure.mjs switch --weighted --from dmt-demo-app --to dmt-demo-standin
   node gcp/tools/measure.mjs health --backend-service dmt-demo-app --for 120
   node gcp/tools/measure.mjs switch --weighted --from dmt-demo-standin --to dmt-demo-app
   ```

   The last switch is the weighted wake: if (a) has no status and (b) has one, the router writes weights, and this is
   the switch to time five times, as in 1. The map then stays weighted (the app at 1000), which Terraform ignores. To
   get a default service back, run a plain switch from it, `switch --from dmt-demo-app --to dmt-demo-standin`, then
   back. The regional load balancer works the same way: `--region europe-west1`, the services `dmt-demo-regional-app`
   and `dmt-demo-regional-standin`, and for its switches `--url-map dmt-dev-regional --url
   http://regional.gcp.dev.dormeto.com/`.

The timeline of a wake's switch could read like this (illustrative numbers). The app's service was out of the URL map,
so it had no status at the update. The propagation ended at +10.9 s with the last stand-in answer. The 503s until
+19.2 s were the app's health check warm-up:

```
0.0s  start  switch 2026-10-30T09:00:00.000Z dormeto-dev
0.4s  url map  dmt-dev: dmt-demo-standin (stand-in) to dmt-demo-app (app), at defaultService, pathMatchers[0].defaultService
0.5s  answer  stand-in dmt-demo
0.6s  health  dmt-demo-app no status
0.6s  health  dmt-demo-standin healthy
5.4s  update  sent: dmt-demo-app at 2 references
9.9s  update  done, +4.5s after it was sent
18.3s  answer  http 503
18.6s  health  dmt-demo-app unhealthy
...
28.6s  health  dmt-demo-app healthy
29.1s  answer  app dmt-demo
...
5.4s  health  when the update was sent: dmt-demo-standin healthy, dmt-demo-app no status
18.6s  health  dmt-demo-app unhealthy, +8.7s after the update
20.8s  last old  stand-in, +10.9s after the update
28.6s  health  dmt-demo-app healthy, +18.7s after the update
29.1s  first new  app, +19.2s after the update
29.1s  settled  20 app in a row from +19.2s after the update
```

## Destroy

```
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud config config-helper --min-expiry=30m --format='value(credential.access_token)' --configuration dormeto-dev)" tfenv exec plan -destroy -out gcp-dev.tfplan
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud config config-helper --min-expiry=30m --format='value(credential.access_token)' --configuration dormeto-dev)" tfenv exec apply gcp-dev.tfplan
```

Stopped, suspended or switched (plainly or with weights), everything goes: the URL maps depend on all their backend
services, so the destroy deletes them first, whichever service they name. What `dormeto gcp install` made (the APIs,
the roles, the service account, the tag) stays until `dormeto gcp uninstall`.
