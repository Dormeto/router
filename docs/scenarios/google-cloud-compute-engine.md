# Google Cloud: Compute Engine VMs

Compute Engine VMs in unmanaged instance groups, or managed instance groups (zonal or regional), behind a backend
service of a **global external Application Load Balancer** (`EXTERNAL_MANAGED`). The nap suspends or stops them, the
wake starts or resumes the ones it napped. The router runs in your project as two Cloud Run services, and
`dormeto gcp install` puts it there (router 0.34.0).

```mermaid
flowchart LR
  V(["Visitor"]) --> UM{"URL map<br/>custom error response<br/>while asleep"}
  UM -->|"awake: path matchers"| BS["Application backend service"]
  UM -.->|"asleep: 502, 503 served from<br/>/_dormeto/waiting"| WBS["Workload's waker<br/>backend service"]
  UM -->|"/_dormeto/* for good"| WBS
  BS --> G1["Instance group<br/>VMs tagged dormeto=managed"]
  WBS --> NEG["Serverless NEG<br/>dmtr-region-waker"]
  NEG --> W["Waker<br/>Cloud Run"]
  W -->|"wake: a task"| Q["Cloud Tasks<br/>dmtr-region"]
  Q --> C["Controller<br/>Cloud Run"]
  S["Cloud Scheduler<br/>every 5 minutes"] -->|"idle check"| C
  C -->|"urlMaps.update"| UM
  C -->|"start, stop, suspend, resume"| G1
  W <--> F[("Firestore<br/>dmtr-region")]
  C <--> F
```

## Services

- **Cloud Load Balancing:** the URL map, the application's backend service and, per workload, a backend service
  `dmtr-<region>-<workload>` on the router's serverless NEG `dmtr-<region>-waker`, with the custom request header
  `x-dormeto-workload: <workload>`.
- **Compute Engine:** the VMs, their groups and autoscalers.
- **Cloud Run:** the waker `dmtr-<region>-waker` (ingress internal and Cloud Load Balancing, no invoker check, 0 to 10
  instances, 80 concurrent requests, 256 MiB, timeout 120 s) and the controller `dmtr-<region>-controller` (invoker
  check on, at most 3 instances, 10 concurrent requests, 512 MiB, timeout 900 s). Both get CPU during requests only, so
  an idle instance costs nothing. One container image, `DMT_ROLE` picks the role.
- **Firestore, Cloud Tasks, Cloud Scheduler, Cloud Monitoring:** the router's state (database `dmtr-<region>`), its
  asynchronous actions (queue `dmtr-<region>`: 3 attempts, 5 to 60 s apart), the check every 5 minutes (job
  `dmtr-<region>-check`) and the request counts.

The router runs as the service account `dmtr-<region>@<project>.iam.gserviceaccount.com`, whose custom roles
`dormetoRouter` and `dormetoRouterBackends` are in `gcp/access.json`, permission by permission. The router cannot
change IAM. The VMs start, stop, suspend and resume only with the tag `dormeto=managed` (a secure tag the onboarding
binds to the workload's VMs and groups).

## Wake time

**About 15–20 s after a resume, 43 s after a start** for a VM, **28 s after a resume, 40–43 s after a start** for a
managed group of two: from the wake request to the workload awake, through the router, with a small web server on `e2`
VMs and a health check every 5 s with 2 healthy checks.

| Measured through the router (2026-10-30, 6 runs) | Wake request to `AWAKE` | Browser: page opened to application shown |
|---|---|---|
| VM, resume | 14.8 s, 19.8 s | 16.8 s |
| VM, start | 42.6 s | |
| Managed group of two, resume | 28.2 s | 31.8 s |
| Managed group of two, start | 40.3 s, 43.1 s | 44.7 s |

Compute Engine's own times, measured through the load balancer before the router existed, five runs each: 13–25 s after
a resume and 37–41 s after a start for a VM, 28–34 s and 37–43 s for the group. So the router adds no delay that these runs
can tell apart, and the page's probe every 3 s adds at most 3 s. At a health check of 1 s, Compute Engine's times were 13 s
after a resume and 30–39 s after a start: set the health check to 1 s for the fastest wakes.

A waker with no instance running starts in about a second: the first page took 1.7 s, the others about 30 ms.

## Behavior

**There is no switch at the wake.** A URL map change takes 3 to 3.5 minutes to reach every request on the global load
balancer (measured), far beyond what a request can wait. So the application's backend service stays in the URL map for
good, and the nap uses the load balancer's **custom error response** instead.

**Nap.**
1. In each path matcher of the URL map that names the application's backend service (a map's default service gets a
   matcher `dormeto-default` of its own at the onboarding: a policy on the map itself would cover the whole load
   balancer), the router writes a custom error response policy: the load balancer's `502` and `503`, which it answers
   when no backend is healthy, are served from the workload's waker backend service at `/_dormeto/waiting`, with the
   status overridden to `503`. One `urlMaps.update` each, with the map's fingerprint; refused because of another update
   of the map, it is read again and retried with a pause, up to 60 s. A service that no URL map names any more, or that
   another URL map names too, is not napped: the workload stays awake, nothing is stopped, and the log says why.
