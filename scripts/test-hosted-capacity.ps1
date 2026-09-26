param(
  [string]$NodeExecutable = 'node',
  [string]$PostgresImage = 'postgres:16'
)

# All writes go to an ephemeral PostgreSQL container, never DATABASE_URL or a saved volume.
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskContainer = 'openmaic-capacity-proof-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$taskVariables = @(
  'TEST_GENERATION_DATABASE_URL', 'TEST_HOSTED_CAPACITY_DATABASE_URL',
  'TEST_ACCOUNT_DELETION_DATABASE_URL', 'TEST_LOAD_LOCAL_ENV'
)
$taskOriginal = @{}
foreach ($name in $taskVariables) {
  $taskOriginal[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$taskCreated = $false
Push-Location $taskRoot
try {
  $taskNodeMajor = & $NodeExecutable -p 'process.versions.node.split(".")[0]'
  if ($LASTEXITCODE -ne 0 -or [int]$taskNodeMajor -lt 22) {
    throw 'This proof requires Node.js 22 or newer; supply -NodeExecutable with its path.'
  }
  # --tmpfs prevents creation or reuse of persistent database volumes. Binding is local only.
  & docker run --detach --rm --name $taskContainer `
    --label openmaic.disposable-capacity-proof=true `
    --publish 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data `
    --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=capacity_rls_proof $PostgresImage
  if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated test database; no existing container will be changed.' }
  $taskCreated = $true
  $taskReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $taskContainer pg_isready --username postgres --dbname capacity_rls_proof *> $null
    if ($LASTEXITCODE -eq 0) { $taskReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $taskReady) { throw 'Isolated PostgreSQL did not become ready.' }
  $taskUrl = 'postgresql://postgres@127.0.0.1:55432/capacity_rls_proof'
  $env:TEST_GENERATION_DATABASE_URL = $taskUrl
  $env:TEST_HOSTED_CAPACITY_DATABASE_URL = $taskUrl
  $env:TEST_ACCOUNT_DELETION_DATABASE_URL = $taskUrl
  $env:TEST_LOAD_LOCAL_ENV = '0'

  & $NodeExecutable scripts/build-generation-worker.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Worker build failed.' }
  & $NodeExecutable node_modules/vitest/vitest.mjs run `
    tests/server/generation-jobs.pg.test.ts `
    tests/server/generation-worker-pipeline.pg.test.ts `
    tests/server/hosted-capacity-rls.pg.test.ts `
    tests/server/account-deletion-lifecycle.test.ts `
    tests/auth/hosted-principal-registry.pg.test.ts `
    --maxWorkers=1 --reporter=verbose
  if ($LASTEXITCODE -ne 0) { throw 'Capacity/deletion proof failed.' }
} finally {
  if ($taskCreated) {
    & docker stop $taskContainer | Out-Null
  }
  foreach ($name in $taskVariables) {
    [Environment]::SetEnvironmentVariable($name, $taskOriginal[$name], 'Process')
  }
  Pop-Location
}
