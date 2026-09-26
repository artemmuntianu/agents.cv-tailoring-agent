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
#   /data/input/jd_*.txt  job descriptions (seeded here for reference; the queue
#                         message itself carries the description)
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

function Invoke-External([string]$File, [string[]]$Arguments) {
    # PowerShell 5.1 + $ErrorActionPreference='Stop' turns any stderr output of a
    # native command (kubectl's jsonpath "array index out of bounds" when no pod
    # exists, "command terminated with exit code 1", "not found") into a TERMINATING
    # error: the script used to die with a raw NativeCommandError instead of
    # printing its own [fail] guidance. Capture the exit code and BOTH streams
    # instead (the text is what makes a failure diagnosable).
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = (& $File @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
    Fail 'kubectl is not on PATH (it ships with Docker Desktop).'
}

$labelSelector = 'app.kubernetes.io/name=' + $AppLabel
$pod = (Invoke-External 'kubectl' @(
    'get', 'pods', '--namespace', $Namespace,
    '-l', $labelSelector,
    '-o', 'jsonpath={.items[0].metadata.name}')).Text
if ([string]::IsNullOrWhiteSpace($pod)) {
    Fail ("no '" + $AppLabel + "' pod found in namespace " + $Namespace + ". Deploy first: .\scripts\local-deploy.ps1")
}
$target = $pod + ':' + $DataPath
Ok ("pod " + $pod)

function CopyToPod([string]$LocalPath, [string]$RemotePath) {
    if (-not (Test-Path -LiteralPath $LocalPath)) { Fail ("local file not found: " + $LocalPath) }
    # `kubectl cp` reads 'C:' as a pod name, so an absolute Windows path fails with
    # "one of src or dest must be a local file specification" - hand it over
    # relative to the current directory instead.
    $local = $LocalPath
    if ($local -match '^[A-Za-z]:') {
        $full = (Resolve-Path -LiteralPath $LocalPath).Path
        $cwd = (Get-Location).Path
        if ($full.StartsWith($cwd, [StringComparison]::OrdinalIgnoreCase)) {
            $local = $full.Substring($cwd.Length).TrimStart('\')
        }
    }
    $target = $pod + ':' + $RemotePath
    $copy = Invoke-External 'kubectl' @('cp', '--namespace', $Namespace, $local, $target)
    if ($copy.Code -ne 0) {
        if ($copy.Text) { Warn $copy.Text }
        Fail ("kubectl cp failed for " + $LocalPath)
    }
    Ok ("-> " + $RemotePath)
}

switch ($Action) {
    'seed' {
        $inputPath = $DataPath + '/input'
        $outputPath = $DataPath + '/output'
        $mkdir = Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $pod, '--', 'mkdir', '-p', $inputPath, $outputPath)
        if ($mkdir.Code -ne 0) { Fail 'could not create the volume directories' }
        CopyToPod $CvFile        ($inputPath + '/cv.docx')
        CopyToPod $CvDataFile    ($DataPath + '/cv_data.json')
        if ((Test-Path $JdDir) -and (Test-Path (Join-Path $JdDir 'jd_*.txt'))) {
            Say 'job descriptions:'
            Get-ChildItem -Path (Join-Path $JdDir 'jd_*.txt') | ForEach-Object {
                CopyToPod (Join-Path $JdDir $_.Name) ($inputPath + '/' + $_.Name)
            }
        } else {
            Warn ("no jd_*.txt found in " + $JdDir + ' (fine - publish over the queue instead)')
        }
        Say ''
        Say 'Verify the CV and its data model agree (the worker refuses to run if they do not):'
        Say '  kubectl exec ' + $pod + ' -- ls -l ' + $DataPath + ' ' + $DataPath + '/input'
    }
    'list' {
        $findAll = 'find ' + $DataPath + ' -type f -exec ls -l {} \;'
        $listing = Invoke-External 'kubectl' @('exec', '--namespace', $Namespace, $pod, '--', 'sh', '-c', $findAll)
        Say $listing.Text
    }
    'download' {
        $findPdfs = 'find ' + $DataPath + '/output -type f -name "*.pdf" 2>/dev/null'
        $files = (Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $pod, '--', 'sh', '-c', $findPdfs)).Text
        if ([string]::IsNullOrWhiteSpace($files)) {
            Warn 'no PDFs on the volume yet'
            exit 0
        }
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        foreach ($file in ($files -split "`n")) {
            $remote = $file.Trim()
            $name = Split-Path -Leaf $remote
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            $source = $pod + ':' + $remote
            $fetch = Invoke-External 'kubectl' @('cp', '--namespace', $Namespace, $source, (Join-Path $OutDir $name))
            if ($fetch.Code -eq 0) { Ok ("<- " + $name) }
        }
        Say ''
        Say ("saved to " + (Resolve-Path $OutDir))
    }
    'shell' {
        # Deliberately NOT captured: an interactive TTY needs the real console.
        & kubectl exec -it --namespace $Namespace $pod -- sh
    }
}
