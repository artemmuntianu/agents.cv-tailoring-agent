# Deploy the whole platform into YOUR OWN Kubernetes - no cloud, no cost.
#
#   .\scripts\local-deploy.ps1                  # build image, secret, deploy, wait
#   .\scripts\local-deploy.ps1 -SkipBuild       # redeploy an existing image
#   .\scripts\local-deploy.ps1 -Uninstall       # remove the release
#
# Prerequisites (one time):
#   1. Docker Desktop  ->  Settings -> Kubernetes -> "Enable Kubernetes" -> Apply
#   2. winget install Helm.Helm      (then open a NEW terminal)
#
# What runs where after this:
#   in your cluster : RabbitMQ (pod rabbitmq-0), KEDA, Postgres, the AI worker
#   external, free  : only the Gemini API (the LLM that rewrites your CV)

[CmdletBinding()]
param(
    [string]$Release   = 'cv-tailoring',
    [string]$Namespace = 'default',
    [string]$Values    = 'deploy/values/dev.yaml',
    [string]$Image     = 'cv-tailoring-worker:dev',
    [string]$LocalDbUrl = 'postgresql://cvt:cvt@postgres:5432/cvt?sslmode=disable',
    [switch]$SkipBuild,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Say([string]$Text)  { Write-Host $Text }
function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }
function Step([string]$Text) { Write-Host ''; Write-Host ("== " + $Text) -ForegroundColor Cyan }

Step '1. tools'
foreach ($tool in @('docker', 'kubectl', 'helm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail ("$tool is not on PATH." + ' Install it, then open a NEW terminal. helm: winget install Helm.Helm')
    }
}
Ok 'docker, kubectl, helm found'

Step '2. Docker daemon'
& docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail 'Docker Desktop is not running. Start it, wait for "Engine running", then re-run.'
}
Ok 'Docker engine is up'

Step '3. Kubernetes context'
$context = (& kubectl config current-context) 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($context)) {
    Fail 'No kubectl context. Enable Kubernetes in Docker Desktop (Settings -> Kubernetes).'
}
Ok ("context: " + $context)
if ($context -notmatch 'docker-desktop|kind-|k3d-|minikube') {
    Warn 'This does not look like a local cluster - check `kubectl config get-contexts`.'
}
& kubectl cluster-info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'The cluster is not reachable (is Kubernetes started in Docker Desktop?)' }
Ok 'cluster reachable'

if ($Uninstall) {
    Step 'uninstall'
    helm uninstall $Release --namespace $Namespace 2>$null | Out-Null
    Ok ("release '" + $Release + "' removed (PersistentVolumeClaims are kept)")
    Say 'Delete the data volumes too with: kubectl delete pvc -l app.kubernetes.io/part-of=cv-tailoring-platform'
    exit 0
}

Step '4. build the worker image'
if ($SkipBuild) {
    Warn 'skipped (-SkipBuild)'
} else {
    & docker build -t $Image .
    if ($LASTEXITCODE -ne 0) { Fail 'docker build failed' }
    Ok ("image built: " + $Image)
}

Step '5. make the image visible to the cluster'
if ($context -like 'kind-*') {
    & kind load docker-image $Image --name ($context -replace '^kind-', '')
    Ok 'loaded into kind'
} elseif ($context -like 'k3d-*') {
    & k3d image import $Image -c ($context -replace '^k3d-', '')
    Ok 'imported into k3d'
} else {
    Ok 'nothing to do: a local single-node cluster shares the Docker image store'
}

Step '6. chart dependencies'
& helm dependency update charts/cv-tailoring-platform | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'helm dependency update failed (network needed for the Bitnami/KEDA charts)' }
Ok 'Chart.lock resolved'

Step '7. worker Secret (from .env)'
& (Join-Path $PSScriptRoot 'worker-secret.ps1') -Namespace $Namespace -DatabaseUrl $LocalDbUrl
if ($LASTEXITCODE -ne 0) { Fail 'could not create the worker Secret' }

Step '8. deploy'
& helm upgrade --install $Release charts/cv-tailoring-platform `
    --namespace $Namespace --create-namespace `
    -f $Values `
    --set cv-tailoring-worker.image.repository=(($Image -split ':')[0]) `
    --set cv-tailoring-worker.image.tag=(($Image -split ':')[1]) `
    --set cv-tailoring-worker.image.pullPolicy=IfNotPresent `
    --wait --timeout 10m
if ($LASTEXITCODE -ne 0) { Fail 'helm install failed - inspect with: kubectl get pods' }
Ok 'release deployed'

Step '9. status'
kubectl get pods,scaledobject
Say ''
Say 'Put your CV on the cluster volume (once):'
Say '  .\scripts\storage-files.ps1 -Action seed'
Say '  (expects artifacts\input\cv.docx and artifacts\cv_data.json, or pass -CvFile / -CvDataFile)'
Say ''
Say 'Watch the workers wake up and go back to sleep:'
Say '  kubectl get pods -w'
Say '  (send a job with: kubectl port-forward svc/rabbitmq 5672:5672  then)'
Say '  $env:RABBITMQ_URL=(kubectl get secret rabbitmq-credentials -o jsonpath={.data.rabbitmq-url} | %{[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_))})'
Say '  python publisher.py --jd your_job.txt'
Say ''
Say 'Tear down:   .\scripts\local-deploy.ps1 -Uninstall'
