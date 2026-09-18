# Cluster infrastructure

Helm deploys workloads *into* a cluster; node pools and autoscaling are provider
infrastructure, so they live here.

## Options

| Option | When | How |
|---|---|---|
| **AKS** (primary) | production-like, matches the design doc | `aks.bicep` + `scripts/create-cluster.sh` |
| **k3s / single VM** | squeeze the free credit, tiny scale | `curl -sfL https://get.k3s.io \| sh -` + `cluster-autoscaler` chart (or static node) |
| **kind / Docker Desktop** | day-to-day dev, `helm test` in CI | `kind create cluster --name cvtailoring` |

## What `aks.bicep` provisions

* AKS **Free tier** control plane, RBAC enabled.
* **System node pool** `system` — `Standard_B2s` (2 vCPU / 4 GB), tainted
  `workload=system:NoSchedule`, autoscaling off. Hosts RabbitMQ + KEDA + ingress
  (pod group ①/③, always on, ~250 MB + ~50 MB RAM).
* **User workload pool** `workload` — autoscaled **0 → 5**, labelled
  `nodepool=workload`. Hosts the AI worker pods (pod group ②) and shrinks back to
  zero when the queue drains.
* ACR (Basic) for the worker image.

## Bootstrap

```bash
az group create -n rg-cvtailoring -l westeurope
az deployment group create -g rg-cvtailoring -f deploy/infra/aks.bicep \
  -p clusterName=cvtailoring userMinCount=0 userMaxCount=5
az aks get-credentials -g rg-cvtailoring -n cvtailoring
# let the cluster pull from ACR (no imagePullSecret needed)
az aks update -g rg-cvtailoring -n cvtailoring --attach-acr <acrName>
```

Node labels used by `deploy/values/prod.yaml`:

* `nodepool=system` → RabbitMQ and KEDA (plus the taint `workload=system`)
* `nodepool=workload` → AI worker pods

## Cost profile

Workers are `0` replicas at idle (`$0.00`, "pay only for execution seconds"); the
system pool is a single small always-on node; the workload pool disappears when
the queue is empty. `rabbitmq` persistence keeps queued work across node churn.
