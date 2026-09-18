# cv-tailoring-platform (umbrella)

One command installs the whole in-cluster side of the architecture:

| Pod group | Source | Note |
|---|---|---|
| ① RabbitMQ broker (`rabbitmq-0`) | **this chart** (`templates/rabbitmq.yaml`) | StatefulSet on the official `rabbitmq:3.13-management` image |
| ③ Autoscaler (`keda-operator`, `keda-metrics-server`) | **kedacore** `kedacore.github.io/charts` | only upstream dependency |
| ② AI worker (`ai-agent-worker-*`) | this repo (`file://../cv-tailoring-worker`) | |

### Why the broker is not the Bitnami subchart

In 2025 Bitnami moved its chart index behind `repo.broadcom.com` and emptied the
free `bitnami/*` image repositories, so a stock Bitnami RabbitMQ release fails
with `ImagePullBackOff`. The design document allows either a **StatefulSet** or a
Bitnami chart, so the broker is rendered here directly: durable queue, management
plugin (for the KEDA scaler), persistent volume, and the queue definitions from
`rabbitmqDefinitions`. Credentials live in one Secret shared with the worker and
the KEDA TriggerAuthentication.

```bash
helm dependency update ./charts/cv-tailoring-platform
helm upgrade --install cv-tailoring ./charts/cv-tailoring-platform \
  --namespace default --create-namespace \
  -f deploy/values/dev.yaml \
  --set cv-tailoring-worker.image.tag=$GIT_SHA
```

## Value-name gotcha

* top-level `keda:` → the **KEDA operator subchart**
* `cv-tailoring-worker.keda:` → the **worker's ScaledObject** settings

## Ordered bootstrap

1. `rabbitmqCredentials.create=true` (or an externally managed Secret) →
   `rabbitmq-credentials` with `rabbitmq-username` / `rabbitmq-password` / `rabbitmq-url`.
2. `rabbitmqDefinitions.create=true` → `rabbitmq-definitions` with
   `definitions.json` pre-declaring `resumes.generate`, its DLQ, `vacancies.parse`
   and `applications.submit`. The worker's TTL retry ladder is declared by the
   worker itself on connect.
3. Worker env: pass the credentials Secret name via
   `cv-tailoring-worker.existingSecret` (production) or set
   `cv-tailoring-worker.secrets.create=true` (dev only).

## Not in this chart

* **Node pools / cluster autoscaler** — provider infrastructure. This chart
  targets a single-node local cluster; on a managed cluster you would add a
  `nodeSelector`/tolerations pair per pool (broker + KEDA on the system pool,
  workers on the autoscaled one).
* The **API gateway**, dashboard and browser extension are separate deliverables;
  `publisher.py` emulates the gateway for testing.
