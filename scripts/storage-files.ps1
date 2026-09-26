# Move files in and out of the cluster's `cv-artifacts` volume.
#
#   .\scripts\storage-files.ps1 -Action seed       # master CV + cv_data.json (+ any jd_*.txt)
#   .\scripts\storage-files.ps1 -Action list       # what is on the volume
#   .\scripts\storage-files.ps1 -Action download   # tailored PDFs + DOCX -> artifacts\output
#   .\scripts\storage-files.ps1 -Action path       # print OUTPUT_DIR=... for backoffice/.env
#   .\scripts\storage-files.ps1 -Action purge      # delete the artifacts a removal queued
#   .\scripts\storage-files.ps1 -Action shell      # interactive shell in the pod
#
# `path` is the alternative to mirroring: Docker Desktop keeps its PersistentVolumes on the
# VM's disk, and Windows reaches that disk through WSL. Pointing the board's OUTPUT_DIR at it
# means the board reads the worker's own files directly - nothing is copied, and a removal
# deletes the real file (see backoffice/src/lib/artifacts.ts).
#
# `purge` finishes what the board cannot do itself: removing a vacancy deletes its database
# row and the files it can reach, and queues every stored path it could not
# (`artifact_purge`, written by `POST /api/board/remove`). This action runs `rm -f` for each
# queued path inside the `cv-files` pod and clears the queue.
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
    [ValidateSet('seed', 'list', 'download', 'path', 'purge', 'shell')]
    [string]$Action = 'list',
    [string]$Namespace = 'default',
    [string]$AppLabel = 'cv-files',
    [string]$DataPath = '/data',
    # `-Action path` only: the PVC to locate, the WSL distro Docker Desktop runs the cluster
    # in, and the volume subdirectory the tailored documents live in.
    [string]$PvcName = 'cv-artifacts',
    [string]$WslDistro = 'docker-desktop',
    [string]$VolumeSubPath = 'output',
    [string]$CvFile = 'artifacts\input\cv.docx',
    [string]$CvDataFile = 'artifacts\cv_data.json',
    [string]$JdDir = 'artifacts\input',
    [string]$OutDir = 'artifacts\output',
    # `purge` reads the queue from the cluster's Postgres; these default to the dev values.
    # The pod is named through its deployment, because `kubectl exec postgres` would look for
    # a *pod* called exactly that (the manifest calls it `postgres-<hash>`).
    [string]$PgTarget = 'deploy/postgres',
    [string]$DbUser = 'cvt',
    [string]$Database = 'cvt'
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

