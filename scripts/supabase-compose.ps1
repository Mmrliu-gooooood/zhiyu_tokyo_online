[CmdletBinding()]
param(
  [ValidateSet('Config', 'Build', 'Start', 'Apply', 'Readiness', 'Status')]
  [string]$Action = 'Config',
  [ValidateSet(4, 8, 16)]
  [int]$CapacityTier = 4,
  [ValidateSet('Background', 'Foreground')]
  [string]$GenerationMode = 'Background',
  [string]$EnvFile = '.env.hosted.local',
  [switch]$AcceptJobs,
  [switch]$ConfirmWrites,
  [switch]$VideoExport
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'docker-compose.supabase.yml'
$dnsComposeFile = Join-Path $repoRoot 'docker-compose.dns.local.yml'
$envPath = if ([IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $repoRoot $EnvFile }
$baseEnvPath = Join-Path $repoRoot '.env.local'

if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
  throw 'docker-compose.supabase.yml is missing.'
}
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw 'Private Supabase env file is missing. Copy .env.hosted.example to .env.hosted.local.'
}
if ((Test-Path -LiteralPath $dnsComposeFile) -and -not (Test-Path -LiteralPath $dnsComposeFile -PathType Leaf)) {
  throw 'docker-compose.dns.local.yml must be a regular file when present.'
}

# Check names only. Secret values remain private to Docker Compose and are never
# printed or loaded into a PowerShell object by this launcher. The protected
# feature/model settings remain in .env.local; the hosted file overrides only
# Supabase-specific settings. Compose still passes only its explicit allowlist
# into each container, never the whole settings file.
$declaredNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$envPaths = @()
if (Test-Path -LiteralPath $baseEnvPath -PathType Leaf) { $envPaths += $baseEnvPath }
$envPaths += $envPath
foreach ($candidatePath in $envPaths) {
  foreach ($line in [IO.File]::ReadLines($candidatePath)) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=') {
      [void]$declaredNames.Add($Matches[1])
    }
  }
}
$requiredNames = @(
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'DATABASE_URL_APP_WEB',
  'DATABASE_LISTEN_URL_APP_WEB',
  'WORKER_DATABASE_URL',
  'DATABASE_LISTEN_URL',
  'SUPABASE_DB_SSL_ROOT_CERT_PATH',
  'MEDIA_CONFIG_ENCRYPTION_KEY',
  'GENERATION_MODEL_ENCRYPTION_KEY',
  'PRO_MODEL_ENCRYPTION_KEY',
  'GENERATION_SESSION_SECRET',
  'ASSET_S3_BUCKET',
  'ASSET_S3_ENDPOINT',
  'ASSET_S3_REGION',
  'ASSET_S3_ACCESS_KEY_ID',
  'ASSET_S3_SECRET_ACCESS_KEY',
  'MATERIAL_S3_BUCKET',
  'CLASSROOM_S3_BUCKET'
)
$missing = @($requiredNames | Where-Object {
    -not $declaredNames.Contains($_) -and -not [Environment]::GetEnvironmentVariable($_, 'Process')
  })
if ($missing.Count -gt 0) {
  throw "Private env file is missing required setting names: $($missing -join ', ')"
}

if ($AcceptJobs -and -not $ConfirmWrites) {
  throw 'Refusing to open the write gate. Re-run with both -AcceptJobs and -ConfirmWrites after migration verification.'
}
if ($Action -in @('Start', 'Apply') -and $GenerationMode -eq 'Foreground' -and (-not $AcceptJobs -or -not $ConfirmWrites)) {
  throw 'Foreground generation writes require both -AcceptJobs and -ConfirmWrites.'
}
if ($Action -in @('Start', 'Apply') -and -not $AcceptJobs -and $GenerationMode -eq 'Background') {
  Write-Warning 'Starting with GENERATION_ACCEPTING_JOBS=0. Do not send user traffic during migration/verification.'
}

