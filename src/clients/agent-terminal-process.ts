import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface AgentTerminalProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface AgentTerminalSpawnSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

export interface SpawnedAgentTerminalProcess {
  readonly child: ChildProcess;
  ready(): Promise<number>;
}

const terminalReadyPrefix = "PROVIDERDOCK_READY:";
const terminalReadyTimeoutMs = 35_000;

const foregroundTerminalScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PROVIDERDOCK_TERMINAL_PAYLOAD))
$payload = $payloadJson | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProviderDockForegroundWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool enabled);
  public static void Activate(IntPtr handle) {
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
    uint currentThread = GetCurrentThreadId();
    bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    try {
      ShowWindowAsync(handle, 9);
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
    }
    finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
'@
$terminalCommand = '__TERMINAL_COMMAND__'
$stateDirectory = Join-Path ([IO.Path]::GetTempPath()) ('providerdock-terminal-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($stateDirectory)
$statePath = Join-Path $stateDirectory 'state.json'
try {
  $stateEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($statePath))
  $innerScript = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($terminalCommand))
  $innerScript = $innerScript.Replace('__STATE_PATH__', $stateEncoded)
  $innerCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($innerScript))
  $shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $terminal = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $state = $null
  $window = $null
  $shellReported = $false
  if ($null -ne $terminal) {
    # wt.exe is only a launcher and can exit before the tab does. Track the
    # PowerShell inside the tab and confirm the new ProviderDock window.
    $knownHandles = @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowHandle.ToInt64() })
    $terminalArguments = @('-w', 'new', 'new-tab', '--inheritEnvironment', '--title', 'ProviderDock', ('"' + $shellPath + '"'), '-NoLogo', '-NoProfile', '-EncodedCommand', $innerCommand)
    [void](Start-Process -FilePath $terminal.Source -ArgumentList $terminalArguments -WorkingDirectory ([string]$payload.cwd) -WindowStyle Normal -PassThru)
    while ([DateTime]::UtcNow -lt $deadline -and ($null -eq $state -or $null -eq $window)) {
      if (Test-Path -LiteralPath $statePath) {
        try { $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json } catch {}
      }
      if ($null -ne $state) {
        $agentShell = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        if ($null -eq $agentShell) { throw 'The agent shell exited before its terminal became visible.' }
        if (-not $shellReported) {
          [Console]::Out.WriteLine(('PROVIDERDOCK_SHELL:' + [int]$state.pid))
          [Console]::Out.Flush()
          $shellReported = $true
        }
      }
      $window = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        ($knownHandles -notcontains $_.MainWindowHandle.ToInt64() -or $_.MainWindowTitle -like '*ProviderDock*')
      } | Select-Object -First 1
      if ($null -eq $state -or $null -eq $window) { Start-Sleep -Milliseconds 100 }
    }
  } else {
    $startParameters = @{
      FilePath = Join-Path $env:SystemRoot 'System32\conhost.exe'
      ArgumentList = @(('"' + $shellPath + '"'), '-NoLogo', '-NoProfile', '-EncodedCommand', $innerCommand)
      WorkingDirectory = [string]$payload.cwd
      WindowStyle = 'Normal'
      PassThru = $true
    }
    $window = Start-Process @startParameters
    while ([DateTime]::UtcNow -lt $deadline -and ($null -eq $state -or $window.MainWindowHandle -eq [IntPtr]::Zero)) {
      if (Test-Path -LiteralPath $statePath) {
        try { $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json } catch {}
      }
      $window.Refresh()
      if ($window.HasExited) { throw 'The console host exited before the agent shell was ready.' }
      if ($null -eq $state -or $window.MainWindowHandle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
      elseif ($null -ne $state) { break }
    }
  }
  if ($null -eq $state) { throw 'The terminal did not start the agent shell within 30 seconds.' }
  if ($null -eq $window -or $window.MainWindowHandle -eq [IntPtr]::Zero) { throw 'The agent terminal did not become visible within 30 seconds.' }
  $agentShell = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  if ($null -eq $agentShell) { throw 'The agent shell exited before startup acknowledgement.' }
  [ProviderDockForegroundWindow]::Activate($window.MainWindowHandle)
  [Console]::Out.WriteLine(('PROVIDERDOCK_READY:' + [int]$state.pid))
  [Console]::Out.Flush()
  $agentShell.WaitForExit()
  $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
  if ($null -eq $state.exitCode) { exit 1 }
  exit ([int]$state.exitCode)
}
finally {
  # Only the two known, non-secret status artifacts are removed.
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stateDirectory -ErrorAction SilentlyContinue
}
`;

const interactiveAgentScript = String.raw`
$stateToken = '__STATE_PATH__'
$statePath = if ($stateToken.StartsWith('__')) { $null } else { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($stateToken)) }
function Write-SessionState($code) {
  if ($statePath) { [IO.File]::WriteAllText($statePath, (@{ pid = $PID; exitCode = $code } | ConvertTo-Json -Compress)) }
}
Write-SessionState $null
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PROVIDERDOCK_TERMINAL_PAYLOAD))
$payload = $payloadJson | ConvertFrom-Json
Remove-Item Env:\PROVIDERDOCK_TERMINAL_PAYLOAD -ErrorAction SilentlyContinue
$launchArgs = @($payload.arguments | ForEach-Object { [string]$_ })
$ErrorActionPreference = 'Stop'
$startedAt = Get-Date
$exitCode = 0
try {
  Set-Location -LiteralPath ([string]$payload.cwd)
  $command = Get-Command ([string]$payload.executable) -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
  # Prefer the npm .cmd shim: .ps1 shims may be blocked by execution policy.
  if ($command.Source.EndsWith('.ps1') -and (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($command.Source, '.cmd')))) {
    $agentExecutable = [IO.Path]::ChangeExtension($command.Source, '.cmd')
  } else { $agentExecutable = $command.Source }
  & $agentExecutable @launchArgs
  if ($null -ne $LASTEXITCODE) { $exitCode = [int]$LASTEXITCODE }
}
catch {
  $exitCode = 1
  Write-Host ''
  Write-Host ('Не удалось запустить агента: ' + $_.Exception.Message) -ForegroundColor Red
}
$elapsed = ((Get-Date) - $startedAt).TotalSeconds
if ($exitCode -ne 0 -or $elapsed -lt 3) {
  Write-Host ''
  if ($exitCode -eq 0) {
    Write-Host 'Агент завершился сразу после запуска.' -ForegroundColor Yellow
  }
  else {
    Write-Host ('Агент завершился с кодом ' + $exitCode + '.') -ForegroundColor Red
  }
  [void](Read-Host 'Нажмите Enter, чтобы закрыть окно')
}
Write-SessionState $exitCode
exit $exitCode
`;

/**
 * On Windows the dashboard may run without a console, so the interactive agent
 * is started through a hidden wrapper that owns a new, visible foreground terminal.
 */
export function agentTerminalSpawnSpec(
  request: AgentTerminalProcessRequest,
  platform: NodeJS.Platform = process.platform,
): AgentTerminalSpawnSpec {
  if (platform !== "win32") {
    return {
      executable: request.executable,
      args: [...request.args],
      options: {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: "inherit",
      },
    };
  }

  const agentPayload = Buffer.from(
    JSON.stringify({
      executable: request.executable,
      arguments: request.args,
      cwd: request.cwd,
    }),
    "utf8",
  ).toString("base64");
  const terminalCommand = Buffer.from(interactiveAgentScript, "utf16le").toString("base64");
  const script = foregroundTerminalScript.replaceAll("__TERMINAL_COMMAND__", terminalCommand);
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    options: {
      cwd: request.cwd,
      env: { ...request.environment, PROVIDERDOCK_TERMINAL_PAYLOAD: agentPayload },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  };
}

export function spawnAgentTerminalProcess(request: AgentTerminalProcessRequest): SpawnedAgentTerminalProcess {
  const specification = agentTerminalSpawnSpec(request);
  const child = spawn(specification.executable, [...specification.args], specification.options);
  const readiness = new Promise<number>((resolve, reject) => {
    let settled = false;
    let shellPid: number | undefined;
    let output = "";
    const finish = (error: Error | undefined, pid?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
      if (error) {
        child.kill();
        void terminateProcessTree(shellPid).finally(() => reject(error));
      } else {
        resolve(pid as number);
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(
        `Agent terminal exited before startup acknowledgement (${signal ?? `code ${exitCode ?? "unknown"}`}).`,
      ));
    };
    const onData = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-4_096);
      const shellMatch = new RegExp(`${terminalShellPrefix}(\\d+)`).exec(output);
      if (shellMatch) {
        const candidate = Number(shellMatch[1]);
        if (Number.isSafeInteger(candidate) && candidate > 0) shellPid = candidate;
      }
      const match = new RegExp(`${terminalReadyPrefix}(\\d+)`).exec(output);
      if (!match) return;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        finish(new Error("Agent terminal reported an invalid shell PID."));
        return;
      }
      finish(undefined, pid);
    };
    const timer = setTimeout(() => {
      finish(new Error("Agent terminal did not become visible within 35 seconds."));
    }, terminalReadyTimeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    if (process.platform === "win32") {
      if (!child.stdout) {
        finish(new Error("Agent terminal readiness output is unavailable."));
        return;
      }
      child.stdout.on("data", onData);
      return;
    }
    child.once("spawn", () => {
      const pid = child.pid;
      if (!pid) finish(new Error("Agent process started without a PID."));
      else finish(undefined, pid);
    });
  });
  return { child, ready: () => readiness };
}

const terminalShellPrefix = "PROVIDERDOCK_SHELL:";

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (process.platform !== "win32" || pid === undefined) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}
