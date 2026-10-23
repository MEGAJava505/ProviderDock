param(
  [Parameter(Mandatory=$true)][ValidateSet('helpers','diagnostic')][string]$Mode,
  [string]$ReportPath,
  [string]$OwnedRoot,
  [string]$EvidenceRoot,
  [string]$OwnerAuthorizationPath,
  [string]$PinnedOmpPath,
  [string]$NodeProbePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$python = (Get-Command python.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$controller = Join-Path $PSScriptRoot 'a1d_controller.py'
$testFile = Join-Path $PSScriptRoot 'test_controller.py'
$evidenceBuilder = Join-Path $PSScriptRoot 'build-evidence.mjs'
$runner = Join-Path $PSScriptRoot 'a1d_elevated.ps1'
$budget = [ordered]@{ setupSeconds=15; protocolSeconds=60; teardownSeconds=15; controllerWatchdogSeconds=120; parentWatchdogSeconds=135 }

function Invoke-Python([string[]]$Arguments) {
  & $python -B @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Python helper failed with exit $LASTEXITCODE" }
}
function Invoke-Node([string[]]$Arguments) {
  & $node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Node helper failed with exit $LASTEXITCODE" }
}
function Write-NewJson([string]$Path, $Value) {
  $json = $Value | ConvertTo-Json -Depth 30
  [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}
function UtcNow { [DateTime]::UtcNow.ToString('o') }

if ($Mode -eq 'helpers') {
  if (-not $ReportPath) { throw 'ReportPath is required in helpers mode' }
  $report = [IO.Path]::GetFullPath($ReportPath)
  if (Test-Path -LiteralPath $report) { throw 'Helper report already exists; refusing overwrite' }
  Invoke-Python @($testFile, '--full', '--report', $report)
  exit 0
}

foreach ($required in @('OwnedRoot','EvidenceRoot','OwnerAuthorizationPath','PinnedOmpPath','NodeProbePath')) {
  if (-not (Get-Variable -Name $required -ValueOnly)) { throw "$required is required in diagnostic mode" }
}
$owned = [IO.Path]::GetFullPath($OwnedRoot)
$evidence = [IO.Path]::GetFullPath($EvidenceRoot)
$authorizationPath = [IO.Path]::GetFullPath($OwnerAuthorizationPath)
$pinned = [IO.Path]::GetFullPath($PinnedOmpPath)
$nodeProbe = [IO.Path]::GetFullPath($NodeProbePath)
if (Test-Path -LiteralPath $owned) { throw 'Owned root already exists; no retry or cleanup of prior data' }
if (-not (Test-Path -LiteralPath $evidence -PathType Container)) { throw 'Evidence directory is missing' }
Invoke-Node @($evidenceBuilder, 'check-ids', 'unused', $evidence)

$authorization = Get-Content -Encoding UTF8 -Raw -LiteralPath $authorizationPath | ConvertFrom-Json
if (-not $authorization.ownerApproved -or $authorization.launchCount -ne 1 -or $authorization.retries -ne 0) { throw 'Separate one-launch owner authorization is invalid' }
$approvedAt = [DateTime]::Parse($authorization.approvedAtUtc).ToUniversalTime()
$expiresAt = [DateTime]::Parse($authorization.expiresAtUtc).ToUniversalTime()
$now = [DateTime]::UtcNow
if ($approvedAt -gt $now -or $expiresAt -le $now -or ($expiresAt - $approvedAt).TotalMinutes -gt 5) { throw 'Owner authorization is outside its short UTC window' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevated PowerShell is required' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class M11FixPrivilege {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct TokenPrivilege { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref TokenPrivilege value, uint length, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Enable(string name) {
    IntPtr token;
    if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, 0x28, out token)) throw new System.ComponentModel.Win32Exception();
    try {
      Luid id;
      if (!LookupPrivilegeValue(null, name, out id)) throw new System.ComponentModel.Win32Exception();
      var value = new TokenPrivilege { Count=1, Id=id, Attributes=2 };
      if (!AdjustTokenPrivileges(token, false, ref value, 0, IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new System.ComponentModel.Win32Exception(error);
    } finally { CloseHandle(token); }
  }
}
'@
[M11FixPrivilege]::Enable('SeSystemProfilePrivilege')

$runTag = [Guid]::NewGuid().ToString('N')
$runId = 'M11-A1D-FIX-' + $runTag
$helperReportTemp = Join-Path ([IO.Path]::GetTempPath()) ("m11-fix-helper-$runTag.json")
$helperReportPath = Join-Path $owned 'private\helper-report.json'
$authorizationCopyPath = Join-Path $owned 'private\owner-authorization.json'
$sessions = @(
  [ordered]@{kind='Process';provider='Microsoft-Windows-Kernel-Process';file='Process.etl'},
  [ordered]@{kind='Transport';provider='Microsoft-Windows-TCPIP';file='Transport.etl'},
  [ordered]@{kind='WFP';provider='Microsoft-Windows-WFP';file='WFP.etl'},
  [ordered]@{kind='KernelNetwork';provider='Microsoft-Windows-Kernel-Network';file='KernelNetwork.etl'},
  [ordered]@{kind='DNS';provider='Microsoft-Windows-DNS-Client';file='DNS.etl'}
)
foreach ($session in $sessions) { $session.name = "PD-M11FIX-$runTag-$($session.kind)" }
$sessionNames = @($sessions | ForEach-Object { $_.name })
$ownedSessions = [Collections.Generic.List[object]]::new()
$sessionResults = [Collections.Generic.List[object]]::new()
$lossSnapshots = [Collections.Generic.List[object]]::new()
$providerMetadata = [Collections.Generic.List[object]]::new()
$controllerProcess = $null
$actualStarted = $false
$werTouched = $false
$werExisted = $false
$werRestored = $true
$werValuesBefore = @()
$werParent = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
$werKey = Join-Path $werParent 'omp.exe'
$werParentExisted = Test-Path -LiteralPath $werParent
$werBackup = Join-Path $owned 'private\wer-omp-before.reg'
$werBackupSha = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$errorClass = $null
$errorMessage = $null
$status = 'BLOCKED'
$actualStartClock = $null
$actualStartedAtUtc = $null
$actualEndedAtUtc = $null
$actualControllerOutput = $null
$runnerTeardownStartedAtUtc = $null
$runnerTeardownEndedAtUtc = $null
$runnerTeardownClock = $null
$controllerExitCode = $null
$parentWatchdog = [ordered]@{budgetSeconds=$budget.parentWatchdogSeconds;scheduledAtUtc=$null;fireUtc=$null;terminationUtc=$null;reason='parent-watchdog'}
$finalEtwLoss = @()
$etwSummary = $null
$helperReport = $null

function Query-Loss([string]$Suffix) {
  $path = Join-Path $owned "private\etw-$Suffix.json"
  Invoke-Python (@($controller, 'query-etw', '--output', $path) + $sessionNames) | Out-Null
  return Get-Content -Encoding UTF8 -Raw -LiteralPath $path | ConvertFrom-Json
}

try {
  Invoke-Python @($testFile, '--full', '--report', $helperReportTemp)
  $helperReport = Get-Content -Encoding UTF8 -Raw -LiteralPath $helperReportTemp | ConvertFrom-Json
  if ($helperReport.status -ne 'PASS' -or $helperReport.actualOmpLaunches -ne 0) { throw 'No-OMP helper suite did not pass' }
  Invoke-Python @($controller, 'prepare', '--root', $owned, '--pinned', $pinned, '--node-probe', $nodeProbe)
  [IO.File]::Copy($helperReportTemp, $helperReportPath, $false)
  [IO.File]::Copy($authorizationPath, $authorizationCopyPath, $false)
  Invoke-Node @((Join-Path $PSScriptRoot 'prepare-config.mjs'), $owned)

  $metadataDir = Join-Path $owned 'private\provider-metadata'
  [IO.Directory]::CreateDirectory($metadataDir) | Out-Null
  foreach ($provider in @($sessions | ForEach-Object { $_.provider })) {
    $query = @(& "$env:SystemRoot\System32\logman.exe" query providers $provider 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Provider metadata query failed: $provider" }
    $metadataPath = Join-Path $metadataDir (($provider -replace '[^A-Za-z0-9_.-]','_') + '.txt')
    [IO.File]::WriteAllText($metadataPath, ($query -join "`n"), [Text.UTF8Encoding]::new($false))
    $manifestPath = Join-Path $metadataDir (($provider -replace '[^A-Za-z0-9_.-]','_') + '.xml')
    & "$env:SystemRoot\System32\wevtutil.exe" gp $provider /ge:true /gm:true | Set-Content -Encoding UTF8 $manifestPath
    if ($LASTEXITCODE -ne 0) { throw "Provider manifest query failed: $provider" }
    $providerMetadata.Add([ordered]@{provider=$provider;querySha256=(Get-FileHash -Algorithm SHA256 $metadataPath).Hash.ToLowerInvariant();manifestSha256=(Get-FileHash -Algorithm SHA256 $manifestPath).Hash.ToLowerInvariant()})
  }
  foreach ($session in $sessions) {
    $etl = Join-Path $owned ('etw\' + $session.file)
    & "$env:SystemRoot\System32\logman.exe" create trace $session.name -p $session.provider '0xffffffffffffffff' '0xff' -bs 256 -nb 8 64 -max 64 -f bincirc -o $etl -ets | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ETW session start failed: $($session.name)" }
    $ownedSessions.Add($session)
  }

  $sourceFiles = [ordered]@{
    'scripts/m11/a1d_controller.py'=$controller
    'scripts/m11_a1d_io.py'=(Join-Path $repo 'scripts\m11_a1d_io.py')
    'scripts/m11/parse_etw.py'=(Join-Path $PSScriptRoot 'parse_etw.py')
    'scripts/m11/test_controller.py'=$testFile
  }
  $sourceHashes = [ordered]@{}
  foreach ($entry in $sourceFiles.GetEnumerator()) { $sourceHashes[$entry.Key]=(Get-FileHash -Algorithm SHA256 $entry.Value).Hash.ToLowerInvariant() }
  $controllerHash = $sourceHashes['scripts/m11/a1d_controller.py']
  $context = [ordered]@{runId=$runId;sessions=$sessions;controllerSha256=$controllerHash;sourceHashes=$sourceHashes;startedAtUtc=(UtcNow)}
  Write-NewJson (Join-Path $owned 'private\run-context.json') $context

  Invoke-Python @($controller, 'selftest', '--root', $owned)
  $selftest = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $owned 'private\selftest.json') | ConvertFrom-Json
  if ($selftest.status -ne 'PASS' -or $selftest.runId -ne $runId) { throw 'Linked self-test did not pass for current run and ETW sessions' }
  $afterSelfTest = Query-Loss 'after-selftest'
  if (-not $afterSelfTest.allLossZero) { throw 'ETW loss detected during self-test' }

  $preflightStart = [DateTime]::UtcNow
  $werExisted = Test-Path -LiteralPath $werKey
  if ($werExisted) {
    & "$env:SystemRoot\System32\reg.exe" export 'HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\omp.exe' $werBackup /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not snapshot existing WER settings' }
    $werBackupSha = (Get-FileHash -Algorithm SHA256 $werBackup).Hash.ToLowerInvariant()
    $existing = Get-Item -LiteralPath $werKey
    foreach ($valueName in @('DumpFolder','DumpType')) {
      $present = $existing.GetValueNames() -contains $valueName
      $werValuesBefore += [ordered]@{name=$valueName;present=$present;value=if($present){$existing.GetValue($valueName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null};kind=if($present){$existing.GetValueKind($valueName).ToString()}else{$null}}
    }
  }
  $werTouched = $true
  $werRestored = $false
  New-Item -Path $werKey -Force | Out-Null
  New-ItemProperty -LiteralPath $werKey -Name DumpFolder -Value (Join-Path $owned 'dumps') -PropertyType ExpandString -Force | Out-Null
  New-ItemProperty -LiteralPath $werKey -Name DumpType -Value 1 -PropertyType DWord -Force | Out-Null

  $version = (Get-Item -LiteralPath $pinned).VersionInfo | Select-Object FileVersion,ProductVersion,FileDescription,ProductName
  $preflight = [ordered]@{runId=$runId;recordedAtUtc=(UtcNow);binaryVersion=$version;token=[ordered]@{pid=$PID;isAdmin=$true;systemProfileEnabled=$true};providerMetadata=@($providerMetadata);etwSessions=$sessions;etwLossAfterSelfTest=$afterSelfTest.sessions;werBeforeState=[ordered]@{existed=$werExisted;backupSha256=$werBackupSha;values=$werValuesBefore};budgets=$budget;helperReportSha256=(Get-FileHash -Algorithm SHA256 $helperReportPath).Hash.ToLowerInvariant();sourceHashes=$sourceHashes}
  Write-NewJson (Join-Path $owned 'private\preflight.json') $preflight
  Invoke-Node @($evidenceBuilder, 'preflight', $owned, $evidence)

  Invoke-Python @($controller, 'mark-setup-start', '--root', $owned)
  $actualStarted = $true
  $actualStartClock = [Diagnostics.Stopwatch]::StartNew()
  $actualStartedAtUtc = UtcNow
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $python
  $startInfo.WorkingDirectory = $repo
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $quote = { param($value) '"' + ([string]$value).Replace('"','\"') + '"' }
  $startInfo.Arguments = (@('-B',$controller,'actual','--root',$owned) | ForEach-Object { & $quote $_ }) -join ' '
  $controllerProcess = [Diagnostics.Process]::Start($startInfo)
  $stdoutTask = $controllerProcess.StandardOutput.ReadToEndAsync()
  $stderrTask = $controllerProcess.StandardError.ReadToEndAsync()
  $parentClock = [Diagnostics.Stopwatch]::StartNew()
  $parentWatchdog.scheduledAtUtc = $actualStartedAtUtc
  while (-not $controllerProcess.HasExited -and $parentClock.Elapsed.TotalSeconds -lt $budget.parentWatchdogSeconds) {
    Start-Sleep -Milliseconds 500
    if ($controllerProcess.HasExited) { break }
    $snapshot = Query-Loss ('live-' + [Guid]::NewGuid().ToString('N'))
    $lossSnapshots.Add([ordered]@{atUtc=(UtcNow);sessions=$snapshot.sessions})
    if (-not $snapshot.allLossZero) {
      Stop-Process -Id $controllerProcess.Id -Force -ErrorAction SilentlyContinue
      throw 'ETW loss detected during actual controller run'
    }
  }
  if (-not $controllerProcess.HasExited) {
    $parentWatchdog.fireUtc = UtcNow
    Stop-Process -Id $controllerProcess.Id -Force -ErrorAction SilentlyContinue
    $parentWatchdog.terminationUtc = UtcNow
    throw 'Independent parent watchdog fired; no retry'
  }
  $controllerExitCode = $controllerProcess.ExitCode
  $actualEndedAtUtc = UtcNow
  $actualControllerOutput = [ordered]@{stdout=$stdoutTask.GetAwaiter().GetResult();stderrClass=if($stderrTask.GetAwaiter().GetResult()){'captured'}else{'empty'};exitCode=$controllerExitCode}
  $status = if ($controllerExitCode -eq 0) { 'OBSERVED' } else { 'NOT PROVEN' }
}
catch {
  $errorClass = $_.Exception.GetType().Name
  $errorMessage = $_.Exception.Message
  $status = 'BLOCKED'
}
finally {
  $runnerTeardownStartedAtUtc = UtcNow
  $runnerTeardownClock = [Diagnostics.Stopwatch]::StartNew()
  if ($null -ne $controllerProcess -and -not $controllerProcess.HasExited) {
    Stop-Process -Id $controllerProcess.Id -Force -ErrorAction SilentlyContinue
    try { $controllerProcess.WaitForExit(3000) | Out-Null } catch {}
  }
  if ($ownedSessions.Count -gt 0) {
    try { $finalEtwLoss = (Query-Loss 'final-before-stop').sessions } catch { $cleanupErrors.Add('final-etw-query-failed') }
  }
  foreach ($session in $ownedSessions) {
    & "$env:SystemRoot\System32\logman.exe" stop $session.name -ets | Out-Null
    $sessionResults.Add([ordered]@{kind=$session.kind;name=$session.name;stopExit=$LASTEXITCODE})
  }
  foreach ($session in $ownedSessions) {
    $etl = Join-Path $owned ('etw\' + $session.file)
    $xml = Join-Path $owned ('private\' + $session.kind + '.xml')
    if (Test-Path -LiteralPath $etl) {
      & "$env:SystemRoot\System32\tracerpt.exe" $etl -of XML -o $xml -lr -gmt -y | Out-Null
      $sessionResults.Add([ordered]@{kind=$session.kind;decodeExit=$LASTEXITCODE})
    }
  }
  $stopped = [ordered]@{atUtc=(UtcNow);sessions=@($sessionResults | Where-Object { $_.Contains('stopExit') })}
  if (Test-Path -LiteralPath (Join-Path $owned 'private')) { Write-NewJson (Join-Path $owned 'private\session-stop.json') $stopped }
  if ($werTouched) {
    try {
      if ($werExisted) {
        foreach ($original in $werValuesBefore) {
          if ($original.present) {
            $kind = [Microsoft.Win32.RegistryValueKind]::$($original.kind)
            New-ItemProperty -LiteralPath $werKey -Name $original.name -Value $original.value -PropertyType $kind -Force | Out-Null
          } else { Remove-ItemProperty -LiteralPath $werKey -Name $original.name -ErrorAction SilentlyContinue }
        }
        $after = Join-Path $owned 'private\wer-omp-restored.reg'
        & "$env:SystemRoot\System32\reg.exe" export 'HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\omp.exe' $after /y | Out-Null
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash -Algorithm SHA256 $after).Hash.ToLowerInvariant() -ne $werBackupSha) { throw 'WER restore hash mismatch' }
      } else {
        if (Test-Path -LiteralPath $werKey) { Remove-Item -LiteralPath $werKey -Force }
        if (-not $werParentExisted -and (Test-Path -LiteralPath $werParent)) {
          $parentKey = Get-Item -LiteralPath $werParent
          if ($parentKey.SubKeyCount -eq 0 -and $parentKey.ValueCount -eq 0) { Remove-Item -LiteralPath $werParent -Force }
        }
      }
      $werRestored = -not (Test-Path -LiteralPath $werKey) -or $werExisted
    } catch { $werRestored=$false; $cleanupErrors.Add('wer-restore-failed') }
  }
  if ($ownedSessions.Count -gt 0 -and (Test-Path -LiteralPath (Join-Path $owned 'private\actual.json'))) {
    try {
      Invoke-Python @((Join-Path $PSScriptRoot 'parse_etw.py'), '--root', $owned)
      $etwSummary = Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $owned 'private\etw-summary.json') | ConvertFrom-Json
    } catch { $cleanupErrors.Add('etw-decode-failed'); $status='NOT PROVEN' }
  }
  if (Test-Path -LiteralPath (Join-Path $owned 'private\state.json')) {
    try { Invoke-Python @($controller, 'cleanup', '--root', $owned) } catch { $cleanupErrors.Add('profile-cleanup-failed'); $status='NOT PROVEN' }
  }
  $orphanIdentities = @()
  if ($etwSummary) {
    foreach ($item in @($etwSummary.controller) + @($etwSummary.processes)) {
      if ($null -eq $item) { continue }
      $live = Get-Process -Id $item.pid -ErrorAction SilentlyContinue
      if ($live -and [Math]::Abs(($live.StartTime.ToUniversalTime() - [DateTime]::Parse($item.createTimeUtc).ToUniversalTime()).TotalSeconds) -lt 1) {
        $orphanIdentities += [ordered]@{pid=$item.pid;createTimeUtc=$item.createTimeUtc}
      }
    }
  }
  if ($owned -and (Test-Path -LiteralPath (Join-Path $owned 'private'))) {
    $runnerTeardownEndedAtUtc = UtcNow
    $runnerTeardownMs = $runnerTeardownClock.Elapsed.TotalMilliseconds
    if ($runnerTeardownMs -gt 15000) {
      $cleanupErrors.Add('teardown-budget-exceeded')
      if ($status -eq 'OBSERVED') { $status = 'NOT PROVEN' }
    }
    $result = [ordered]@{status=$status;runId=$runId;actualStarted=$actualStarted;actualLaunches=if(Test-Path (Join-Path $owned 'private\state.json')){(Get-Content -Encoding UTF8 -Raw (Join-Path $owned 'private\state.json')|ConvertFrom-Json).actualLaunches}else{0};controllerExitCode=$controllerExitCode;actualStartedAtUtc=$actualStartedAtUtc;actualEndedAtUtc=$actualEndedAtUtc;actualWallMs=if($actualStartClock){$actualStartClock.Elapsed.TotalMilliseconds}else{$null};controllerOutput=$actualControllerOutput;parentWatchdog=$parentWatchdog;finalEtwLoss=$finalEtwLoss;liveLossSnapshots=@($lossSnapshots);sessionResults=@($sessionResults);orphanIdentities=$orphanIdentities;orphanCheckAtUtc=(UtcNow);werRestored=$werRestored;cleanupErrors=@($cleanupErrors);errorClass=$errorClass;errorMessage=$errorMessage}
    $result.runnerTeardownStartedAtUtc = $runnerTeardownStartedAtUtc
    $result.runnerTeardownEndedAtUtc = $runnerTeardownEndedAtUtc
    $result.runnerTeardownMs = $runnerTeardownMs
    Write-NewJson (Join-Path $owned 'private\runner-result.json') $result
  }
  if (Test-Path -LiteralPath $helperReportTemp) { Remove-Item -LiteralPath $helperReportTemp -Force -ErrorAction SilentlyContinue }
}

if (Test-Path -LiteralPath (Join-Path $owned 'private\actual.json')) {
  Invoke-Node @($evidenceBuilder, 'final', $owned, $evidence)
} else {
  Write-Error "Diagnostic run ended $status. Review the private runner result; no retry was made."
  exit 2
}
