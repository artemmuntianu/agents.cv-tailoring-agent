# Create the AKS cluster (system pool + 0..N workload pool) and wire the ACR.
# Native PowerShell - no bash/WSL needed on Windows.
#
#   .\scripts\create-cluster.ps1                       # checks + create
#   .\scripts\create-cluster.ps1 -WorkloadMaxNodes 1   # cheapest cluster
#   .\scripts\create-cluster.ps1 -DryRun               # checks only, changes nothing
#
# Cost: the system pool is always on (~USD 30/month for B2s). Stop paying for
# nodes when idle:
#   az aks stop  -n <cluster> -g <rg>
#   az aks start -n <cluster> -g <rg>

[CmdletBinding()]
param(
    [string]$ResourceGroup  = 'rg-cvtailoring',
    [string]$ClusterName    = 'cvtailoring',
    [string]$Location       = 'westeurope',
    [string]$AcrName        = '',                    # globally unique, [a-z0-9]
    [string]$SystemVmSize   = 'Standard_B2s',        # 2 vCPU / 4 GB, always on
    [string]$WorkloadVmSize = 'Standard_D2s_v5',     # 2 vCPU / 8 GB, autoscaled
    [int]$WorkloadMaxNodes  = 2,
    [switch]$DryRun
)

# az prints a cp1252 warning on non-ASCII output; treat stderr as data, not death.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandUseErrorActionPreference = $false }

function Say([string]$Text)  { Write-Host $Text }
function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }

function Invoke-Az {
    <# Runs az with stderr captured, so warnings never corrupt the JSON on
       stdout and only a non-zero exit code counts as failure. #>
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $errFile = [System.IO.Path]::GetTempFileName()
    # Windows PowerShell 5.1 raises a terminating error for *any* native stderr
    # write while ErrorActionPreference is Stop (az warns about cp1252 output on
    # Cyrillic subscription names), so relax it for the duration of the call.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & az @Arguments 2> $errFile
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    try {
        if ($code -ne 0) {
            $errText = (Get-Content -Raw $errFile) -replace '\s+', ' '
            throw ("az {0} failed (exit {1}): {2}" -f ($Arguments -join ' '), $code, $errText.Trim())
        }
        return $output
    } finally {
        Remove-Item -Force $errFile -ErrorAction SilentlyContinue
    }
}

$BicepFile = (Resolve-Path (Join-Path $PSScriptRoot '..\deploy\infra\aks.bicep')).Path

Say '== 1. az CLI ========================================================='
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Fail 'az is not on PATH. Open a NEW terminal (the installer edits PATH).'
}
$azInfo = (Invoke-Az @('version', '-o', 'json')) | ConvertFrom-Json
Ok ("az " + $azInfo.'azure-cli')

Say '== 2. login / subscription =========================================='
try {
    $account = (Invoke-Az @('account', 'show', '-o', 'json')) | ConvertFrom-Json
} catch {
    Fail 'Not logged in. Run:  az login --use-device-code'
}
Ok "user        : $($account.user.name)"
Ok "subscription: $($account.name) ($($account.id))"
Ok "tenant      : $($account.tenantId)"
if ($account.state -ne 'Enabled') {
    Fail "Subscription state is '$($account.state)'. Pick an enabled one: az account set -s <id>"
}

Say '== 3. provider registration ========================================='
$provider = (Invoke-Az @('provider', 'show', '-n', 'Microsoft.ContainerService', '--query', 'registrationState', '-o', 'tsv')).Trim()
if ($provider -eq 'Registered') {
    Ok 'Microsoft.ContainerService is registered'
} else {
    Warn "Microsoft.ContainerService is '$provider' - AKS cannot be created until it is Registered."
    Say '  registering now (free, takes 1-2 minutes)...'
    Invoke-Az @('provider', 'register', '-n', 'Microsoft.ContainerService', '-o', 'none') | Out-Null
    $deadline = (Get-Date).AddMinutes(5)
    do {
        Start-Sleep -Seconds 15
        $provider = (Invoke-Az @('provider', 'show', '-n', 'Microsoft.ContainerService', '--query', 'registrationState', '-o', 'tsv')).Trim()
        Say "  state: $provider"
    } while ($provider -ne 'Registered' -and (Get-Date) -lt $deadline)
    if ($provider -eq 'Registered') {
        Ok 'registration finished'
    } else {
        Fail 'registration did not finish within 5 minutes - re-run this script, or register in the Portal.'
    }
}

Say '== 4. region + quota ================================================'
$usage = (Invoke-Az @('vm', 'list-usage', '--location', $Location, '-o', 'json')) | ConvertFrom-Json
$cores = $usage | Where-Object { $_.name.value -eq 'cores' }
if ($cores) { Say "  total regional vCPUs: $($cores.currentValue) used / $($cores.limit) allowed" }

