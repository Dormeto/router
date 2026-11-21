# Standalone workloads

Not released yet: router 0.42.0.

A **standalone workload** is one stoppable resource that no load balancer serves: a batch server, a build agent, a worker
service, a database used by hand. The router naps it when its idle signals show nothing happening for its idle window, on a
schedule or on a person's word, and wakes it on a schedule or on a person's word. **Nothing wakes it on demand**: there is no
request to see, so there is no waiting page, no wake rule, no wake mode and no held request.

```mermaid
sequenceDiagram
  autonumber
  participant C as Controller Lambda
  participant CW as CloudWatch
  participant R as Resource
  participant D as Databases
  Note over C: Every 5 minutes
  C->>CW: GetMetricData: the idle signals over the idle window
  CW-->>C: Every 5-minute point under its threshold
  C->>R: Stop (or hibernate, or scale to 0)
  C->>D: Stop the companions
  Note over C: Later: a schedule's awake window, or a person's wake
  C->>D: Start the companions, wait until available
  C->>R: Start (or scale back)
  loop Every 3 s
    C->>R: Running at its full size?
  end
```

## What can be standalone

| Resource | Nap | Wake |
|---|---|---|
| EC2 instance outside an Auto Scaling group | Stopped, or hibernated when it was launched with hibernation | Started |
| Auto Scaling group | Scaled to 0, its scaling processes suspended | Given back its size, processes resumed |
| ECS service | Desired count 0, its Application Auto Scaling target suspended | Its desired count back |
| RDS instance or Aurora cluster | Stopped | Started, then waited until available |

The onboarding refuses a resource that cannot be one, with a reason:

- **It belongs to an HTTP workload:** an instance that is a target of a target group, an Auto Scaling group attached to a
  target group, or an ECS service registered with one. Onboard its target group instead.
- **It is in another workload:** it carries another workload's `dormeto:workload` tag, it is a companion database of
  another workload, or it is onboarded already. A resource is in one workload; an HTTP onboarding also refuses a target
  group whose backend, or a database, is a standalone workload's, naming it: offboard that one first.
- **An instance** that is not found or terminated, that is in an Auto Scaling group (onboard the group: it would replace a
  stopped instance), whose root volume is an instance store (it cannot be stopped), or that is a **Spot instance**: Dormeto
  stops On-Demand instances only.
- **An Auto Scaling group** that holds EKS nodes (its tags say so: EKS, eksctl, Karpenter or the cluster autoscaler): onboard
  the Kubernetes workloads that run on them.
- **An ECS service** with the daemon scheduling strategy: it has no desired count to set to 0.
- **An RDS instance** that is a member of an Aurora cluster (onboard the cluster) or a read replica, and **an Aurora
  Serverless v1 cluster**: RDS cannot stop them.

A standalone workload may name **companion databases**, as an HTTP workload's: they stop after it and start before it. A
database alone is a standalone workload whose resource is the database.

## Idle signals

A standalone workload is idle when **every signal it has is under its threshold at every 5-minute point of its idle
window**, and it has been awake for the whole window. A missing point, or a read that fails, is never idle. With no signal
at all, it never naps on idle: schedules and people only.

