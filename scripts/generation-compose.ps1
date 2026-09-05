param([ValidateSet('check','build','migrate','start-app','start-worker','stop-worker','status')][string]$Action = 'check')
$ErrorActionPreference = 'Stop'
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
$pgVolume = $config.volumes.'openmaic-postgres'
$appVolume = $config.volumes.'openmaic-data'
if ($pgVolume.name -ne 'openmaic-main_openmaic-postgres' -or -not $pgVolume.external -or $appVolume.name -ne 'openmaic-main_openmaic-data' -or -not $appVolume.external) { throw 'Original external volume identity mismatch.' }
foreach ($volume in @($pgVolume.name,$appVolume.name)) {
  & docker volume inspect $volume --format '{{.Name}}' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Original volume is missing; refusing to create a replacement.' }
}
$appEnv = $config.services.openmaic.environment
$dbTarget = [Uri]$appEnv.DATABASE_URL
if ($dbTarget.Host -ne 'postgres' -or $dbTarget.Port -ne 5432 -or $dbTarget.AbsolutePath -ne '/openmaic') { throw 'Docker database target must be postgres:5432/openmaic.' }
if ($config.services.openmaic.build.args.NEXT_PUBLIC_PERSISTENCE -ne '1') { throw 'Persistence must be enabled at build time.' }
if ($config.services.openmaic.build.args.NEXT_PUBLIC_PERSISTENCE_TOKEN -ne $appEnv.PERSISTENCE_DEV_TOKEN) { throw 'Public compatibility token differs from runtime token.' }
if ($appEnv.GENERATION_SESSION_SECRET.Length -lt 32) { throw 'A persistent session signing secret of at least 32 bytes is required.' }
if ($appEnv.GENERATION_BACKGROUND_ENABLED -eq '1' -and $appEnv.ASSET_S3_BUCKET) { throw 'Background rollout currently requires the verified PostgreSQL bytes backend.' }
if ($config.services.openmaic.ports[0].host_ip -ne '127.0.0.1') { throw 'This deployment is restricted to localhost.' }
switch ($Action) {
  'check' { Write-Output 'Compose, external volumes, database target, public build flags, and signing configuration validated.'; return }
  'build' { & docker @prefix build openmaic generation-worker }
  'migrate' { & docker @prefix run --rm --no-deps generation-worker node dist-worker/migrate.mjs }
  'start-app' {
    $running = & docker ps --filter 'name=^/zhiyu$' --format '{{.Names}}'
    if ($running) { throw 'The manual zhiyu container still owns the port. Complete the verified cutover before starting Compose openmaic.' }
    & docker @prefix up -d --no-deps openmaic
  }
  'start-worker' { & docker @prefix up -d --no-deps generation-worker }
  'stop-worker' { & docker @prefix stop generation-worker }
  'status' { & docker @prefix ps }
}
if ($LASTEXITCODE -ne 0) { throw 'Compose operation failed.' }
