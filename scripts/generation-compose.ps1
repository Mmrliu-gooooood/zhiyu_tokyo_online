param([ValidateSet('check','build','migrate','start-app','start-worker','stop-worker','status')][string]$Action = 'check')
$ErrorActionPreference = 'Stop'

function Get-SourceRevision {
  $revision = (& git rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $revision) { throw 'Unable to resolve the source revision.' }
  return ($revision -join '').Trim()
}

function Get-ReleaseImageRecord([string]$ImageName, [string]$ExpectedRevision) {
  $rawImage = & docker image inspect $ImageName 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Release image $ImageName is missing." }
  # PowerShell variable names are case-insensitive. Keep the inspected object in
  # a distinctly named variable so it cannot overwrite the $ImageName parameter.
  $imageMetadata = @(($rawImage -join "`n") | ConvertFrom-Json)[0]
  $revision = $imageMetadata.Config.Labels.'org.opencontainers.image.revision'
  if ($revision -ne $ExpectedRevision) {
    throw "Release image $ImageName does not match source revision $ExpectedRevision."
  }
  return [pscustomobject]@{
    image = $ImageName
    imageId = $imageMetadata.Id
    sourceRevision = $revision
  }
}

function Write-ReleaseImageRecords([string]$ExpectedRevision) {
  @(
    Get-ReleaseImageRecord 'zhiyu:latest' $ExpectedRevision
    Get-ReleaseImageRecord 'zhiyu-worker:latest' $ExpectedRevision
  ) | ConvertTo-Json -Compress
}

function Wait-GenerationWorkerHealthy {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $health = & docker inspect zhiyu-worker --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and ($health -join '').Trim() -eq 'healthy') { return }
    Start-Sleep -Seconds 2
  }
  throw 'Generation worker did not publish a fresh database heartbeat within 40 seconds.'
}

