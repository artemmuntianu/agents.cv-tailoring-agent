# Move files in and out of the cluster's `cv-artifacts` volume.
#
#   .\scripts\storage-files.ps1 -Action seed       # master CV + cv_data.json (+ any jd_*.txt)
#   .\scripts\storage-files.ps1 -Action list       # what is on the volume
#   .\scripts\storage-files.ps1 -Action download   # tailored results -> artifacts\output
#   .\scripts\storage-files.ps1 -Action shell      # interactive shell in the pod
#
# The worker scales to zero between batches, so this talks to the `cv-files`
# helper pod, which mounts the very same volume.
#
# Layout on the volume:
#   /data/cv_data.json    structured CV model (must match cv.docx exactly)
#   /data/input/cv.docx   master CV
#   /data/input/jd_*.txt  job descriptions (used by `python main.py` batches)
#   /data/output/*.docx   tailored documents (+ .pdf rendered by the worker)

[CmdletBinding()]
param(
    [ValidateSet('seed', 'list', 'download', 'shell')]
    [string]$Action = 'list',
    [string]$Namespace = 'default',
    [string]$AppLabel = 'cv-files',
    [string]$DataPath = '/data',
    [string]$CvFile = 'artifacts\input\cv.docx',
    [string]$CvDataFile = 'artifacts\cv_data.json',
    [string]$JdDir = 'artifacts\input',
    [string]$OutDir = 'artifacts\output'
)

$ErrorActionPreference = 'Stop'

function Say([string]$Text)  { Write-Host $Text }
function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Fail 'kubectl is not on PATH (it ships with Docker Desktop).'
}

$pod = (& kubectl get pods --namespace $Namespace -l ("app.kubernetes.io/name=" + $AppLabel) -o jsonpath='{.items[0].metadata.name}') 2>$null
if ([string]::IsNullOrWhiteSpace($pod)) {
    Fail ("no '" + $AppLabel + "' pod found in namespace " + $Namespace + ". Deploy first: .\scripts\local-deploy.ps1")
}
$target = $pod + ':' + $DataPath
Ok ("pod " + $pod)

function CopyToPod([string]$LocalPath, [string]$RemotePath) {
    if (-not (Test-Path $LocalPath)) { Fail ("local file not found: " + $LocalPath) }
    & kubectl cp --namespace $Namespace $LocalPath ($pod + ':' + $RemotePath)
    if ($LASTEXITCODE -ne 0) { Fail ("kubectl cp failed for " + $LocalPath) }
    Ok ("-> " + $RemotePath)
}

switch ($Action) {
    'seed' {
        & kubectl exec --namespace $Namespace $pod -- mkdir -p ($DataPath + '/input') ($DataPath + '/output') | Out-Null
        CopyToPod $CvFile        ($DataPath + '/input/cv.docx')
        CopyToPod $CvDataFile    ($DataPath + '/cv_data.json')
        if ((Test-Path $JdDir) -and (Test-Path (Join-Path $JdDir 'jd_*.txt'))) {
            Say 'job descriptions:'
            Get-ChildItem -Path (Join-Path $JdDir 'jd_*.txt') | ForEach-Object {
                CopyToPod $_.FullName ($DataPath + '/input/' + $_.Name)
            }
        } else {
            Warn ("no jd_*.txt found in " + $JdDir + ' (fine - publish over the queue instead)')
        }
        Say ''
        Say 'Verify the CV and its data model agree (the worker refuses to run if they do not):'
        Say '  kubectl exec ' + $pod + ' -- ls -l ' + $DataPath + ' ' + $DataPath + '/input'
    }
    'list' {
        & kubectl exec --namespace $Namespace $pod -- sh -c ("find " + $DataPath + ' -type f -exec ls -l {} \;')
    }
    'download' {
        $files = (& kubectl exec --namespace $Namespace $pod -- sh -c ("find " + $DataPath + '/output -type f -name "*.pdf" 2>/dev/null')) 2>$null
        if ([string]::IsNullOrWhiteSpace($files)) {
            Warn 'no PDFs on the volume yet'
            exit 0
        }
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        foreach ($file in ($files -split "`n")) {
            $name = Split-Path -Leaf $file.Trim()
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            & kubectl cp --namespace $Namespace ($pod + ':' + $file.Trim()) (Join-Path $OutDir $name)
            if ($LASTEXITCODE -eq 0) { Ok ("<- " + $name) }
        }
        Say ''
        Say ("saved to " + (Resolve-Path $OutDir))
    }
    'shell' {
        & kubectl exec -it --namespace $Namespace $pod -- sh
    }
}
