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
  asked, for a nap, a wake or a pause from the manager), the `fallbacks`, the VMs `hibernated` and the workload's `tags`.
  Events are kept 7 days: the daily sweep that removes the old counters removes them too.
- **The check summary**, `router/check`: replaced whole at each check (every 5 minutes, `checkSchedule` is
  `*/5 * * * *`) with the time of the check and how long it took, the time of the last check the schedule started, the
  router's health (the same problems AWS's health names, with the Google Cloud ones: a manager settings document that
  cannot be read, pauses that cannot be read), the active pauses and the count of workloads by state. A summary that
  cannot be written fails nothing: the check's work is done.
- **The organization's level**, `router/manager`: the manager's whole `settings.json` as it pushed it, with its ETag and
  the time it was stored. Without a push, the organization level reads as unset.

## `POST /v1/actions`

The body is AWS's controller payload, `{ "action": …, … }`, and the answers are AWS's controller answers, each built by
the code behind the REST routes the CLI uses (which keep their own answers). The controller is a private Cloud Run
service: the manager calls it with an ID token of its command service account, which holds `roles/run.invoker` on it
(the grant `dormeto gcp connect` makes).

- **The AWS actions it answers:** `router`, `list`, `status`, `request-nap`, `force-wake`, `pause`, `resume`, `rename`,
  `tag`, `settings`, `waiting-page`, `schedule`, `clear-schedule`, `preview`, `onboard` and `offboard`. The rows carry
  AWS's keys: what AWS reads live and Google Cloud does not (the last request, the load balancer's rules, the targets)
  keeps its key, empty. A Google Cloud row names its backend service where AWS's names its target group.
- **The two Google Cloud ones:** `events` and `manager-settings` (below).
- **Any other action** is a 400, `{ "error": "unknown-action" }`: the wake, nap, release, check and list refresh that AWS
  receives as invocations are this router's own work, started by its Cloud Scheduler job and its waker.
- **Refusals.** With `"refusals": true`, a refusal is a 200 `{ "refused": { "code", "message" } }` with AWS's codes,
  `invalid`, `not_found` and `conflict`; without it, the REST routes' status and `{ "error", "reason" }`. The problems
  AWS answers as `{ "problems": […] }` (a settings write, a waiting page, a schedule) are answers either way.
- **The manager's own actions say who asked**: a wake, a nap or a pause from the manager carries `by`, and its events
  the cause `manager`.

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
A `request-nap` for a workload a pause holds is refused with the pause's words, as on AWS.

## Names and tags

`rename` and `tag` set a workload's name and tags, kept in its configuration beside the ones the CLI's onboarding sets
(`dormeto gcp workloads onboard --name --tag`), and shown in the rows and in each event's `tags`. An onboarding says where
it came from, `source: "cli"` or `"manager"`.

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
