param(
    [string]$Topic,
    [string]$TopicFile,
    [ValidateRange(1, 20)][int]$Rounds = 6,
    [ValidateSet("both", "agy")][string]$Engine = "agy",
    [string]$OpenCodeModel = "openai/gpt-6-luna-fast",
    [string]$AgyModel,
    [string]$ProposerModel = "gemini-3.8-flash-low",
    [string]$CriticModel = "gemini-3.8-flash-low",
    [switch]$Detached,
    [switch]$ServerOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot "data"
$HealthUrl = "http://127.0.0.1:4599/health"
$ServerStdOut = Join-Path $DataRoot "server.stdout.log"
$ServerStdErr = Join-Path $DataRoot "server.stderr.log"

Push-Location $ProjectRoot
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "La compilación falló con código $LASTEXITCODE" }
    $healthy = $false
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        $healthy = $health.ok -eq $true
    } catch { }

    if (-not $healthy) {
        $node = (Get-Command node.exe).Source
        Start-Process -FilePath $node -ArgumentList @("dist/server.js") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $ServerStdOut -RedirectStandardError $ServerStdErr | Out-Null
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
                if ($health.ok -eq $true) { $healthy = $true; break }
            } catch { }
        }
    }

    if (-not $healthy) { throw "El servidor no inició. Revisa $ServerStdErr" }
    Write-Host "Servidor MCP disponible: $HealthUrl"

    if ($ServerOnly) { return }
    if ([string]::IsNullOrWhiteSpace($Topic) -and [string]::IsNullOrWhiteSpace($TopicFile)) {
        Write-Host 'Uso: .\scripts\start-debate.ps1 -Topic "Tema" [-Rounds 6] [-Engine both|agy] [-Detached]'
        Write-Host '     .\scripts\start-debate.ps1 -TopicFile .\tema.txt [-Rounds 6] [-Engine agy] [-Detached]'
        return
    }
    if (-not [string]::IsNullOrWhiteSpace($Topic) -and -not [string]::IsNullOrWhiteSpace($TopicFile)) {
        throw "Usa -Topic o -TopicFile, no ambos."
    }

    if ($TopicFile) {
        $InputFile = (Resolve-Path -LiteralPath $TopicFile).Path
    } else {
        $InputFile = Join-Path $DataRoot ("topic-{0}.txt" -f [guid]::NewGuid().ToString("N"))
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($InputFile, $Topic, $Utf8NoBom)
    }

    $RunLog = Join-Path $DataRoot "autopilot.log"
    $RunOut = Join-Path $DataRoot "autopilot.stdout.log"
    $RunErr = Join-Path $DataRoot "autopilot.stderr.log"
    $NodeExe = (Get-Command node.exe).Source

    $PreviousOpenCodeModel = $env:OPENCODE_MODEL
    $PreviousAgyModel = $env:AGY_MODEL
    if ($OpenCodeModel) { $env:OPENCODE_MODEL = $OpenCodeModel }
    if ($AgyModel) { $env:AGY_MODEL = $AgyModel }
    try {
        $NodeArgs = @("dist\autopilot.js", "--topic-file", $InputFile, "--rounds", "$Rounds", "--log-file", $RunLog, "--engine", $Engine)
        if ($Engine -eq "agy") {
            $SelectedCriticModel = if ($AgyModel) { $AgyModel } else { $CriticModel }
            $NodeArgs += @("--proposer-model", $ProposerModel, "--critic-model", $SelectedCriticModel)
        } elseif ($AgyModel) {
            $NodeArgs += @("--critic-model", $AgyModel)
        }
        if ($Detached) {
            $Arguments = @('"dist\autopilot.js"', '--topic-file', ('"{0}"' -f $InputFile), '--rounds', "$Rounds", '--log-file', ('"{0}"' -f $RunLog), '--engine', $Engine)
            if ($Engine -eq "agy") {
                $SelectedCriticModel = if ($AgyModel) { $AgyModel } else { $CriticModel }
                $Arguments += @('--proposer-model', $ProposerModel, '--critic-model', $SelectedCriticModel)
            } elseif ($AgyModel) {
                $Arguments += @('--critic-model', $AgyModel)
            }
            $Process = Start-Process -FilePath $NodeExe -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $RunOut -RedirectStandardError $RunErr -PassThru
            Write-Host "Debate lanzado en segundo plano (PID $($Process.Id))."
            Write-Host "Progreso: $RunLog"
            Write-Host "Errores:  $RunErr"
        } else {
            & $NodeExe @NodeArgs
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    } finally {
        $env:OPENCODE_MODEL = $PreviousOpenCodeModel
        $env:AGY_MODEL = $PreviousAgyModel
    }
} finally {
    Pop-Location
}
