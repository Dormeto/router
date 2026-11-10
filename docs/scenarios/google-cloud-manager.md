# Google Cloud: the router and the manager

From router 0.40.0, the Dormeto manager reads a Google Cloud router and acts through it as it does an AWS one. The router
pushes nothing: it keeps its journal and its check summary in Firestore, and answers one route, `POST /v1/actions`, which
the manager polls every minute. This page is what the router keeps, what it answers and what is its own. The connection
(the manager's two service accounts and the grants that reach this router) is made by `dormeto gcp connect`, which is
documented in the CLI's README, not here.

## What the router keeps

- **The event journal**, `events/` in the router's Firestore database: one document for each change of a workload's state,
  with the id `<stateAt padded to 13 digits>-<workloadId>-<state>`, so the ids sort by time. It is written in the same
  commit as the state change, never apart from it, and holds AWS's `Workload state changed` detail: `workloadId`, `from`,
  `to`, `router`, `region`, `project`, `at`, the `cause`, the `wakeId` and `durationMs` of a wake, a `failure`, `by` (who
  asked, for a nap, a wake or a pause from the manager), the `fallbacks`, the VMs `hibernated`, the priced items a nap `stopped` (below) and the workload's `tags`.
  Events are kept 7 days: the daily sweep that removes the old counters removes them too.
- **The check summary**, `router/check`: replaced whole at each check (every 5 minutes, `checkSchedule` is
  `*/5 * * * *`) with the time of the check and how long it took, the time of the last check the schedule started, the
  router's health (the same problems as AWS's health that apply here, such as a manager settings document that cannot be
  read, plus pauses that cannot be read), the router's own pauses (a workload's are in its row) and the count of
  workloads by state. A summary that cannot be written fails nothing: the check's work is done.
- **The organization's level**, `router/manager`: the manager's whole `settings.json` as it pushed it, kept as one JSON
  string (Firestore refuses as a field name some keys a `settings.json` may hold, such as a custom type's tag key
  `__x__`), with its ETag and the time it was stored. Without a push, the organization level reads as unset.

## `POST /v1/actions`

The body is AWS's controller payload, `{ "action": …, … }`, and the answers are AWS's controller answers, each built by
the code behind the REST routes the CLI uses (which keep their own answers). The controller is a private Cloud Run
service: the manager calls it with an ID token of its command service account, which holds `roles/run.invoker` on it
(the grant `dormeto gcp connect` makes).

