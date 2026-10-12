# dev-eks

A customer's EKS cluster for Dormeto's Kubernetes workloads (vision `docs/specs/2026-10-11-kubernetes-design.md`):
written as a customer would, with no Dormeto resource. The manager discovers its workloads, grants cluster access and
onboards them; `dormeto-e2e` runs its acceptance.

- **What it holds:** its own VPC (two public and two private subnets, one NAT gateway), EKS 1.36 (authentication mode
  `API`, public endpoint), one small system node (`t4g.medium`, tainted `CriticalAddonsOnly`) for CoreDNS, metrics-server,
  the AWS Load Balancer Controller and Karpenter, a Fargate profile for `demo-fargate`, and Karpenter's NodePool for the
  demos (nodes removed a minute after they are empty).
- **Demos** (`charts/demos`): `web` (a Deployment), `cache` (a StatefulSet), `api` (with an HPA) and `docs` (on Fargate)
  behind one IngressGroup, at `https://<demo>.eks.dev.dormeto.com/`; `solo` behind a lone Ingress
  (`-var lone_ingress=true`, its own ALB) and `bind` behind a TargetGroupBinding to an ALB this root owns
  (`-var target_group_binding=true`), each about $22 a month while set.
- **Cost:** about $155 a month while it exists (the control plane $73, the NAT gateway $35, the group's ALB $22, the
  system node $25), the demos napped by Dormeto. Kept while R10.5 is built, then created for each e2e campaign and
  destroyed after.
- **Access:** the user's SSO role has cluster admin through an access entry (`admin_role_arn`):
  `aws eks update-kubeconfig --name eks-demo --region eu-west-1 --profile kloudy-dormeto-prd`.

**Needs** the AWS CLI and kubectl on the caller's PATH: before the charts, the root waits until every API server
enforces the caller's admin access (EKS takes some seconds, each API server on its own); its destroy-time waits use the
AWS CLI too.

```
tfenv exec init
tfenv exec plan -out dev-eks.tfplan        # read it
tfenv exec apply dev-eks.tfplan            # the user's go-ahead
```

**Destroy** (`tfenv exec plan -destroy -out dev-eks.tfplan`, then apply): the demos go first; the root then waits for
the controller to delete its load balancers and target groups, and for Karpenter's instances to be terminated, before
removing them (they would keep billing and block the VPC's deletion). Then `dormeto-e2e cluster check --name eks-demo
--region eu-west-1` lists anything left.

**The spike** (vision `docs/plans/2026-10-11-kubernetes.md`, K0.2): `-var spike=true` adds a Lambda target group
answering `waker`, the stand-in for Dormeto's waker.
