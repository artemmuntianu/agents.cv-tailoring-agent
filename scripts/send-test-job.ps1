# Send a vacancy from YOUR machine to the in-cluster broker.
#
# This tool exists because the two obvious ways of doing it fail silently:
#
#   1. `publisher.py` defaults to QUEUE_BACKEND=directory. Setting RABBITMQ_URL
#      alone does NOT switch the backend, so the message lands in
#      artifacts\queue\*.json and the cluster never sees it.
#   2. The `rabbitmq-url` in the broker Secret points at the in-cluster DNS name
#      (rabbitmq.<ns>.svc.cluster.local), which the host cannot resolve. The URL
#      has to be rebuilt against localhost through a port-forward.
#
# It also refuses to run before the preconditions a task needs (platform
# deployed, master CV on the volume) are met, because a missing /data/cv_data.json
# burns queue attempts for nothing.
#
#   .\scripts\send-test-job.ps1                              # first jd_*.txt
#   .\scripts\send-test-job.ps1 -Jd artifacts\input\jd_1.txt
#   .\scripts\send-test-job.ps1 -Jd artifacts\input\jd_1.txt -Smoke
#   .\scripts\send-test-job.ps1 -All                         # costs Gemini quota
#   .\scripts\send-test-job.ps1 -DryRun                      # print, change nothing
#
# Prerequisites: .\scripts\local-deploy.ps1, then
#                .\scripts\storage-files.ps1 -Action seed

[CmdletBinding()]
param(
    [string]$Jd = '',
    [switch]$All,
    [switch]$Smoke,
    [string]$SmokeName = 'smoke_test',
    [string]$Namespace = 'default',
    [string]$Release = 'cv-tailoring',
    [string]$Secret = 'rabbitmq-credentials',
    [int]$LocalPort = 5672,
    [int]$TimeoutSeconds = 60,
    [switch]$KeepForward,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Say([string]$Text)  { Write-Host $Text }
function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Invoke-External([string]$File, [string[]]$Arguments) {
    # PowerShell 5.1 + $ErrorActionPreference='Stop' turns ANY stderr output of a
    # native command (helm's "release: not found", kubectl's "command terminated
    # with exit code 1") into a terminating error, which would abort the script
    # before it can explain what is missing. Relax the preference for the call and
    # report the exit code instead of throwing.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $text = (& $File @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

foreach ($tool in @('kubectl', 'helm', 'python')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail ("$tool is not on PATH. Install it, then open a NEW terminal.")
    }
}
Ok 'kubectl, helm, python found'

if ($Namespace -ne 'default') {
    Warn ("namespace '" + $Namespace + "': the ScaledObject host is pinned to " +
        'rabbitmq.default.svc.cluster.local (deploy/values/dev.yaml), so KEDA will ' +
        'not wake the worker. Deploy to `default` or override ' +
        'cv-tailoring-worker.keda.host.')
}

# --- which vacancy? --------------------------------------------------------- #
$inputDir = Join-Path $repoRoot 'artifacts\input'

if ($All) {
    $jdPaths = @(Get-ChildItem -Path (Join-Path $inputDir 'jd_*.txt') |
        Sort-Object Name | ForEach-Object { $_.FullName })
    if ($jdPaths.Count -eq 0) { Fail ("no jd_*.txt in " + $inputDir) }
}
elseif ($Jd) {
    $resolved = $Jd
    if (-not [System.IO.Path]::IsPathRooted($resolved)) { $resolved = Join-Path $repoRoot $resolved }
    if (-not (Test-Path -LiteralPath $resolved)) { Fail ("JD not found: " + $resolved) }
    $jdPaths = @($resolved)
}
else {
    $jdPaths = @(Get-ChildItem -Path (Join-Path $inputDir 'jd_*.txt') |
        Sort-Object Name | ForEach-Object { $_.FullName } | Select-Object -First 1)
    if ($jdPaths.Count -eq 0) { Fail ("no jd_*.txt in " + $inputDir + ' - pass -Jd <file>') }
}

if ($Smoke) {
    if ($All) { Fail '-Smoke publishes one vacancy - drop -All' }
    # A fresh external_id, so the result (cv_<id>.pdf) cannot be confused with a
    # document an earlier local run already wrote into artifacts\output.
    $smokePath = Join-Path $inputDir ('jd_' + $SmokeName + '.txt')
    if (-not $DryRun) {
        Copy-Item -LiteralPath $jdPaths[0] -Destination $smokePath -Force
    }
    Say ("smoke vacancy: " + $smokePath + " (external_id '" + $SmokeName + "')")
    $jdPaths = @($smokePath)
}

if ($DryRun) {
    Say ''
    Say 'DRY RUN - nothing was changed. This is what a real run would do:'
    Say ('  1. helm status ' + $Release + ' -n ' + $Namespace + '   (is the platform deployed?)')
    Say '  2. cv-files pod: test -f /data/input/cv.docx and /data/cv_data.json'
    Say ('  3. kubectl port-forward svc/rabbitmq ' + $LocalPort + ':5672   (reused when already open)')
    Say ('  4. read rabbitmq-username/password from Secret ' + $Secret +
        ' -> amqp://<user>:<password>@localhost:' + $LocalPort + '/%2F')
    Say '  5. $env:QUEUE_BACKEND=amqp  and  $env:RABBITMQ_URL=<that url>'
    foreach ($jobPath in $jdPaths) { Say ('  6. python publisher.py --jd ' + $jobPath) }
    Say '  7. restore the previous session env, stop the port-forward'
    exit 0
}

# --- preconditions (fail before spending anything) -------------------------- #
$helmStatus = Invoke-External 'helm' @('status', $Release, '--namespace', $Namespace)
if ($helmStatus.Code -ne 0) {
    Fail ("release '" + $Release + "' is not installed in namespace " + $Namespace +
        ' - run .\scripts\local-deploy.ps1 first')
}
Ok ("release " + $Release + " is installed")

$filesPod = (Invoke-External 'kubectl' @(
    'get', 'pods', '--namespace', $Namespace,
    '-l', 'app.kubernetes.io/name=cv-files',
    '-o', 'jsonpath={.items[0].metadata.name}')).Text
if ([string]::IsNullOrWhiteSpace($filesPod)) {
    Fail 'no cv-files pod - the platform is not deployed yet (.\scripts\local-deploy.ps1)'
}

$hasCv = (Invoke-External 'kubectl' @(
    'exec', '--namespace', $Namespace, $filesPod, '--', 'test', '-f', '/data/input/cv.docx')).Code -eq 0
$hasData = (Invoke-External 'kubectl' @(
    'exec', '--namespace', $Namespace, $filesPod, '--', 'test', '-f', '/data/cv_data.json')).Code -eq 0
if (-not ($hasCv -and $hasData)) {
    Warn ("volume check: /data/input/cv.docx=" + $hasCv + " /data/cv_data.json=" + $hasData)
    Fail 'the artifact volume has no master CV - run .\scripts\storage-files.ps1 -Action seed first'
}
Ok 'master cv.docx and cv_data.json are on the volume'

$userB64 = (Invoke-External 'kubectl' @(
    'get', 'secret', $Secret, '--namespace', $Namespace,
    '-o', 'jsonpath={.data.rabbitmq-username}')).Text
$passB64 = (Invoke-External 'kubectl' @(
    'get', 'secret', $Secret, '--namespace', $Namespace,
    '-o', 'jsonpath={.data.rabbitmq-password}')).Text
if ([string]::IsNullOrWhiteSpace($userB64) -or [string]::IsNullOrWhiteSpace($passB64)) {
    Fail ("Secret '" + $Secret + "' has no rabbitmq-username/rabbitmq-password keys")
}
$brokerUser = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($userB64))
$brokerPass = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($passB64))
# The Secret's own rabbitmq-url names the cluster DNS, which the host cannot
# resolve - rebuild it against the port-forward. Never print the password.
$brokerUrl = 'amqp://' + $brokerUser + ':' + $brokerPass + '@localhost:' + $LocalPort + '/%2F'
Ok ("broker credentials read (user " + $brokerUser + ", password masked)")