if ($Action -ne 'path') {
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
}

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
    'path' {
        # Where the cluster's PersistentVolume lives on THIS machine. Docker Desktop keeps its
        # PVs on the VM's disk, and Windows reaches that disk through the WSL distro, so the
        # board can read the worker's own documents with no mirror and no extra server.
        # `kubectl -o json` + ConvertFrom-Json, NOT a jsonpath with `=="name"` in it: PowerShell
        # 5.1 mangles the embedded double quotes on the way to a native command (trap 13), and
        # kubectl then reports "error parsing".
        $pvJson = (Invoke-External 'kubectl' @('get', 'pv', '-o', 'json')).Text
        $candidates = @()
        if ($pvJson) {
            $candidates = @(($pvJson | ConvertFrom-Json).items | Where-Object { $_.spec.claimRef.name -eq $PvcName })
        }
        $volume = ($candidates | Where-Object { $_.spec.claimRef.namespace -eq $Namespace } | Select-Object -First 1)
        if (-not $volume) { $volume = $candidates | Select-Object -First 1 }
        $hostPath = $volume.spec.hostPath.path
        if (-not $hostPath) {
            Fail ("no PersistentVolume for PVC '" + $PvcName + "' in namespace " + $Namespace + " - deploy first: .\scripts\local-deploy.ps1")
        }
        Ok ("pv host path: " + $hostPath)

        if ($hostPath -notmatch '^/var/lib/k8s-pvs/') {
            Warn 'this cluster does not use the Docker Desktop hostpath layout'
            Warn 'mirror the volume instead: .\scripts\storage-files.ps1 -Action download'
            exit 1
        }

        # `wsl` emits UTF-16 unless told otherwise, which PowerShell 5.1 renders as garbage.
        $env:WSL_UTF8 = '1'
        $diskRoots = (Invoke-External 'wsl' @(
            '-d', $WslDistro, '-e', 'sh', '-c',
            'find / -maxdepth 5 -name k8s-pvs -type d 2>/dev/null | head -1')).Text
        $diskRoot = (($diskRoots -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
        if (-not $diskRoot) {
            Fail ("could not find the k8s-pvs directory inside the '" + $WslDistro + "' WSL distro - is the cluster running?")
        }
        Ok ("distro path: " + $diskRoot)

        $tail = ($hostPath -replace '^/var/lib/k8s-pvs/', '') -replace '/', '\'
        $outputDir = '\\wsl$\' + $WslDistro + ($diskRoot -replace '/', '\') + '\' + $tail + '\' + $VolumeSubPath
        $artifactRoot = Split-Path -Parent $outputDir

        if (Test-Path -LiteralPath $outputDir) {
            $count = (Get-ChildItem -LiteralPath $outputDir -File | Measure-Object).Count
            Ok ("readable from the host: " + $count + ' file(s) in ' + $VolumeSubPath)
        } else {
            Warn ("not readable yet: " + $outputDir)
            Warn 'check the PVC name (-PvcName) and that the worker has written at least one artifact'
        }

        Say ''
        Say 'Add to backoffice\.env (machine-specific, gitignored), then restart the dev server:'
        Say ''
        Say ('  ARTIFACTS_DIR=' + $artifactRoot)
        Say ('  OUTPUT_DIR=' + $outputDir)
        Say ''
        Say 'The board then reads the worker''s own volume: nothing is copied, and removing a'
        Say 'vacancy deletes the real file. Re-run this action if the PVC is ever recreated.'
    }
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
        # Both artifact kinds: the board serves the tailored PDF **and** the DOCX, so mirroring
        # only the PDFs left the DOCX link with nothing to resolve (fixed 2026-09-26).
        $findArtifacts = 'find ' + $DataPath + '/output -type f \( -name "*.pdf" -o -name "*.docx" \) 2>/dev/null'
        $files = (Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $pod, '--', 'sh', '-c', $findArtifacts)).Text
        if ([string]::IsNullOrWhiteSpace($files)) {
            Warn 'no PDFs or DOCX on the volume yet'
            exit 0
        }
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        $saved = 0
        foreach ($file in ($files -split "`n")) {
            $remote = $file.Trim()
            $name = Split-Path -Leaf $remote
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            $source = $pod + ':' + $remote
            $fetch = Invoke-External 'kubectl' @('cp', '--namespace', $Namespace, $source, (Join-Path $OutDir $name))
            if ($fetch.Code -eq 0) { Ok ("<- " + $name); $saved++ }
        }
        Say ''
        Say ($saved.ToString() + ' artifact(s) mirrored to ' + (Resolve-Path $OutDir))
    }
    'purge' {
        # The board queues what it could not delete (see POST /api/board/remove). Delete those
        # paths inside this pod - the one place that sees the real volume - then clear the queue.
        $rows = Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $PgTarget, '--',
            'psql', '-U', $DbUser, '-d', $Database, '-t', '-A',
            '-c', 'select stored_path from artifact_purge order by queued_at')
        if ($rows.Code -ne 0) {
            Fail ('could not read artifact_purge from ' + $PgTarget + ': ' + $rows.Text)
        }

        $paths = @($rows.Text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($paths.Count -eq 0) {
            Ok 'nothing queued - no removed vacancy left files on the volume'
            exit 0
        }

        Say ('queued for deletion: ' + $paths.Count + ' file(s)')
        foreach ($path in $paths) { Say ('  - ' + $path) }

        # Single quotes only: stored paths come from the worker (job ids pass the DB shape
        # guard), so they cannot carry a quote or a space that would need escaping.
        $command = 'rm -f ' + (($paths | ForEach-Object { "'" + $_ + "'" }) -join ' ')
        $removed = Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $pod, '--', 'sh', '-c', $command)
        if ($removed.Code -ne 0) {
            Fail ('could not delete the queued files: ' + $removed.Text)
        }

        $cleared = Invoke-External 'kubectl' @(
            'exec', '--namespace', $Namespace, $PgTarget, '--',
            'psql', '-U', $DbUser, '-d', $Database, '-c', 'delete from artifact_purge')
        if ($cleared.Code -ne 0) {
            Warn ('files deleted, but the queue could not be cleared: ' + $cleared.Text)
        } else {
            Ok ('queue cleared: ' + $cleared.Text)
        }

        Say ''
        Say 'Check what is left with -Action list'
    }
    'shell' {
        # Deliberately NOT captured: an interactive TTY needs the real console.
        & kubectl exec -it --namespace $Namespace $pod -- sh
    }
}