2. It waits 300 s for the change to reach the load balancer (measured: 163–215 s). The application serves during that
   wait: it is the drain. A whole nap takes 6.5 to 8 minutes (measured).
3. It stops the VMs, or suspends them when the `hibernate` setting is on and the VM can be suspended (no GPU, no TPU,
   not confidential, at most 208 GB of memory; a refused suspension falls back to a stop). A managed group is napped
   through the group (`stopInstances`, `suspendInstances`), which keeps the VMs as a standby pool: none is re-created
   (but see the 60 days in the limits).
   Its autoscaler, if any, is turned off for the nap.

**While asleep.** Every request gets the waiting page (a `503` with `Retry-After`), served by the waker: the waker
answers the load balancer's fetch with a `200`, and the policy's override gives the visitor the `503`. The page's script
probes `/_dormeto/wake`, a route the onboarding added to the URL map for good, which goes through the same request
filters as on AWS (bots, scanners, no-wake rules) before it wakes the workload. API clients wake it with
`POST /_dormeto/wake`, answered with a `202`, JSON and the headers `x-dormeto-state` and `Retry-After` (a `200` once
awake): the waker answers no `503` there, which the policy would replace with the page. A plain request does not wake: the error response's fetch may not carry the visitor's request, and
waking on it would let every scanner wake the workload. The page reloads the visitor's address once the workload is
awake.

What the error response's fetch carries (measured): always a `GET` of `/_dormeto/waiting`, whatever the visitor's method and
path, with the visitor's query string, `Host`, `User-Agent`, `Referer` and address. So the waker could read who asks but not
what for, which is why a plain request still does not wake.

**Wake.**
1. The waker asks the controller for the wake through a task. The first request wins, as on AWS.
2. The controller starts or resumes the VMs (a managed group: `startInstances`, `resumeInstances`, then the autoscaler
   gets its mode back), and polls the backend service's health every 2 s.
3. At the first healthy instance the workload is `AWAKE`, and the error response policy is removed from the URL map.
   Until it is, the load balancer already sends requests to the VMs as soon as they are healthy: nothing needs to
   propagate. After it, the application's own `502` and `503` are its own again.

A wake that gets no healthy instance within the wake timeout (600 s by default) fails and says why, as on AWS; a start
refused for lack of capacity (`ZONE_RESOURCE_POOL_EXHAUSTED`) is a capacity failure, with the same backoff. There is no
fallback machine type.

**Idle check (every 5 minutes).** For each awake workload, the router reads the application's backend service's
`request_count` over the idle window, through any URL map (Cloud Monitoring publishes it 72–125 s late, and a single request can be missed:
the effective idle window is that much longer). None: nap. For each workload asleep, it checks the URL map still holds
the error response policy and the `/_dormeto/*` route (else it repairs them), and that the VMs are still down: a VM
started by hand makes the workload awake, and VMs all stopped by hand while it is awake make it `ASLEEP` with the cause
`external-stop`, as on AWS. A wake asked during a nap is kept: during the wait the nap gives up, no VM is stopped and the policy is removed; once the
VMs are going down, the workload wakes as soon as the nap ends.

**Offboarding.** `DELETE /v1/workloads/<id>` (the CLI) removes the policy, the route and the waker backend service. With
`force=true` it does so for a workload that cannot wake, and leaves its VMs down, saying so.

## Limits

- **The global external Application Load Balancer only.** The regional external and classic load balancers, zonal
  NEGs, Cloud Run and GKE backends are not supported yet.
