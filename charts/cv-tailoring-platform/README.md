# cv-tailoring-platform (umbrella)

One command installs the whole in-cluster side of the architecture:

| Pod group | Subchart | Source |
|---|---|---|
| ① RabbitMQ broker (`rabbitmq-0`) | `rabbitmq` | **Bitnami** `charts.bitnami.com/bitnami` |
| ③ Autoscaler (`keda-operator`, `keda-metrics-server`) | `keda` | **kedacore** `kedacore.github.io/charts` |
| ② AI worker (`ai-agent-worker-*`) | `cv-tailoring-worker` | this repo (`file://../cv-tailoring-worker`) |

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

Node pools / cluster autoscaler are provider infrastructure — see
`deploy/infra/`. The Vercel API gateway, Astro dashboard and Chrome extension are
separate deliverables; `publisher.py` emulates the gateway for testing.
