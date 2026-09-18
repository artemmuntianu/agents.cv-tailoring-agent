# CV tailoring platform - developer entry points.
# Windows users without `make` can copy the commands from the README.

SHELL := /bin/bash
CHART_WORKER := charts/cv-tailoring-worker
CHART_PLATFORM := charts/cv-tailoring-platform
RELEASE ?= cv-tailoring
NAMESPACE ?= default
VALUES ?= deploy/values/dev.yaml
IMAGE_REPO ?= ghcr.io/artemmuntianu/agents-cv-tailoring-agent/cv-tailoring-worker
IMAGE_TAG ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

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

.PHONY: healthcheck
healthcheck: ## Probe the local runtime (render tools, dirs)
	python healthcheck.py --mode all || true

.PHONY: publish
publish: ## Publish every jd_*.txt in artifacts/input to the configured queue
	python publisher.py --all

.PHONY: worker-once
worker-once: ## Drain the queue once, then exit
	python worker.py --once

.PHONY: compose-up
compose-up: ## Start RabbitMQ + Postgres locally
	docker compose up -d rabbitmq postgres

.PHONY: compose-down
compose-down: ## Stop the local stack
	docker compose down

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

.PHONY: dev-secret
dev-secret: ## Create the Kubernetes Secret from .env (GEMINI key, DB, Supabase)
	bash scripts/dev-secret.sh

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

.PHONY: prod-secrets
prod-secrets: ## Create the three production Secrets from .env (never from git)
	bash scripts/prod-secrets.sh

.PHONY: check-models
check-models: ## Verify MODEL_NAME against the models this Gemini key can use
	python scripts/check_models.py --strict

.PHONY: test-postgres
test-postgres: ## Run the production-store tests against the local Postgres
	TEST_DATABASE_URL=postgresql://cvt:cvt@localhost:5432/cvt \
		python -m pytest -q tests/test_postgres_store.py

# --------------------------------------------------------------------------- #
# infrastructure
# --------------------------------------------------------------------------- #
.PHONY: cluster-create
cluster-create: ## Create the AKS cluster (system + workload pools)
	bash scripts/create-cluster.sh

.PHONY: cluster-delete
cluster-delete: ## Delete the resource group
	az group delete -n rg-cvtailoring --yes --no-wait

.PHONY: kind-create
kind-create: ## Create a local kind cluster for dev/CI
	kind create cluster --name cvtailoring