$familyMap = @{
    'standardBSFamily'    = $SystemVmSize
    'standardDSv5Family'  = $WorkloadVmSize
    'standardDv5Family'   = $WorkloadVmSize
    'standardDASv5Family' = $WorkloadVmSize
}
$needed = @{}
$needed[$SystemVmSize]   = 2
$needed[$WorkloadVmSize] = 2
$found = @{}
foreach ($u in $usage) {
    if ($familyMap.ContainsKey($u.name.value)) { $found[$familyMap[$u.name.value]] = $u }
}
foreach ($vm in $needed.Keys) {
    if ($found.ContainsKey($vm)) {
        $f = $found[$vm]
        if ($f.limit -lt $needed[$vm]) {
            Warn "quota for $vm is only $($f.limit) vCPU (need $($needed[$vm]))."
            Warn 'Raise it in Portal -> Subscriptions -> Usage + quotas, or retry with'
            Warn '-WorkloadVmSize Standard_B2s.'
        } else {
            Ok "$vm quota: $($f.currentValue)/$($f.limit) vCPU"
        }
    } else {
        Warn "no quota entry reported for $vm in $Location - continuing"
    }
}

Say '== 5. ACR name ======================================================'
if ([string]::IsNullOrWhiteSpace($AcrName)) {
    $suffix = -join ((48..57) + (97..122) | Get-Random -Count 5 | ForEach-Object { [char]$_ })
    $AcrName = "cvtailoring$suffix"
    Say "  generated a globally unique name: $AcrName"
}
if ($AcrName.Length -lt 5 -or $AcrName.Length -gt 50 -or $AcrName -notmatch '^[a-z0-9]+') {
    Fail 'ACR names must be 5-50 chars, lowercase letters and digits only.'
}
Ok "ACR: $AcrName"

Say '== 6. plan =========================================================='
Say "  resource group : $ResourceGroup ($Location)"
Say "  cluster        : $ClusterName"
Say "  system pool    : 1 x $SystemVmSize (always on, nodepool=system, tainted)"
Say "  workload pool  : $WorkloadVmSize, autoscaled 0..$WorkloadMaxNodes (nodepool=workload)"
Say "  bicep          : $BicepFile"

if ($DryRun) {
    Say ''
    Ok 'Dry run finished - drop -DryRun to actually create the cluster.'
    exit 0
}

Say '== 7. deploy ========================================================'
try { Invoke-Az @('bicep', 'version') | Out-Null } catch { Invoke-Az @('bicep', 'install') | Out-Null }

Invoke-Az @('group', 'create', '--name', $ResourceGroup, '--location', $Location, '-o', 'none') | Out-Null
Ok 'resource group ready'

$deploymentName = 'cv-tailoring-' + (Get-Date -Format yyyyMMddHHmmss)
$acrLoginServer = Invoke-Az @(
    'deployment', 'group', 'create',
    '--resource-group', $ResourceGroup,
    '--name', $deploymentName,
    '--template-file', $BicepFile,
    '--parameters',
    "clusterName=$ClusterName",
    "location=$Location",
    "acrName=$AcrName",
    "systemNodeSize=$SystemVmSize",
    "userNodeSize=$WorkloadVmSize",
    "userMaxCount=$WorkloadMaxNodes",
    '--query', 'properties.outputs.acrLoginServer.value',
    '-o', 'tsv'
)
Ok "ACR ready: $acrLoginServer"

Say '== 8. kubectl context + registry pull ==============================='
Invoke-Az @('aks', 'get-credentials', '--resource-group', $ResourceGroup, '--name', $ClusterName, '--overwrite-existing', '-o', 'none') | Out-Null
Ok 'kubectl context updated'
Invoke-Az @('aks', 'update', '--resource-group', $ResourceGroup, '--name', $ClusterName, '--attach-acr', $AcrName, '-o', 'none') | Out-Null
Ok 'cluster may pull images from the ACR'

Say '== 9. nodes ========================================================='
kubectl get nodes -L nodepool

Say ''
Ok 'Cluster ready.'
Say ''
Say 'Next, in this order:'
Say "  a) image (no local Docker needed):"
Say "       az acr build --registry $AcrName --image cv-tailoring-worker:v1 ."
Say '  b) helm:      winget install Helm.Helm   (then open a NEW terminal)'
Say '  c) secrets:   .\scripts\prod-secrets.ps1'
Say "  d) deploy:    helm dependency update charts/cv-tailoring-platform"
Say "       (then run the helm upgrade line printed by prod-secrets.ps1)"
Say ''
Say "Save money when idle:  az aks stop -n $ClusterName -g $ResourceGroup"