function Write-ContainerReleaseRecord([string]$Name, [string]$ExpectedRevision) {
  $rawContainer = & docker inspect $Name 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Release container $Name is missing." }
  $container = @(($rawContainer -join "`n") | ConvertFrom-Json)[0]
  $revision = $container.Config.Labels.'org.opencontainers.image.revision'
  if ($revision -ne $ExpectedRevision) {
    throw "Release container $Name does not match source revision $ExpectedRevision."
  }
  [pscustomobject]@{
    container = $Name
    imageId = $container.Image
    sourceRevision = $revision
  } | ConvertTo-Json -Compress
}

Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Test-Path -LiteralPath '.env.local')) { throw '.env.local is required.' }
$keys = [regex]::Matches((Get-Content -Raw -LiteralPath 'docker-compose.persistence.yml'), '\$\{([A-Z][A-Z0-9_]*)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($key in $keys) {
  if ([Environment]::GetEnvironmentVariable($key, 'Process')) { throw "Unset the shell override $key before deployment; .env.local must be authoritative." }
}
$prefix = @('compose','-p','openmaic-main','--env-file','.env.local','-f','docker-compose.yml','-f','docker-compose.persistence.yml','--profile','server-persistence')
if (Test-Path -LiteralPath 'server-providers.yml') { $prefix += @('-f','docker-compose.providers.yml') }
$raw = & docker @prefix config --format json 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Compose validation failed. Check required .env.local keys without printing secrets.' }
$config = ($raw -join "`n") | ConvertFrom-Json
$workerService = $config.services.'generation-worker'
if (-not $workerService) { throw 'The generation-worker service is required.' }
if ($workerService.image -ne 'zhiyu-worker:latest' -or $workerService.build.target -ne 'generation-worker') { throw 'The generation-worker image or Docker target is invalid.' }
$pgVolume = $config.volumes.'openmaic-postgres'
$appVolume = $config.volumes.'openmaic-data'
if ($pgVolume.name -ne 'openmaic-main_openmaic-postgres' -or -not $pgVolume.external -or $appVolume.name -ne 'openmaic-main_openmaic-data' -or -not $appVolume.external) { throw 'Original external volume identity mismatch.' }
foreach ($volume in @($pgVolume.name,$appVolume.name)) {
  & docker volume inspect $volume --format '{{.Name}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Original volume is missing; refusing to create a replacement.' }
}
$appEnv = $config.services.openmaic.environment
$workerEnv = $workerService.environment
$dbTarget = [Uri]$appEnv.DATABASE_URL
if ($dbTarget.Host -ne 'postgres' -or $dbTarget.Port -ne 5432 -or $dbTarget.AbsolutePath -ne '/openmaic') { throw 'Docker database target must be postgres:5432/openmaic.' }
if ($workerEnv.DATABASE_URL -ne $appEnv.DATABASE_URL) { throw 'Web and worker database URLs must match.' }
if ($config.services.openmaic.build.args.NEXT_PUBLIC_PERSISTENCE -ne '1') { throw 'Persistence must be enabled at build time.' }
if ($config.services.openmaic.build.args.NEXT_PUBLIC_PERSISTENCE_TOKEN -ne $appEnv.PERSISTENCE_DEV_TOKEN) { throw 'Public compatibility token differs from runtime token.' }
if ($appEnv.GENERATION_SESSION_SECRET.Length -lt 32) { throw 'A persistent session signing secret of at least 32 bytes is required.' }
if ($appEnv.PRO_MODEL_ENCRYPTION_KEY -notmatch '^[a-fA-F0-9]{64}$') { throw 'A persistent 32-byte hex PRO model encryption key is required.' }
if ($appEnv.MEDIA_CONFIG_ENCRYPTION_KEY -notmatch '^[a-fA-F0-9]{64}$') { throw 'A persistent 32-byte hex MEDIA_CONFIG_ENCRYPTION_KEY is required.' }
if ($workerEnv.MEDIA_CONFIG_ENCRYPTION_KEY -ne $appEnv.MEDIA_CONFIG_ENCRYPTION_KEY) { throw 'Web and worker media snapshot encryption keys must match.' }
if ($appEnv.GENERATION_MODEL_ENCRYPTION_KEY -notmatch '^[a-fA-F0-9]{64}$') { throw 'A persistent 32-byte hex GENERATION_MODEL_ENCRYPTION_KEY is required.' }
if ($workerEnv.GENERATION_MODEL_ENCRYPTION_KEY -ne $appEnv.GENERATION_MODEL_ENCRYPTION_KEY) { throw 'Web and worker generation model snapshot encryption keys must match.' }
if ($workerEnv.PRO_MODEL_ENCRYPTION_KEY) { throw 'The generation worker must not receive PRO_MODEL_ENCRYPTION_KEY.' }
if ($appEnv.GENERATION_BACKGROUND_ENABLED -ne '1' -or $workerEnv.GENERATION_BACKGROUND_ENABLED -ne '1') { throw 'GENERATION_BACKGROUND_ENABLED must be 1 for Web and worker.' }
if ($appEnv.GENERATION_ACCEPTING_JOBS -ne '1' -or $workerEnv.GENERATION_ACCEPTING_JOBS -ne '1') { throw 'GENERATION_ACCEPTING_JOBS must be 1 for Web and worker.' }
if ($appEnv.ASSET_S3_BUCKET) { throw 'Background rollout currently requires the verified PostgreSQL bytes backend.' }
if ($config.services.openmaic.ports[0].host_ip -ne '127.0.0.1') { throw 'This deployment is restricted to localhost.' }
switch ($Action) {
  'check' { Write-Output 'Compose, worker, external volumes, shared database and snapshot keys, build flags, and rollout gates validated.'; return }
  'build' {
    $trackedChanges = & git status --porcelain --untracked-files=no
    if ($trackedChanges) { throw 'Commit tracked changes before building release images.' }
    $revision = Get-SourceRevision
    & docker @prefix build --build-arg "OPENMAIC_SOURCE_REVISION=$revision" openmaic generation-worker
    if ($LASTEXITCODE -ne 0) { throw 'Release image build failed.' }
    Write-ReleaseImageRecords $revision
  }
  'migrate' {
    [void](Get-ReleaseImageRecord 'zhiyu-worker:latest' (Get-SourceRevision))
    & docker @prefix run --rm --no-deps generation-worker node dist-worker/migrate.mjs
  }
  'start-app' {
    $revision = Get-SourceRevision
    [void](Get-ReleaseImageRecord 'zhiyu:latest' $revision)
    [void](Get-ReleaseImageRecord 'zhiyu-worker:latest' $revision)
    # The app and PRO runtime both consume encrypted media snapshots. Apply the
    # additive schema before cutover so startup never depends on an operator
    # remembering a separate migration command.
    & docker @prefix run --rm --no-deps generation-worker node dist-worker/migrate.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Generation schema migration failed; app was not started.' }
    Wait-GenerationWorkerHealthy
    [void](Write-ContainerReleaseRecord 'zhiyu-worker' $revision)
    $running = & docker ps --filter 'name=^/zhiyu$' --format '{{.ID}}'
    if ($running) {
      $project = & docker inspect $running --format '{{index .Config.Labels "com.docker.compose.project"}}'
      $service = & docker inspect $running --format '{{index .Config.Labels "com.docker.compose.service"}}'
      if ($project -ne 'openmaic-main' -or $service -ne 'openmaic') { throw 'A non-target zhiyu container still owns the port. Complete the verified cutover before starting Compose openmaic.' }
    }
    & docker @prefix up -d --no-deps openmaic
    if ($LASTEXITCODE -ne 0) { throw 'Application deployment failed.' }
    Wait-GenerationWorkerHealthy
    Write-ContainerReleaseRecord 'zhiyu' $revision
    Write-ContainerReleaseRecord 'zhiyu-worker' $revision
  }
  'start-worker' {
    $revision = Get-SourceRevision
    [void](Get-ReleaseImageRecord 'zhiyu-worker:latest' $revision)
    & docker @prefix up -d --no-deps generation-worker
    if ($LASTEXITCODE -ne 0) { throw 'Generation worker deployment failed.' }
    Wait-GenerationWorkerHealthy
    Write-ContainerReleaseRecord 'zhiyu-worker' $revision
  }
  'stop-worker' { & docker @prefix stop generation-worker }
  'status' { & docker @prefix ps }
}
if ($LASTEXITCODE -ne 0) { throw 'Compose operation failed.' }
