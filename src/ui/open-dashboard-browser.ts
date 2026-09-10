import { spawn } from "node:child_process";

export interface DashboardBrowserCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export function dashboardBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): DashboardBrowserCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Only a loopback HTTP dashboard URL can be opened automatically.");
  }

  if (platform === "win32") {
    return {
      executable: "cmd.exe",
      arguments: ["/d", "/s", "/c", "start", "", parsed.href],
    };
  }
  if (platform === "darwin") {
    return { executable: "open", arguments: [parsed.href] };
  }
  return { executable: "xdg-open", arguments: [parsed.href] };
}

export async function openDashboardInBrowser(url: string): Promise<void> {
  const command = dashboardBrowserCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.arguments], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
