# Put the *genuine* Calibri family into `apps/worker/fonts/`, so `docker build` can bake it
# into the worker image and LibreOffice stops substituting it.
#
#   .\scripts\fetch-fonts.ps1                   # copy from C:\Windows\Fonts
#   .\scripts\fetch-fonts.ps1 -Source D:\fonts  # from a font dump instead
#   .\scripts\fetch-fonts.ps1 -DryRun           # print the plan, write nothing
#
# Why it exists: Carlito is metric-compatible with Calibri but has no *Light* weight, so
# the master CV's heading runs (`asciiTheme="majorHAnsi"`) rendered in DejaVu Sans -
# different metrics, a PDF Word would never produce (CONSTITUTION.md D15). Only the real
# outlines fix that. Calibri is Microsoft-licensed: the files stay in the untracked
# `apps/worker/fonts/` (gitignored) and are never committed or
# published inside the image.

[CmdletBinding()]
param(
    [string]$Source,
    [string]$Destination,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Say([string]$Text)  { Write-Host $Text }
function Ok([string]$Text)   { Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [fail] $Text" -ForegroundColor Red; exit 1 }

# The four body faces plus the two Light faces the CV's headings need.
$requiredFonts = @(
    @{ Name = 'calibri.ttf';   Role = 'Calibri regular (CV body)' },
    @{ Name = 'calibrib.ttf';  Role = 'Calibri bold' },
    @{ Name = 'calibrii.ttf';  Role = 'Calibri italic' },
    @{ Name = 'calibriz.ttf';  Role = 'Calibri bold italic' },
    @{ Name = 'calibril.ttf';  Role = 'Calibri Light (CV headings)' },
    @{ Name = 'calibrili.ttf'; Role = 'Calibri Light italic' }
)

if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path $repoRoot 'apps\worker\fonts'
}
if ([string]::IsNullOrWhiteSpace($Source)) {
    # A stripped environment drops %WINDIR%, and Join-Path would then build a path out of
    # an empty string - fall back to the well-known location instead.
    $systemRoot = $env:SystemRoot
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { $systemRoot = 'C:\Windows' }
    $Source = Join-Path $systemRoot 'Fonts'
}

Say ''
Say ('source      : ' + $Source)
Say ('destination : ' + $Destination)
if ($DryRun) { Say 'dry run     : nothing will be written' }
Say ''

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Fail ("'" + $Source + "' is not a directory. Pass -Source <dir holding calibri*.ttf>.")
}
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    if ($DryRun) {
        Ok ('would create ' + $Destination)
    } else {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Ok ('created ' + $Destination)
    }
}

$missing = @()
$copied = 0
foreach ($font in $requiredFonts) {
    $from = Join-Path $Source $font.Name
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) {
        $missing += $font.Name
        Warn ('absent at the source: ' + $font.Name + ' - ' + $font.Role)
        continue
    }
    $sizeBytes = (Get-Item -LiteralPath $from).Length
    if ($sizeBytes -lt 102400) {
        Fail ($font.Name + ' is ' + $sizeBytes + ' bytes - too small to be a font file.')
    }
    $sizeMb = [math]::Round($sizeBytes / 1MB, 2)
    if ($DryRun) {
        Ok ('would copy ' + $font.Name + ' (' + $sizeMb + ' MB)')
    } else {
        Copy-Item -LiteralPath $from -Destination (Join-Path $Destination $font.Name) -Force
        Ok ('copied ' + $font.Name + ' (' + $sizeMb + ' MB)')
    }
    $copied++
}

Say ''
if ($missing.Count -gt 0) {
    Warn ('missing: ' + ($missing -join ', '))
    Warn 'Not fatal - the image still builds, but LibreOffice then falls back to Carlito'
    Warn '(body, metrically identical) or DejaVu Serif (Calibri Light, different metrics),'
    Warn 'so the rendered PDF differs from Word. That is D15.'
} elseif (-not $DryRun) {
    Ok ($copied.ToString() + ' of ' + $requiredFonts.Count + ' files in ' + $Destination)
}
Say ''
Warn 'Calibri is Microsoft-licensed: apps\worker\fonts\*.ttf is gitignored, so never commit it'
Warn 'and never publish an image built with it.'
Say ''
Say 'Next:'
Say '  .\scripts\local-deploy.ps1     # rebuild the image with the fonts baked in'
Say '  docker run --rm cv-tailoring-worker:dev fc-match "Calibri Light"'