- **The AWS actions it answers:** `router`, `list`, `status`, `request-nap`, `force-wake`, `pause`, `resume`, `rename`,
  `tag`, `settings`, `waiting-page`, `schedule`, `clear-schedule`, `preview`, `onboard` and `offboard`. The rows of
  `list` carry AWS's row keys, and `status` AWS's status keys: what AWS's status reads live and Google Cloud does not
  (the last request, the load balancer's rules, the targets) keeps its key, empty. A Google Cloud row names its backend
  service where AWS's names its target group.
- **The two Google Cloud ones:** `events` and `manager-settings` (below).
- **Any other action** is answered as AWS's controller does: with `"refusals": true`, a refusal `unsupported`
  (`unknown action: <name>`); without it, a 400 `{ "error": "unknown action: <name>", "reason": "unknown-action" }`. The
  wake, nap, release, check and list refresh that AWS receives as invocations are this router's own work, started by its
  Cloud Scheduler job and its waker.
- **Refusals.** With `"refusals": true`, a refusal is a 200 `{ "refused": { "code", "message" } }` with AWS's codes,
  `invalid`, `not_found`, `conflict` and `unsupported`; without it, the REST routes' status and `{ "error", "reason" }`. The problems
  AWS answers as `{ "problems": […] }` (a settings write, a waiting page, a schedule) are answers either way.
- **The manager's own actions say who asked**: a wake or a nap from the manager carries `by`, and its events the cause
  `manager`; a pause carries `by` too: the pause itself writes no event, and the wakes it starts write theirs, with the
  cause `pause` and its `by`.

### `events`

`{ "action": "events", "after": <event id or null>, "limit": 1..500 }` answers `{ "events": […], "next", "check",
"managerSettings": { "etag" } }`: the events after `after` (all that are kept when it is null), the oldest first,
`limit` at most. `next` is the last id of a full page, since there may be more, else null. `check` is `router/check` with
its times as ISO dates (null before the first check), and `managerSettings.etag` the ETag of the organization's
settings the router holds (null when it has none), which is what the manager compares with its own file. A `limit` outside
1 to 500, or an `after` that is not an event id, is a refusal.

### `manager-settings`

`{ "action": "manager-settings", "settings": <the manager's settings.json>, "etag": <its ETag> }` stores both in
`router/manager` and answers `{ "etag" }`. The `etag` is a string of 1 to 256 characters; `settings` is needed.

## What a nap's event names

The `Workload state changed` event of a nap (`to` ASLEEP) names what the nap stopped as priced items, `stopped`, at most 50,
which is what the manager prices (AWS's event names its own the same way). The failed workload's release, which puts a failed
workload to sleep (cause `failed-released`), names them the same way. The run keeps the names of the VMs (and GKE owners) a nap
stopped or suspended, which the row's `hibernated` reads; the items are only for the event.

- **A VM** (`gce`): `{ kind, machineType, family, vcpus, memoryGb, count, os, spot?, suspended?, zone }`. `family` is the machine
  type up to its first `-` (`e2-small` is `e2`, `n2d-custom-4-8192` is `n2d`), and a `custom-` type is `n1`. `vcpus` is the
  machine type's `guestCpus`, but the shared cores bill a fraction: `e2-micro` 0.25, `e2-small` 0.5, `e2-medium` 1, `f1-micro` 0.2
  and `g1-small` 0.5. `memoryGb` is the machine type's `memoryMb` over 1024 (GiB, as Google bills). `os` is `Windows` when a boot
  disk's license is in `/projects/windows-cloud/`, else `Linux` (spelled as AWS's items spell it). `spot` is set for a Spot or preemptible VM and `suspended` for
  one the nap suspended instead of stopping. VMs of one machine type, zone, system, Spot and suspension are one item, with their
  `count`.
- **A Cloud SQL instance** (`cloudsql`): `{ kind, tier, engine, edition, ha, region, vcpus?, memoryGb? }`: `engine` is
  `postgres`, `mysql` or `sqlserver` (from the `databaseVersion`), `edition` is `enterprise` or `enterprise-plus`, and `ha`
  is true for a regional instance. `db-custom-N-M` gives `vcpus` N and `memoryGb` M over 1024, and `db-perf-optimized-N-K` gives K
  vCPUs and 8 GB each (Google's Enterprise Plus N tiers have 8 GB a vCPU); the shared cores and any other tier give neither. An instance
  that no longer exists adds no item.
- **What cannot be read** is an `unknown` item, `{ kind, backend, reason }`, with the backend as `status` names it
  (`instance:<vm>`, `asg:<group>`, `k8s:<id>`, `cloudsql-instance:<name>`) and the reason, cut to 200 characters: a VM deleted since the nap
  stopped it, a refused read, a Cloud SQL instance whose engine or tier is unreadable. Each GKE backend is one, with the reason
  "GKE pods are not priced". Describing never stops a nap: the nap reaches ASLEEP whatever these reads answer. A reason starts with Google's status and
  message (the URL left out). When the whole description fails or takes more than 60 seconds, the event holds one unknown item
  with the backend `all` (not an empty list, which would read as nothing running), and the router says `StoppedUndescribed`.

## The organization level

The router reads `router/manager` through AWS's own parsing, so that both clouds read the same file alike: the hibernation
default (`hibernate`), `joinMinutes`, `endedWindowDays`, the defaults and the custom types, and the organization's
`waitingPage`. The levels are AWS's, the workload's own values first, the organization's after the router's. A
part that is invalid is dropped and said, and the rest applies. A document that is not an object reads as unset and the
router's health says so (`manager-settings-unreadable`). What the organization's level supplies shows in the `hibernation`
view of `status` as the manager's level.

## Router-wide pause

The `pause` action without a `workloadId` pauses the whole router, and `resume` without one lifts it; the pause is
kept in `router/pause`, and shows in `list` (`router.pauses`) and in the workloads' own pauses with the scope
`router`. It is the same pause `dormeto gcp routers pause` sets (`--reason`, `--for`, `--until`, `--keep-asleep`).
A `request-nap` for a workload a pause holds is not a refusal: it answers `{ "requested": false, "reason" }` with the pause's words, as on AWS.
## Exclusions

A manager's exclusion pauses a workload as it does on AWS: a `pause` with an `exclusionId` (1 to 64 characters: letters, digits, `.`, `_` and `-`)
keeps its own pause, `pauses/<workloadId>#<exclusionId>`, beside the operator's, and a `resume` with the `exclusionId` lifts
that one alone; without it, a `resume` lifts the operator's. `status` lists the exclusions' pauses first, with their
`exclusionId`. An exclusion's `pause` names the workload's `backendService` (a path or a name) where AWS's names the
`targetGroupArn`: another backend service, or an unknown workload, is refused `workload not configured: <id>` (with
`(its backend service is not <path>)` for a backend service), and a `targetGroupArn` is refused (`invalid`). A backend
service path must be the workload's own: the router's project, its name, and its scope (`global`, or `regions/<region>` of
a regional or internal load balancer); a bare name is compared by name alone. Offboarding removes every pause of the workload.

## Names and tags

`rename` and `tag` set a workload's name and tags, kept in its configuration beside the ones the CLI's onboarding sets
(`dormeto gcp workloads onboard --name --set-tag`), and shown in the rows and in each event's `tags`. An onboarding says where
it came from, `source: "cli"` or `"manager"`.

## Onboarding through the manager

`preview` and `onboard` take AWS's onboarder payload: `databases` is a list of Cloud SQL instance names (the CLI's) or of
AWS's entries `{ "kind": "cloudsql-instance", "id": <name> }`, not both in one list, and an entry of another kind is
refused (`invalid`); the fallback machine types are `settings.fallbackInstanceTypes`, or `fallbackInstanceTypes` at the
top level, and the REST body's `cloudSql` is accepted beside `databases`: both forms given and different are refused
(`invalid`). GKE access and request logs are not taken: they stay with the CLI. An onboarding from the manager
records `onboardedBy`, who asked (`unknown` when the payload names no one), which the workload's `status` and the REST Workload carry, not the rows of `list`;
one from the CLI records no one. `status`'s `instance` and `asg` backends carry `resourceId`, the numeric id the
onboarding stored (the manager removes the `dormeto/managed` binding on that id at an offboarding, whoever bound it, the
CLI too), and their `location`; a backend stored without its id has none. `status` also keeps the workload's `requestLogs`.

## Ended windows

An ended window (a schedule's window with a date that is past) is removed from its schedule at a check, once it ended
`endedWindowDays` days ago: the organization's value, 365 days when it sets none, and 0 keeps them. When the
organization's settings cannot be read, none is removed, since the organization's 0 may be there. Each removal is
logged, `EndedWindowsRemoved`.

## Limits

- **The manager polls, the router does not push.** It asks every minute and reads the journal again from 5 minutes
  before the newest event it has, so an event is read twice and kept once.
- **A router older than 0.40.0 has no `/v1/actions`**: the manager lists it with its version, does not poll it and
  says which `dormeto gcp install` command upgrades it.
- **The journal is 7 days.** A manager that cannot read the router for longer loses the changes in between; its history
  is inferred from the next check's states.
- **The IP lists stay the router's:** the manager's catalog is in S3, which a Google Cloud router cannot read.
- **What only the CLI undoes:** `offboard` refuses (`conflict`) a GKE workload, whose Kubernetes access is the
  operator's, and a workload whose onboarding turned its backend service's request logs on, which the manager's accounts
  can't set back; the refusal names the command that offboards it, `dormeto gcp workloads offboard <id> --project <p>
  --region <r>`.