| Setting | Values | Built-in | Signal |
|---|---|---|---|
| `idleMinutes` | 5 to 1440 | 120 (an HTTP workload's: 15) | The idle window |
| `idleCpuPercent` | 0 to 100, or `off` | 5; `off` when the resource is a database | The CPU's maximum: `AWS/EC2 CPUUtilization` by instance or by group, `AWS/ECS CPUUtilization` by cluster and service, `AWS/RDS CPUUtilization` |
| `idleNetworkBytes` | 0 to 10,000,000,000, or `off` | `off` | The bytes in and out, a minute: `AWS/EC2 NetworkIn` + `NetworkOut`, `AWS/RDS NetworkReceiveThroughput` + `NetworkTransmitThroughput`. An ECS service has none without Container Insights: the signal does not apply there, and the status says so |
| `idleMetric` | `{ namespace, name, dimensions, statistic, below }`, or `off` | `off`; the type `databases`: its database's `AWS/RDS DatabaseConnections`, `Maximum`, below 1 | One CloudWatch metric of your own; `statistic` is `Maximum`, `Average` or `Sum`; a dimension's value may hold `${resource}`, replaced by the resource's own id (instance id, group name, service name, database identifier) |

- **Levels.** These settings resolve as every other: the workload's own, its type's, the router's, the organization's,
  then the built-in value. `off` at a level turns off a signal a level above sets. The status says each threshold's level.
- **The type `databases`.** A workload with a database, as its resource or as a companion, has its connections under 1
  as a signal. A server with a companion database keeps its CPU signal too: both must be idle.
- **The 10-minute lag.** CloudWatch publishes a point minutes after its period ends, so the window the router reads ends
  10 minutes behind, at a 5-minute boundary. An idle nap therefore comes 10 to 15 minutes after the idle window, on the next
  5-minute check. A busy workload is read again once its window can be idle; a missing last point, at the next check. A
  queued nap delivered more than a minute after it was asked reads the signals again and is skipped if the workload is busy.
- **The status** shows each signal: its threshold, its level, its last value, since when it is under, and the nap
  estimate from them.
- An HTTP workload keeps its one signal, its requests: these settings are refused on it.

## Schedules, people and changes made outside Dormeto

- **Schedules** work as for an HTTP workload: a nap window naps it; an awake window wakes it, and keeps it from an idle
  nap while it lasts and in the 30 minutes before it starts. A nap window has no `wake` choice: nothing arrives to wake it
  then, so the field is refused.
- **After an idle nap it stays asleep** until a schedule's awake window, a person's wake (the manager, the CLI, the API)
  or a start made outside Dormeto. A workload with a schedule is the expected case.
- **Pauses and hibernation** work as for an HTTP workload.
- **Awake** once every backend runs: an instance running, a group at its size with its instances in service, a service
  at its desired count with its tasks running, a database available, within the wake timeout (600 s, 1800 s for the type
  `databases`).
- **A failed wake** is retried by the check after 60 s, doubled after each failure in a row, at most 30 minutes, while the
  workload is failed. A keepAsleep pause or a nap window holds the retry; a stop made outside Dormeto that leaves every
  backend stopped ends it (the workload is asleep).
- **A start or stop made outside Dormeto** (the console, a script, AWS's own restart of a database stopped 7 days) is seen
  at the next check: the workload is awake (`external-start`, its stopped companions started) or asleep (`external-stop`).
- **A resource deleted, or its `dormeto:workload` tag removed:** the workload has no backend, nothing is stopped or
  started (its databases included), its state stays, and the router's health warns.

## Onboarding

- **The manager** calls the onboarder's `preview` and `onboard` with `resourceArn` in place of `targetGroupArn`. The
  onboarding tags the resource and its companion databases `dormeto:workload` (with the marker `dormeto:tagged = onboarder`)
  and writes the workload's configuration: no waker target group, no rule. Offboarding (the workload awake) removes the tags
  and the configuration.
- **Terraform:** the `workload` module takes `resource_arn` in place of `app_target_group_arn` (one of the two), the
  settings `idle_minutes`, `wake_timeout_seconds`, `idle_cpu_percent`, `idle_network_bytes`, `idle_metric`, `hibernate`,
  `type`, `fallback_instance_types` and `databases`; the waker's settings are refused with it. Tag the resource and its
  databases `dormeto:workload = <workload_id>` yourself.
- **Permissions:** none new. The router's mutations are conditioned on the workload tag, and it already reads CloudWatch,
  EC2, Auto Scaling, ECS and RDS.

## Limits

- **Nothing wakes it on demand:** no connection, request or message wakes a standalone workload, nor keeps it awake.
- **One custom metric** a workload.
- **Spot instances** are refused.
- **Timing.** Naps start on the 5-minute check, 10 to 15 minutes after the idle window.
