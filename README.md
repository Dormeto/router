# Dormeto router

Data plane of [Dormeto](https://github.com/Dormeto/vision) ("nap" in Esperanto): it puts idle web workloads to
sleep and wakes them just-in-time on the next request.

This MVP manages one EC2 instance behind an ALB:

- `waker` Lambda: ALB target used only while the workload naps. It wakes the workload once, holds the request up to
  `waitSeconds`, then answers a `307` or a self-reloading waiter page.
- `controller` Lambda: switches the ALB rule weights, stops and starts the instance, naps idle workloads (scheduled
  check of the ALB `RequestCount`), and reconciles external changes.

Instances are **discovered** from the application target group: every instance target tagged
`dormeto:workload=<workload id>` is managed; other targets are ignored (and shown on the admin dashboard). The nap records
the instances it stopped and the wake starts exactly those. A static `instance_ids` list on the `workload` module is
still supported.

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

## Admin dashboard (feature flag)

With `admin_dashboard_enabled = true` (default in `dev`), the waker Lambda also serves a lightweight dashboard behind a
secret URL: state, time before nap, underlying resources (route, instance, target health), force nap and force awake.

```bash
terraform -chdir=terraform/dev output -raw admin_url          # open it in a browser
curl -sS "$(terraform -chdir=terraform/dev output -raw admin_url)status.json"
terraform -chdir=terraform/dev apply -replace='random_password.admin[0]'   # rotate the secret
```

The secret URL is the only protection: never share it. Disable the flag with `-var admin_dashboard_enabled=false`.