# --- port-forward ----------------------------------------------------------- #
$previousUrl = $env:RABBITMQ_URL
$previousBackend = $env:QUEUE_BACKEND
$forward = $null

try {
    if (Test-LocalPort $LocalPort) {
        Ok ("something is already listening on localhost:" + $LocalPort + " - reusing it")
    }
    else {
        $logOut = Join-Path $env:TEMP ('cv-port-forward-' + [guid]::NewGuid().ToString('N') + '.log')
        $logErr = Join-Path $env:TEMP ('cv-port-forward-' + [guid]::NewGuid().ToString('N') + '.err')
        $forward = Start-Process -FilePath 'kubectl' -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $logOut -RedirectStandardError $logErr `
            -ArgumentList @('port-forward', 'svc/rabbitmq', ($LocalPort.ToString() + ':5672'),
                            '--namespace', $Namespace)
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not (Test-LocalPort $LocalPort)) {
            if ((Get-Date) -gt $deadline) {
                if ((Test-Path $logErr) -and (Get-Content $logErr -Raw).Trim().Length -gt 0) {
                    Warn (Get-Content $logErr -Raw).Trim()
                }
                Fail ("port-forward did not come up within " + $TimeoutSeconds + 's')
            }
            Start-Sleep -Milliseconds 500
        }
        Ok ("port-forward up: localhost:" + $LocalPort + " -> svc/rabbitmq:5672")
    }

    # --- publish ------------------------------------------------------------ #
    $env:QUEUE_BACKEND = 'amqp'
    $env:RABBITMQ_URL = $brokerUrl

    $publisherArgs = @('publisher.py')
    if ($All) {
        $publisherArgs += '--all'
    }
    else {
        foreach ($jobPath in $jdPaths) { $publisherArgs += @('--jd', $jobPath) }
    }
    $published = Invoke-External 'python' $publisherArgs
    if ($published.Text) { Say $published.Text }
    if ($published.Code -ne 0) { Fail 'publisher.py failed' }

    Say ''
    Say 'Watch the worker wake up (expect 0 -> 1 -> 0 once the queue drains):'
    Say '  kubectl get pods -w'
    Say '  kubectl logs -f -l app.kubernetes.io/name=cv-tailoring-worker --tail=100'
    Say 'Pull the result back:'
    Say '  .\scripts\storage-files.ps1 -Action download'
}
finally {
    if ($forward) {
        if ($KeepForward) {
            Say ''
            Say ('port-forward left running (pid ' + $forward.Id + ') - stop it with: Stop-Process -Id ' + $forward.Id)
        }
        else {
            Stop-Process -Id $forward.Id -Force -ErrorAction SilentlyContinue
            Ok 'port-forward stopped'
        }
    }
    # Do not leak credentials or a backend switch into the rest of the session.
    if ($previousUrl) { $env:RABBITMQ_URL = $previousUrl } else { Remove-Item Env:RABBITMQ_URL -ErrorAction SilentlyContinue }
    if ($previousBackend) { $env:QUEUE_BACKEND = $previousBackend } else { Remove-Item Env:QUEUE_BACKEND -ErrorAction SilentlyContinue }
}
