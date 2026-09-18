# Create the worker's Kubernetes Secret from .env (values never touch git).
# The broker credentials are NOT here: the chart injects RABBITMQ_USERNAME /
# RABBITMQ_PASSWORD from the same Secret KEDA uses, so the password lives in one
# place only.
#
#   .\scripts\worker-secret.ps1
#   .\scripts\worker-secret.ps1 -DatabaseUrl 'postgresql://cvt:cvt@postgres:5432/cvt?sslmode=disable'
#   .\scripts\worker-secret.ps1 -Name staging-secrets -Namespace staging
#   .\scripts\worker-secret.ps1 -DryRun        # print what it would create

[CmdletBinding()]
param(
    [string]$Namespace = 'default',
    [string]$Name = 'cv-tailoring-secrets',
    [string]$EnvFile = '.env',
    [string]$DatabaseUrl = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Fail 'kubectl is not on PATH. It ships with Docker Desktop (enable Kubernetes first).'
}

if (-not (Test-Path $EnvFile)) {
    Fail "$EnvFile not found - copy .env.example to .env and fill it in."
}

# --- read .env (simple KEY=VALUE parser) ---------------------------------- #
$settings = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }
    if ($trimmed.StartsWith('#')) { continue }
    $index = $trimmed.IndexOf('=')
    if ($index -lt 1) { continue }
    $settings[$trimmed.Substring(0, $index).Trim()] = $trimmed.Substring($index + 1).Trim()
}

# Real environment variables win over the file, so CI can override.
foreach ($key in @('GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL')) {
    $fromEnv = [Environment]::GetEnvironmentVariable($key)
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { $settings[$key] = $fromEnv }
}
if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) { $settings['DATABASE_URL'] = $DatabaseUrl }

$missing = @()
foreach ($required in @('GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL')) {
    if ([string]::IsNullOrWhiteSpace($settings[$required])) { $missing += $required }
}
if ($missing.Count -gt 0) {
    Fail ("missing in " + $EnvFile + ": " + ($missing -join ', '))
}
Ok 'GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL present'

if ($settings['DATABASE_URL'] -match 'postgres\.supabase\.co' ) { Ok 'database looks like Supabase' }
elseif ($settings['DATABASE_URL'] -notmatch 'sslmode=') {
    Warn 'DATABASE_URL has no sslmode parameter; for the in-cluster Postgres use ?sslmode=disable'
}

$kubectlArgs = @(
    'create', 'secret', 'generic', $Name,
    '--namespace', $Namespace,
    '--from-literal=GEMINI_API_KEY=' + $settings['GEMINI_API_KEY'],
    '--from-literal=SUPABASE_URL=' + $settings['SUPABASE_URL'],
    '--from-literal=SUPABASE_SERVICE_ROLE_KEY=' + $settings['SUPABASE_SERVICE_ROLE_KEY'],
    '--from-literal=DATABASE_URL=' + $settings['DATABASE_URL'],
    '--dry-run=client', '-o', 'yaml'
)

if ($DryRun) {
    # Never echo the values themselves.
    Write-Host 'would create Secret:'
    Write-Host ("  name      : " + $Name)
    Write-Host ("  namespace : " + $Namespace)
    Write-Host '  keys      : GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL'
    Write-Host ("  db host   : " + (($settings['DATABASE_URL'] -split '@')[-1]))
    exit 0
}

$manifest = & kubectl @kubectlArgs
if ($LASTEXITCODE -ne 0) { Fail 'could not render the Secret (is the cluster running?)' }
$manifest | kubectl apply -f - | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'kubectl apply failed' }

Ok ("Secret '" + $Name + "' applied in namespace " + $Namespace)
Write-Host ''
Write-Host 'Next:'
Write-Host '  helm upgrade --install cv-tailoring charts/cv-tailoring-platform -f deploy/values/dev.yaml --wait'
