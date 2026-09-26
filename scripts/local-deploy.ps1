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

function Invoke-External([string]$File, [string[]]$Arguments) {
    # PowerShell 5.1 + $ErrorActionPreference='Stop' turns ANY stderr output of a
    # native command into a terminating error - including `kubectl get crd`
    # reporting "No resources found" on an empty cluster. Capture the exit code and
    # the output instead of letting the script die mid-step.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = (& $File @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

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
if ($context -notmatch 'docker-desktop') {
    Warn ("context '" + $context + "': this project targets Docker Desktop Kubernetes only" +
        ' (Settings -> Kubernetes -> kubeadm). A cluster with its own image store will not' +
        ' see the locally built image.')
}
& kubectl cluster-info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'The cluster is not reachable (is Kubernetes started in Docker Desktop?)' }
Ok 'cluster reachable'

if ($Namespace -ne 'default') {
    Warn ("namespace '" + $Namespace + "': the worker ScaledObject pins KEDA's RabbitMQ " +
        'management host to rabbitmq.default.svc.cluster.local, so the worker will never ' +
        'scale up. Deploy into `default`, or override ' +
        'cv-tailoring-worker.keda.host from the values file.')
}

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

Step '5. image visibility'
# Docker Desktop's kubeadm cluster shares Docker's image store, so the image built
# above is already visible to the kubelet - nothing to load. That shared store is
# exactly why Docker Desktop is the only supported runtime: kind/k3d/minikube nodes
# keep their own store and would need the image imported into them.
$nodeNames = ((& kubectl get nodes -o jsonpath='{.items[*].metadata.name}') 2>$null)
$nodes = @($nodeNames -split '\s+' | Where-Object { $_ })
if ($nodes.Count -gt 0) { Ok ("node(s): " + ($nodes -join ', ')) }
Ok 'shared image store - the freshly built image is already in-cluster'

Step '6. chart dependencies'
& helm dependency update charts/cv-tailoring-platform | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'helm dependency update failed (network needed for the KEDA chart)' }
Ok 'Chart.lock resolved'

Step '7. worker Secret (from .env)'
& (Join-Path $PSScriptRoot 'worker-secret.ps1') -Namespace $Namespace -DatabaseUrl $LocalDbUrl
if ($LASTEXITCODE -ne 0) { Fail 'could not create the worker Secret' }

Step '8. deploy'
# PowerShell 5.1 splits a native argument that contains '=(' into two tokens
# ('key=' plus the parenthesised value), so the --set values are computed first and
# interpolated. Without this, helm receives 4 positionals and dies with
# '"helm upgrade" requires 2 arguments'.
$imageRepository = ($Image -split ':')[0]
$imageTag = ($Image -split ':')[1]

# KEDA ships its CRDs as *templates* (keda/templates/crds/...), and Helm builds
# every object of a release BEFORE creating any of them - so a ScaledObject in the
# same release as its CRD can never be mapped ("no matches for kind ScaledObject").
# The very first install therefore runs in two phases: phase 1 installs everything
# with the worker disabled (which puts the CRDs in the cluster, owned by this
# release), phase 2 adds the worker and its ScaledObject. On every later deploy the
# CRDs already exist and the worker must NOT be disabled in between (that would
# delete the Deployment and kill in-flight tasks), so phase 1 is skipped.
$scaledObjectCrdPresent = $false
$clusterCrds = (Invoke-External 'kubectl' @('get', 'crd')).Text
if ($clusterCrds | Select-String -SimpleMatch 'scaledobjects.keda.sh') { $scaledObjectCrdPresent = $true }

if ($scaledObjectCrdPresent) {
    Ok 'KEDA CRDs already in the cluster - single-step install'
} else {
    Say '  first install: phase 1/2 installs the platform and the KEDA CRDs (no worker yet)'
    & helm upgrade --install $Release charts/cv-tailoring-platform `
        --namespace $Namespace --create-namespace `
        -f $Values `
        --set "cv-tailoring-worker.image.repository=$imageRepository" `
        --set "cv-tailoring-worker.image.tag=$imageTag" `
        --set cv-tailoring-worker.image.pullPolicy=IfNotPresent `
        --set cv-tailoring-worker.enabled=false `
        --wait --timeout 10m
    if ($LASTEXITCODE -ne 0) { Fail 'helm install failed (phase 1: platform + CRDs) - inspect with: kubectl get pods' }
    Ok 'KEDA CRDs installed; phase 2/2 adds the worker'
}

& helm upgrade --install $Release charts/cv-tailoring-platform `
    --namespace $Namespace --create-namespace `
    -f $Values `
    --set "cv-tailoring-worker.image.repository=$imageRepository" `
    --set "cv-tailoring-worker.image.tag=$imageTag" `
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
Say 'Send one vacancy from your machine (the script opens its own port-forward,'
Say 'selects the amqp backend and verifies the master CV is on the volume):'
Say '  .\scripts\send-test-job.ps1 -Smoke'
Say ''
Say 'Watch the worker wake up and go back to sleep:'
Say '  kubectl get pods -w'
Say ''
Say 'Tear down:   .\scripts\local-deploy.ps1 -Uninstall'
