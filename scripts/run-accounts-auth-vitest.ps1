# Run accounts/auth Vitest on Node 22 using zhiyu-worker:latest.
# Mounts current worktree sources + vitest.config.ts so `@/` aliases resolve.
# Does not use the live container's /app/data volume.
param(
  [string]$Image = 'zhiyu-worker:latest'
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path
& docker run --rm --entrypoint /bin/sh `
  -v "${root}/tests:/app/tests:ro" `
  -v "${root}/lib:/app/lib:ro" `
  -v "${root}/app:/app/app:ro" `
  -v "${root}/components:/app/components:ro" `
  -v "${root}/vitest.config.ts:/app/vitest.config.ts:ro" `
  -w /app $Image -c "node -v && ./node_modules/.bin/vitest run tests/auth tests/agent-runtime/sessions-route.test.ts --config /app/vitest.config.ts"
if ($LASTEXITCODE -ne 0) { throw "Auth Vitest failed with exit $LASTEXITCODE" }
