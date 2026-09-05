param([string]$BackupDirectory = '.scratch/generation-backup-20260905')
$ErrorActionPreference = 'Stop'
function Invoke-Docker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Docker backup operation failed.' }
}
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backup = [IO.Path]::GetFullPath((Join-Path $workspace $BackupDirectory))
if (-not $backup.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar)) { throw 'Backup must remain inside the workspace.' }
New-Item -ItemType Directory -Force -Path $backup | Out-Null
& icacls $backup /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict backup permissions.' }
$pg = (& docker inspect openmaic-main-postgres-1 | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0 -or $pg.State.Running) { throw 'Expected the original PostgreSQL container to be stopped before cold backup.' }
$mount = @($pg.Mounts | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })
if ($mount.Count -ne 1 -or $mount[0].Name -ne 'openmaic-main_openmaic-postgres') { throw 'Unexpected original PostgreSQL volume.' }
$app = (& docker inspect zhiyu | ConvertFrom-Json)[0]
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the original application.' }
$dataMount = @($app.Mounts | Where-Object { $_.Destination -eq '/app/data' })
if ($dataMount.Count -ne 1 -or $dataMount[0].Name -ne 'openmaic-main_openmaic-data') { throw 'Unexpected application data volume.' }
if ((Test-Path (Join-Path $backup 'postgres.tar')) -or (Test-Path (Join-Path $backup 'app-data.tar'))) { throw 'Refusing to overwrite an existing backup.' }
$wasRunning = $app.State.Running
try {
  if ($wasRunning) { Invoke-Docker @('stop', '--time', '30', 'zhiyu') }
  Invoke-Docker @('run','--rm','--network','none','--mount','type=volume,src=openmaic-main_openmaic-postgres,dst=/source,readonly','--mount',"type=bind,src=$backup,dst=/backup",'postgres:16','tar','-C','/source','-cpf','/backup/postgres.tar','.')
  Invoke-Docker @('run','--rm','--network','none','--mount','type=volume,src=openmaic-main_openmaic-data,dst=/source,readonly','--mount',"type=bind,src=$backup,dst=/backup",'postgres:16','tar','-C','/source','-cpf','/backup/app-data.tar','.')
} finally {
  if ($wasRunning) { Invoke-Docker @('start','zhiyu') }
}
$manifest = @('postgres.tar','app-data.tar') | ForEach-Object {
  $file = Get-Item -LiteralPath (Join-Path $backup $_)
  if ($file.Length -eq 0) { throw 'Empty backup archive.' }
  [pscustomobject]@{File=$file.Name; Bytes=$file.Length; SHA256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash}
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'manifest.json')
$manifest | Format-Table
