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
  timeout 5 s).
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
  actions (the map's and its path matchers'), which the measuring tool (and later Dormeto) switches, as a default
  service or with weights. The autoscaler ignores its mode, which a managed group's stop turns off.
- **No IAM, no API**: every IAM change and every API turned on in the project go through `dormeto gcp install` or
  `uninstall`. This root holds no `google_*_iam_*` resource, no service account and no `google_project_service`, and its
  VMs and template run without a service account (attaching one is an IAM grant); `gcp/test/gcp-dev.test.mjs` checks
  it. It needs the `compute` and `monitoring` APIs, which `dormeto gcp install --project dormeto-dev --region
  europe-west1` turns on.
- **Cost** while it exists, at list prices: about $0.11 an hour, $80 a month: the three `e2-small` VMs about $40 a
  month while running, their 10 GB balanced disks $3 (also while stopped; a suspended VM also pays for its memory's
  storage), the two forwarding rules (global and regional) $36; health checks, the certificate and the Route 53
  records nothing of note. Created for G0's measures and destroyed after.

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
   - with the app's service `healthy` at the update, there is no such gap.

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
   after (what the standby pool keeps).

   ```
   node gcp/tools/measure.mjs mig stop     # then mig start
   node gcp/tools/measure.mjs mig suspend  # then mig resume
   ```

5. **The health check at the lowest interval**: plan and apply with `-var health_check_interval=1` (the timeout follows
   it), then 2 to 4 again; back to the default after.

6. **`request_count` in Cloud Monitoring**: 20 requests, then the metric read every 10 s until its points count them:
   the delay, and the series' exact metric and resource labels. For the regional load balancer, its own metric:

   ```
   node gcp/tools/measure.mjs metric
   node gcp/tools/measure.mjs metric --url http://regional.gcp.dev.dormeto.com/ \
     --metric loadbalancing.googleapis.com/https/external/regional/request_count
   ```

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
   back. The regional load balancer's services work the same way, with `--region europe-west1` (and `--url-map
   dmt-dev-regional --url http://regional.gcp.dev.dormeto.com/` for its switch).

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

Stopped, suspended or switched, everything goes. What `dormeto gcp install` made (the APIs, the roles, the service
account, the tag) stays until `dormeto gcp uninstall`.