$tierSettings = switch ($CapacityTier) {
  4 { @{ APP_HEAVY_TASK_LIMIT = '4'; OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT = '4'; GENERATION_WORKER_CONCURRENCY = '2'; GENERATION_LLM_MAX_INFLIGHT = '4' } }
  8 { @{ APP_HEAVY_TASK_LIMIT = '8'; OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT = '8'; GENERATION_WORKER_CONCURRENCY = '4'; GENERATION_LLM_MAX_INFLIGHT = '8' } }
  16 { @{ APP_HEAVY_TASK_LIMIT = '16'; OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT = '16'; GENERATION_WORKER_CONCURRENCY = '8'; GENERATION_LLM_MAX_INFLIGHT = '16' } }
}

$overrides = @{
  # Compose 5 may race while creating the same project container/network from
  # parallel service convergence. Serial convergence is deterministic and has
  # no effect on runtime concurrency.
  COMPOSE_PARALLEL_LIMIT = '1'
  OPENMAIC_CAPACITY_TIER = [string]$CapacityTier
  GENERATION_ACCEPTING_JOBS = if ($AcceptJobs) { '1' } else { '0' }
  GENERATION_BACKGROUND_ENABLED = if ($GenerationMode -eq 'Foreground') { '0' } else { '1' }
}
foreach ($entry in $tierSettings.GetEnumerator()) { $overrides[$entry.Key] = $entry.Value }

$previous = @{}
foreach ($entry in $overrides.GetEnumerator()) {
  $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
}

try {
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is required.' }

  $compose = @(
    'compose',
    '--project-name', 'openmaic-supabase'
  )
  foreach ($candidatePath in $envPaths) { $compose += @('--env-file', $candidatePath) }
  $compose += @('-f', $composeFile)
  # Reuse the operator's local DNS override for every deployment operation.
  # Without it, recreating the hosted stack silently restores Docker's flaky
  # default resolver even when the legacy launcher already uses this override.
  if (Test-Path -LiteralPath $dnsComposeFile -PathType Leaf) {
    $compose += @('-f', $dnsComposeFile)
  }
  if ($VideoExport) { $compose += @('--profile', 'video-export') }

  switch ($Action) {
    'Config' {
      & docker @compose config --quiet
    }
    'Build' {
      $services = @('openmaic', 'generation-worker')
      if ($VideoExport) { $services += 'render-service' }
      foreach ($service in $services) {
        & docker @compose build $service
        if ($LASTEXITCODE -ne 0) { throw "Supabase compose build failed: $service" }
      }
    }
    'Start' {
      # Never stop or replace the legacy project. A localhost:3000 conflict is
      # surfaced by Compose for the operator to resolve explicitly.
      $services = @('openmaic', 'generation-worker')
      if ($VideoExport) { $services += 'render-service' }
      # Build large images sequentially. Parallel BuildKit exports can exhaust
      # Docker Desktop's VM and leave a partially-updated stack behind.
      # Stop only this Compose project's services first so the 8 GiB local VM
      # has enough headroom for Next.js compilation. Containers and volumes are
      # retained, and the legacy zhiyu project is never addressed here.
      & docker @compose stop --timeout 45 @services
      if ($LASTEXITCODE -ne 0) { throw 'Supabase compose stop-before-build failed' }
      foreach ($service in $services) {
        & docker @compose build $service
        if ($LASTEXITCODE -ne 0) { throw "Supabase compose build failed: $service" }
      }
      & docker @compose up -d --no-build --scale generation-worker=2 @services
    }
    'Apply' {
      # Apply runtime/Compose settings to existing images. This avoids a full
      # Next.js rebuild for DNS or capacity changes; source/build-time changes
      # still require Start. Compose only recreates services whose config changed.
      $services = @('openmaic', 'generation-worker')
      if ($VideoExport) { $services += 'render-service' }
      & docker @compose up -d --no-build --scale generation-worker=2 @services
    }
    'Readiness' {
      # Worker container healthchecks prove each replica's own heartbeat. This
      # aggregate probe independently proves both recent heartbeats, schemas,
      # database access and private asset/material bucket reachability.
      & docker @compose run --rm --no-deps supabase-readiness
    }
    'Status' {
      & docker @compose ps
    }
  }
  if ($LASTEXITCODE -ne 0) { throw "Supabase compose action failed: $Action" }
}
finally {
  foreach ($entry in $previous.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}