- **A URL map written in Terraform must ignore what Dormeto writes.** The nap writes the custom error response policy
  (`default_custom_error_response_policy`, on each `path_matcher` naming the application's backend service), and the
  onboarding adds the route `/_dormeto/*` to those path matchers (a `path_rule` with `paths = ["/_dormeto/*"]`, or, when
  the matcher has `route_rule`s, a `route_rule` of priority 0); when the map's own default names the service, it adds a
  `host_rule` `*` and a `path_matcher` `dormeto-default` to hold them. Ignore those fields:
  `lifecycle { ignore_changes = [host_rule, path_matcher] }`. Otherwise `terraform apply` removes them: the workload is
  then expected to show the load balancer's own error page while it is asleep, and not to wake from its browser, until
  the 5-minute check repairs the map. The trade-off: later edits of your path matchers must go outside Terraform's plan,
  or by removing the ignore for that apply, which removes Dormeto's fields too until the check writes them back. A custom
  error response policy of your own on a path matcher that names the backend service, or a route of your own under
  `/_dormeto/`, makes the workload ineligible.
- **The VMs and groups written in Terraform must ignore what a nap changes.** On `google_compute_instance_group_manager`
  and `google_compute_region_instance_group_manager`, `ignore_changes = [target_size, target_stopped_size,
  target_suspended_size]`: a nap moves the VMs from the target size to the stopped or suspended size (measured), so an
  apply would move them back and could create new VMs. On `google_compute_autoscaler` and
  `google_compute_region_autoscaler`, `ignore_changes = [autoscaling_policy[0].mode]`: a nap turns it off. On
  `google_compute_instance`, `ignore_changes = [desired_status]` if you set it: an apply would start a napped VM. These
  field names pass `terraform validate`; no apply was run against a napped workload. The tag's binding is not a field of
  these resources, so it needs nothing.
- **From router 0.35.0, not accepted yet.** A regional or classic load balancer's URL map also ignores `default_service` and
  `default_route_action`, since a nap swaps the map's references to the waker (`ignore_changes = [default_service,
  default_route_action, host_rule, path_matcher]`). A Cloud SQL companion ignores `settings[0].activation_policy`, and a GKE
  workload's `kubernetes_deployment_v1` or `kubernetes_stateful_set_v1` ignores `spec[0].replicas`.
- **A path matcher naming another service too** shows the waiting page for that service's own `502` and `503` while the
  workload is asleep.
- **A request with a body gets Google's error, not the page.** While asleep, a `POST`, `PUT`, `PATCH` or `DELETE` with a
  body gets Google's plain `503` (`unconditional drop overload`, no `Retry-After`): the load balancer does not use the
  custom error response for it (measured). The same request without a body gets the page. API clients should read a `503` as
  asleep, send `POST /_dormeto/wake`, then retry their request.
- **The last requests of a nap.** Stopping or suspending a VM that is not in a managed group happens before the health
  check notices: a request in the few seconds until then can hang or fail (one request of the demo's run timed out at
  8 s). A managed group drains its VMs first.
- **VMs stopped by hand.** Until the next check, and until the policy it writes has spread (up to 8 minutes in all),
  visitors get Google's plain `503` and not the page, since no nap wrote the policy.
- **Internet noise counts.** The idle check counts every request the backend service answers, scanners' too: 8 such requests
  in 2 minutes kept a demo VM awake past its window. The browser filters refuse declared bots, but a scanner that runs
  JavaScript with a browser's user agent wakes the workload as a visitor would (seen on the demo). A map's default service
  gets the requests for any host name, so it is the most exposed.
- **The waiting page's browser wake.** The wake comes from the page's script, or from `POST /_dormeto/wake`. A client
  that runs no JavaScript and does not know that route (a `curl` of the application, a webhook) gets the page and does
  not wake the workload: the next visitor with a browser does.
- **The tag condition's limits.** The start, stop, suspend and resume permissions are granted on resources tagged
  `dormeto=managed`. Removing a VM's binding is enforced with a delay: a suspend 2.5 minutes after the removal still
  passed, a resume 25 minutes after it was refused (`403`, the workload `FAILED` with the kind `permission`). An autoscaler cannot carry a tag, so its mode is changed under `compute.autoscalers.update`
  without the tag condition. `compute.urlMaps.get`, `.list` and `.update` are marked "testing" in custom roles by
  Google (usable, not recommended for production); no narrower predefined role holds them.
- **Stops lose what a stop loses.** A VM with a local SSD or a GPU is refused at onboarding (a stop would lose the
  data). An ephemeral external IPv4 address changes at each start, which does not affect traffic through the load
  balancer. A suspended VM pays for its memory's storage; after 60 days Compute Engine turns it into a stopped one by
  itself, and the next wake is a normal start. A managed group recreates a VM suspended for over 60 days, without
  keeping its name, IP addresses or disks unless they are stateful, and a stateful group is refused at onboarding: what
  such a VM's disks held is gone. A regional managed group with the target shape `EVEN` and instance redistribution on is
  refused at onboarding: Google cannot stop or suspend its VMs one by one.
- **One router per project and region**, named `dmtr-<region>`. A workload's ID matches
  `^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$` so that its backend service's name fits Compute Engine's 63 characters; it
  defaults to the application's backend service's name when that matches, else `--id` names it.
- **No manager yet.** The CLI talks to the controller with the operator's identity; the manager, discovery and the
  dashboard come with the next increment. A failed wake therefore notifies nobody: it shows in the router's logs and in
  `dormeto gcp workloads show`.

## Setup

`dormeto gcp check`, then `dormeto gcp install` onboard a project and region (the access, the router), and
`dormeto gcp workloads` onboards a workload. The README of the CLI has the commands; the router's image is built with
`scripts/gcp-image.sh` (see the [README](../../README.md)).
