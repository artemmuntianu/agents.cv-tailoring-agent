# Runbook

Operational procedures for the event-driven deployment. All commands assume
`NAMESPACE=default` and release `cv-tailoring` (adjust as needed).

## Daily checks

```bash
kubectl get pods,scaledobject
kubectl exec -it rabbitmq-0 -- rabbitmqctl list_queues name messages messages_ready messages_unacknowledged
psql "$DATABASE_URL" -c "select status, count(*) from resumes group by status order by 2 desc;"
```

Healthy signs: worker replicas `0` when idle (scale-to-zero works), `Ready`
depth rises with a batch and returns to 0, `messages_unacknowledged` ≤ max
replicas, and the DLQ stays at 0.

## Queue is backing up (messages_ready grows, workers stay at 0)

1. `kubectl get scaledobject cv-tailoring-cv-tailoring-worker -o yaml | grep -A5 status`
   — look for `Ready`/`Active` conditions and scaler errors.
2. Verify the management API the scaler uses:
   `kubectl exec -it rabbitmq-0 -- rabbitmqctl status | head`
   `curl -u "$USER:$PASS" http://rabbitmq.default.svc.cluster.local:15672/api/queues/%2F/resumes.generate`
3. If the metrics endpoint is broken, the `fallback.replicas` value keeps at
   least one worker running; raise it temporarily:
   `helm upgrade ... --set cv-tailoring-worker.keda.fallback.replicas=3`
4. Check the `TriggerAuthentication` secret exists in the same namespace:
   `kubectl get secret rabbitmq-credentials -o jsonpath='{.data.rabbitmq-password}' | base64 -d`

## Workers keep restarting (CrashLoopBackOff)

```bash
kubectl logs -l app.kubernetes.io/component=ai-worker --previous --tail=100
```
The worker refuses to start when preflight fails (by design — fail fast):

| Symptom | Cause | Fix |
|---|---|---|
| `missing render tool(s): ...` | image built without poppler/libreoffice | rebuild from `Dockerfile` |
| `GEMINI_API_KEY`/`DATABASE_URL` missing | Secret not created | `make worker-secret` |
| `DATABASE_URL is not set` | missing Secret key | same as above |
| `MODEL_NAME=... is not available for this API key` | placeholder model id | `python scripts/check_models.py --strict`, then set the real ids via `--set cv-tailoring-worker.config.modelName=...` |
| `prepared statement ... does not exist` / pooler errors | prepared statements against a pooled endpoint | keep `DB_PREPARE_STATEMENTS=false` (default) |
| liveness probe fails | `/tmp/cvt` not writable (fsGroup) | check `podSecurityContext` |

## Dead-letter queue

```bash
# inspect without consuming
kubectl exec -it rabbitmq-0 -- rabbitmqadmin --username="$U" --password="$P" \
  get queue=resumes.generate.dlq count=5 ackmode=ack_requeue_true

# replay everything after fixing the root cause
kubectl exec -it rabbitmq-0 -- sh -c 'rabbitmqadmin --username="$U" --password="$P" \
  queue=... ' # or via the management UI: Queues -> resumes.generate.dlq -> Move messages
```
Requeue target: `resumes.generate`. Bump `cv_version` if the master CV changed.

## Gemini quota exhausted (429 / daily RPD)

* The retry path is automatic: each failing model is written to
  `model_availability` (shared ledger), the next preferred model is tried, and an
  exhausted quota routes the message to a TTL retry queue with the row marked
  `rate_limited`.
* Inspect: `psql "$DATABASE_URL" -c "select * from model_availability;"`
* Force a clean slate:
  `psql "$DATABASE_URL" -c "delete from model_availability;" \
   -c "update app_settings set value='{\"current_model\":\"gemini-3.5-flash\"}' where key='model_state';"`
* Cap the blast radius per batch:
  `--set cv-tailoring-worker.keda.maxReplicaCount=5`.

## Rotate a secret

All three Secrets in one idempotent step (values come from `.env`, never git):

```bash
powershell -ExecutionPolicy Bypass -File scripts/worker-secret.ps1   # or: make worker-secret
kubectl rollout restart deploy/ai-agent-worker
```

```bash
kubectl create secret generic cv-tailoring-secrets \
  --from-literal=GEMINI_API_KEY=... --from-literal=DATABASE_URL=... \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/ai-agent-worker
```

## Scale / cost controls

| Goal | Setting |
|---|---|
| hard cap on parallel spend | `cv-tailoring-worker.keda.maxReplicaCount` |
| stop all new work | `kubectl scale scaledobject ... --replicas=0` (or suspend KEDA autoscaling) |
| drain the queue faster | raise `maxReplicaCount` and `keda.queueLength` (e.g. `"2"` = 1 pod / 2 messages) |
| keep pods warm (latency) | `keda.minReplicaCount=1` (costs money at idle) |

## Rollback

```bash
helm history cv-tailoring
helm rollback cv-tailoring            # previous revision
helm rollback cv-tailoring <rev>      # specific revision
kubectl rollout status deploy/ai-agent-worker
```

Charts are `--atomic`: a failed upgrade already rolls itself back. In-flight
tasks are safe either way — the message is only acked after `persist`.
