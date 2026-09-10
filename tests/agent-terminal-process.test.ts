import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentTerminalSpawnSpec } from "../src/clients/agent-terminal-process.js";

describe("agent terminal process", () => {
  const request = {
    executable: "codex",
    args: ["--profile", "providerdock-test"],
    cwd: "C:\\Projects\\Example Project",
    environment: { PATH: "C:\\Tools" },
  };

  it("opens Windows agents through a hidden wrapper and foreground terminal", () => {
    const specification = agentTerminalSpawnSpec(request, "win32");

    expect(specification.executable).toBe("powershell.exe");
    expect(specification.options.windowsHide).toBe(true);
    expect(specification.options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    const encodedCommand = specification.args.at(-1);
    expect(encodedCommand).toBeTruthy();
    const script = Buffer.from(encodedCommand ?? "", "base64").toString("utf16le");
    expect(script).toContain("Start-Process @startParameters");
    expect(script).toContain("WindowStyle = 'Normal'");
    expect(script).toContain("ProviderDockForegroundWindow]::Activate");
    expect(script).toContain("SetForegroundWindow");
    expect(script).toContain("Get-Command wt.exe");
    expect(script).toContain("'--inheritEnvironment'");
    expect(script).toContain("$agentShell.WaitForExit()");
    expect(script).toContain("PROVIDERDOCK_READY:");
    expect(script).toContain("The agent terminal did not become visible within 30 seconds.");
    expect(specification.args.join(" ").length).toBeLessThan(32700);
    const payload = JSON.parse(Buffer.from(String(specification.options.env?.PROVIDERDOCK_TERMINAL_PAYLOAD), "base64").toString("utf8"));
    expect(payload).toEqual({ executable: request.executable, arguments: request.args, cwd: request.cwd });
    expect(script).toContain("System32\\conhost.exe");
    const terminalCommand = script.match(/\$terminalCommand = '([^']+)'/)?.[1];
    const terminalScript = Buffer.from(terminalCommand ?? "", "base64").toString(
      "utf16le",
    );
    expect(terminalScript).toContain("& $agentExecutable @launchArgs");
    const large=agentTerminalSpawnSpec({...request,args:["literal ' $() ` ; &", "a".repeat(15000)]},"win32");
    expect(large.args.join(" ").length).toBe(specification.args.join(" ").length);
    expect(terminalScript).toContain("$elapsed -lt 3");
    expect(terminalScript).toContain("Read-Host 'Нажмите Enter, чтобы закрыть окно'");
  });

  it("keeps direct inherited stdio on non-Windows platforms", () => {
    const specification = agentTerminalSpawnSpec(request, "linux");

    expect(specification.executable).toBe("codex");
    expect(specification.args).toEqual(request.args);
    expect(specification.options.stdio).toBe("inherit");
  });

  it.skipIf(process.platform !== "win32")(
    "compiles the foreground-window helper without launching an agent",
    async () => {
      const specification = agentTerminalSpawnSpec(request, "win32");
      const encodedCommand = specification.args.at(-1) ?? "";
      const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
      const helperStart = script.indexOf("Add-Type -TypeDefinition");
      const helperEnd = script.indexOf("$terminalCommand =");
      const compileOnly = "$ErrorActionPreference = 'Stop'\n" +
        script.slice(helperStart, helperEnd) + '[Console]::Out.Write("OK")';
      const encodedCompileOnly = Buffer.from(compileOnly, "utf16le").toString("base64");

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCompileOnly],
          { encoding: "utf8", windowsHide: true, timeout: 30_000 },
          (error, output) => {
            if (error) reject(error);
            else resolve(output);
          },
        );
      });

      expect(stdout.trim()).toBe("OK");
    },
  );

  it("starts the dashboard hidden when the batch file is double-clicked", async () => {
    const batch = await readFile(join(process.cwd(), "ProviderDock.bat"), "utf8");

    expect(batch).toContain("Start-Process -FilePath 'node.exe'");
    expect(batch).toContain("-WindowStyle Hidden");
    expect(batch).toContain("'dashboard','--open'");
  });
});
