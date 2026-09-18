# cv-tailoring-worker

Helm chart for the AI worker pod group (Deployment + KEDA ScaledObject).

```bash
helm upgrade --install ai-agent-worker ./charts/cv-tailoring-worker \
  --namespace default \
  --set image.tag=$GIT_SHA \
  --set existingSecret=cv-tailoring-secrets \
  --set keda.host=http://rabbitmq.default.svc.cluster.local:15672
```

## What it renders

| Template | Object | Notes |
|---|---|---|
| `deployment.yaml` | Deployment `ai-agent-worker` | 0 replicas by default (KEDA owns the count), exec probes, `terminationGracePeriodSeconds: 120`, emptyDir at `/tmp/cvt` |
| `scaledobject.yaml` | `ScaledObject` | RabbitMQ trigger, `mode: QueueLength`, 0..20 replicas, 300 s cooldown, fallback replicas if metrics fail |
| `triggerauthentication.yaml` | `TriggerAuthentication` | credentials from a Secret (never inline) |
| `configmap.yaml` | ConfigMap | all non-secret env (queue name, backends, log format, paths) |
| `secret.yaml` | Secret | **disabled by default**; prefer `existingSecret` |
| `tests/health-test.yaml` | Pod (helm test) | proves poppler + LibreOffice are in the image and the broker is reachable |

## Key values

| Value | Default | Meaning |
|---|---|---|
| `replicaCount` | `0` | ignored while `keda.enabled=true` |
| `fullnameOverride` | `ai-agent-worker` | matches the pod names in the design doc |
| `config.queueBackend` | `amqp` | `amqp` in cluster, `directory` for k8s-free POCs |
| `config.dbBackend` | `postgres` | `postgres` \| `local` |
| `keda.mode` | `QueueLength` | ready **+ unacked**, so 15-45 s tasks count while in flight |
| `keda.queueLength` | `"1"` | 1 pod per pending message → "20 vacancies → 20 pods" |
| `keda.fallback.replicas` | `1` | keeps a working floor if the RabbitMQ metrics API is down |
| `existingSecret` | `""` | Secret with `GEMINI_API_KEY`, `DATABASE_URL` (broker credentials come from the KEDA Secret) |

## Why the worker needs no Service or Ingress

It never receives traffic: it pulls from RabbitMQ. Liveness/readiness are exec
probes (`python healthcheck.py --mode liveness|readiness`), where readiness
tracks the heartbeat file updated after every completed task.
