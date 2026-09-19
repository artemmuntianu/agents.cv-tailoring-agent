# charts/ (+ deploy/values) - the cluster deployment

Two Helm charts and the values that point them at a cluster. They are the
contract between the Python worker and Kubernetes: the worker ConfigMap is the
only place a `config.py` setting becomes an env var, and the ScaledObject is what
gives the platform its 0 -> M -> 0 cost profile.

Read `CONSTITUTION.md` first (sections 2, 3 and 5).

## Layout

| Path | Owns |
|---|---|
| `cv-tailoring-platform/` | Umbrella: the broker, its Secrets, the local-dev Postgres, the artifact volume and both dependencies |
| `cv-tailoring-platform/templates/rabbitmq.yaml` | RabbitMQ StatefulSet (`rabbitmq-0`) + Service: durable queue, the `-management` image so KEDA's HTTP scaler works, `rabbitmq-diagnostics -q ping` probes |
| `cv-tailoring-platform/templates/local-postgres.yaml` | `localPostgres.enabled` -> single-replica Postgres + `local-postgres` Secret + `postgres-data` PVC. The worker creates its own tables (no init scripts) |
| `cv-tailoring-platform/templates/storage.yaml` | `cv-artifacts` PVC (`helm.sh/resource-policy: keep`) and the always-on `cv-files` pod that keeps `kubectl cp` working while the worker is at zero |
| `cv-tailoring-platform/templates/definitions.yaml` | The queue topology (`resumes.generate`, its `.dlq`, `vacancies.parse`, `applications.submit`, the DLX policy/binding) as a definitions Secret - reviewable in git, loaded by `rabbitmq.yaml` |
| `cv-tailoring-platform/templates/rabbitmq-credentials.yaml` | The one Secret holding username/password/url, shared by the broker, the worker and KEDA |
| `cv-tailoring-worker/` | The worker pod group: Deployment, ScaledObject, TriggerAuthentication, ConfigMap, optional Secret/PVC, `helm test` probe |
| `cv-tailoring-worker/values.schema.json` | Type/enum guard for the values Helm must accept before anything renders |
| `deploy/values/dev.yaml` | Local-cluster overrides: `localPostgres` on, dev broker password, `existingSecret: cv-tailoring-secrets`, `/data` mount, 0..3 replicas |
| root `Dockerfile` / `docker-compose.yml` | The image (LibreOffice + poppler + Carlito/Caladea fonts, non-root uid 10001) and the no-cluster path (compose stack + bind-mounted `artifacts/`) |

Only KEDA comes from an upstream chart. The broker is ours, on the official
`rabbitmq:3.13-management` image, because Bitnami moved its index behind
`repo.broadcom.com` and emptied the free images (`CONSTITUTION.md` section 5).

## Invariants

- **Nothing is acked before `persist`.** Hence
  `terminationGracePeriodSeconds: 120` (> the 15-45 s task) and
  `cooldownPeriod: 300`, so scaling never kills work in flight.
- **KEDA owns the replica count.** `replicaCount: 0`; the Deployment only renders
  `replicas` when `keda.enabled=false`. `keda.mode: QueueLength` counts ready
  **+ unacked**, with `queueLength: "1"` = one pod per vacancy.
- **Credentials exist once.** `rabbitmq-credentials` is consumed by the broker
  StatefulSet, by the worker's `RABBITMQ_USERNAME`/`RABBITMQ_PASSWORD` env and by
  the KEDA `TriggerAuthentication` (never inline in the ScaledObject).
- **No secrets in values.** Use `existingSecret` (created by
  `scripts/worker-secret.ps1`); `secrets.create` is a dev-only shortcut.
- **Two different `keda:` keys on purpose**: the top-level one configures the KEDA
  **operator subchart**, `cv-tailoring-worker.keda` configures the worker's
  **ScaledObject**.
- **Helm 4 needs `index .Values "cv-tailoring-worker"`** for the dashed key, and
  every value a template reads needs a default in the chart's `values.yaml` or
  `helm lint` dies with a nil pointer.
- **`cv-tailoring-worker/templates/configmap.yaml` is the single values -> env
  mapping.** Adding a knob means `config.py` (+ `.env.example`), then
  `values.yaml`, `values.schema.json` and `configmap.yaml` - and a removed key
  must not stay in `values.schema.json`'s `required` list.

## Verification (never trust `helm lint` alone)

```sh
helm dependency update charts/cv-tailoring-platform   # first: a stale .tgz shadows file://../cv-tailoring-worker
helm lint charts/cv-tailoring-worker
helm lint charts/cv-tailoring-platform
helm template cv-tailoring charts/cv-tailoring-platform -f deploy/values/dev.yaml > rendered.yaml
kubeconform -strict -summary -ignore-missing-schemas -kubernetes-version 1.30.0 rendered.yaml
```

`helm lint` and `helm template` cannot see a null or invalid field value - that is
how `secretKeyRef.key: null` once shipped and was caught by `kubeconform`. Offline
validation is exactly this trio, because `kubectl apply --dry-run=client` needs a
live API. `.github/workflows/ci.yml` runs the same steps.

## Known inert / risky values

- `config.queueRetryTtlMs` is **inert**: the worker uses
  `RETRY_LADDER_SECONDS` (`CONSTITUTION.md` D5).
- `config.storageBackend` (set in `deploy/values/dev.yaml` and by
  `helm-smoke.yml`) is **inert**: no template renders `STORAGE_BACKEND` and
  `config.py` never reads it (`CONSTITUTION.md` D1).
- `config.modelName` ships as a placeholder; a wrong id is a non-retryable 400
  that would DLQ every task. Override it from `scripts/check_models.py --strict`.
- A live deploy is `scripts/local-deploy.ps1`; when it fails read
  `docs/RUNBOOK.md` before editing a template.
