[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$Hostname,
  [ValidateRange(1, 1000)]
  [int]$Samples = 12,
  [ValidateRange(1, 3600)]
  [int]$IntervalSeconds = 30,
  [ValidateRange(250, 30000)]
  [int]$LookupTimeoutMs = 5000
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

foreach ($target in $Hostname) {
  if ([Uri]::CheckHostName($target) -eq [UriHostNameType]::Unknown) {
    throw "Invalid DNS hostname: $target"
  }
}
if (-not (Test-Path -LiteralPath '.env.local' -PathType Leaf)) {
  throw '.env.local is required for the Docker probes.'
}

$composeExecutable = 'docker'
$composePrefix = @('compose')
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  & docker-compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is required for container DNS probes.' }
  $composeExecutable = 'docker-compose'
  $composePrefix = @()
}
$compose = @(
  @($composePrefix) + @('-p', 'openmaic-main', '--env-file', '.env.local',
  '-f', 'docker-compose.yml', '-f', 'docker-compose.persistence.yml',
  '--profile', 'server-persistence')
)
if (Test-Path -LiteralPath 'server-providers.yml' -PathType Leaf) {
  $compose += @('-f', 'docker-compose.providers.yml')
}

# The probe accepts only a hostname and a bounded timeout. It never reads or
# prints provider configuration, URLs, request bodies, headers, or credentials.
$nodeProbe = @'
const dns = require('node:dns');
const hostname = process.argv[1];
const timeoutMs = Number(process.argv[2]);
const startedAt = Date.now();
let complete = false;
function finish(result, exitCode) {
  if (complete) return;
  complete = true;
  process.stdout.write(JSON.stringify({
    ok: result.ok,
    code: result.code,
    addressCount: result.addressCount,
    family: result.family,
    elapsedMs: Date.now() - startedAt
  }) + '\n');
  process.exit(exitCode);
}
dns.lookup(hostname, { all: true }, (error, addresses) => {
  if (error) finish({ ok: false, code: error.code || 'DNS_LOOKUP_FAILED' }, 2);
  else finish({
    ok: true,
    code: 'OK',
    addressCount: addresses.length,
    family: [...new Set(addresses.map((entry) => entry.family))].join(',')
  }, 0);
});
setTimeout(() => finish({ ok: false, code: 'PROBE_TIMEOUT' }, 3), timeoutMs);
'@

function Convert-ProbeResult(
  [string]$Surface,
  [string]$Target,
  [int]$Sample,
  [AllowEmptyCollection()]
  [string[]]$Raw
) {
  try {
    $result = (($Raw -join "`n").Trim() | ConvertFrom-Json)
    if ($null -eq $result -or $null -eq $result.ok -or -not $result.code) {
      throw 'Probe returned no structured result.'
    }
    [pscustomobject]@{
      timestamp = [DateTimeOffset]::UtcNow.ToString('o')
      sample = $Sample
      surface = $Surface
      hostname = $Target
      ok = [bool]$result.ok
      code = [string]$result.code
      addressCount = if ($null -eq $result.addressCount) { 0 } else { [int]$result.addressCount }
      family = if ($null -eq $result.family) { '' } else { [string]$result.family }
      elapsedMs = [int]$result.elapsedMs
    }
  } catch {
    [pscustomobject]@{
      timestamp = [DateTimeOffset]::UtcNow.ToString('o')
      sample = $Sample
      surface = $Surface
      hostname = $Target
      ok = $false
      code = 'PROBE_PROCESS_FAILED'
      addressCount = 0
      family = ''
      elapsedMs = 0
    }
  }
}

for ($sample = 1; $sample -le $Samples; $sample++) {
  foreach ($target in $Hostname) {
    $hostRaw = @(& node -e $nodeProbe $target $LookupTimeoutMs 2>$null)
    Convert-ProbeResult 'host' $target $sample $hostRaw | ConvertTo-Json -Compress

    foreach ($service in @('openmaic', 'generation-worker')) {
      $containerRaw = @(
        & $composeExecutable @compose exec -T $service node -e $nodeProbe $target $LookupTimeoutMs 2>$null
      )
      $surface = if ($service -eq 'openmaic') { 'web' } else { 'worker' }
      Convert-ProbeResult $surface $target $sample $containerRaw | ConvertTo-Json -Compress
    }
  }
  if ($sample -lt $Samples) { Start-Sleep -Seconds $IntervalSeconds }
}
