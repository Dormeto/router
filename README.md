# Dormeto Router

Data plane of **Dormeto**, which puts idle web workloads to sleep and wakes them just-in-time: the Waker (ALB Lambda
target), the Executor (sleep, wake, apply, restore), the Sensor (inventory, drift) and the shared contracts.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Management plane: [Dormeto/manager](https://github.com/Dormeto/manager)
