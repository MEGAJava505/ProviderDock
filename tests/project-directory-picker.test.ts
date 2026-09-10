import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { windowsFolderPickerScript } from "../src/ui/project-directory-picker.js";

describe("native project directory picker", () => {
  it.skipIf(process.platform !== "win32")(
    "compiles the modern Explorer folder dialog without opening it",
    async () => {
      const marker = "$owner =";
      const compileOnly = `${windowsFolderPickerScript.slice(
        0,
        windowsFolderPickerScript.indexOf(marker),
      )}[Console]::Out.Write("OK")`;

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-Command", compileOnly],
          { encoding: "utf8", windowsHide: true, timeout: 30_000 },
          (error, output) => {
            if (error) reject(error);
            else resolve(output);
          },
        );
      });

      expect(stdout).toBe("OK");
      expect(windowsFolderPickerScript).toContain("PICKFOLDERS");
      expect(windowsFolderPickerScript).toContain("SetOkButtonLabel");
      expect(windowsFolderPickerScript).toContain("dialog.Show(ownerHandle)");
      expect(windowsFolderPickerScript).toContain("CenterScreen");
      expect(windowsFolderPickerScript).toContain("$owner.TopMost = $true");
    },
  );
});
