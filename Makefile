# CV tailoring platform - developer entry points.
# Windows users without `make` can copy the commands from the README.

SHELL := /bin/bash
CHART_WORKER := charts/cv-tailoring-worker
CHART_PLATFORM := charts/cv-tailoring-platform
RELEASE ?= cv-tailoring
NAMESPACE ?= default
VALUES ?= deploy/values/dev.yaml
# The single supported runtime builds this image locally and runs it on Docker
# Desktop Kubernetes (see scripts/local-deploy.ps1) - no registry in the loop.
IMAGE_REPO ?= cv-tailoring-worker
IMAGE_TAG ?= dev

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------------------------------- #
# application
# --------------------------------------------------------------------------- #
.PHONY: install
install: ## Install runtime + dev dependencies
	pip install -r requirements-dev.txt

.PHONY: test
test: ## Run the test suite
	python -m pytest -q

.PHONY: lint
lint: ## Ruff lint
	python -m ruff check .

.PHONY: send-test-job
send-test-job: ## Publish one vacancy to the in-cluster broker (own port-forward)
	powershell -ExecutionPolicy Bypass -File scripts/send-test-job.ps1 -Smoke

.PHONY: docker-build
docker-build: ## Build the worker image
	docker build -t $(IMAGE_REPO):$(IMAGE_TAG) .

# --------------------------------------------------------------------------- #
# helm
# --------------------------------------------------------------------------- #
.PHONY: chart-deps
chart-deps: ## Resolve the umbrella chart dependencies (creates Chart.lock)
	helm dependency update $(CHART_PLATFORM)

.PHONY: chart-lint
chart-lint: ## Lint both charts
	helm lint $(CHART_WORKER)
	helm lint $(CHART_PLATFORM)

.PHONY: chart-template
chart-template: ## Render manifests locally (no cluster needed)
	helm template $(RELEASE) $(CHART_PLATFORM) -f $(VALUES) \
	  --set cv-tailoring-worker.image.tag=$(IMAGE_TAG) > /dev/null

.PHONY: local-deploy
local-deploy: ## Deploy everything into the local cluster (build + secret + helm)
	powershell -ExecutionPolicy Bypass -File scripts/local-deploy.ps1

.PHONY: storage-files
storage-files: ## List artifacts on the cluster volume (see -Action seed|download)
	powershell -ExecutionPolicy Bypass -File scripts/storage-files.ps1 -Action list

.PHONY: deploy
deploy: ## helm upgrade --install into the current kube-context
	helm upgrade --install $(RELEASE) $(CHART_PLATFORM) \
	  --namespace $(NAMESPACE) --create-namespace \
	  -f $(VALUES) \
	  --set cv-tailoring-worker.image.repository=$(IMAGE_REPO) \
	  --set cv-tailoring-worker.image.tag=$(IMAGE_TAG) \
	  --atomic --wait --timeout 10m

.PHONY: rollback
rollback: ## Roll back to the previous release revision
	helm rollback $(RELEASE) --namespace $(NAMESPACE)

.PHONY: status
status: ## Show pods, ScaledObject state and queue depth
	kubectl get pods,scaledobject -n $(NAMESPACE)
	kubectl exec -it rabbitmq-0 -n $(NAMESPACE) -- rabbitmqctl list_queues name messages messages_ready messages_unacknowledged

.PHONY: helm-test
helm-test: ## Run the chart's in-cluster probe
	helm test $(RELEASE) --namespace $(NAMESPACE)

.PHONY: worker-secret
worker-secret: ## Create the worker Secret from .env (never from git)
	powershell -ExecutionPolicy Bypass -File scripts/worker-secret.ps1

.PHONY: check-models
check-models: ## Verify MODEL_NAME against the models this Gemini key can use
	python scripts/check_models.py --strict

.PHONY: test-postgres
test-postgres: ## Production-store tests against the cluster Postgres (needs a port-forward)
	# kubectl port-forward svc/postgres 5432:5432   # in a second terminal
	TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt \
		python -m pytest -q tests/test_postgres_store.py
