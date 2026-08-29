import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { secretReferenceSchema } from "../providers/provider-profile.js";
import type { SecretVault } from "./secret-store.js";

const maxSecretLength = 65_536;
const maxProcessOutputBytes = 1_048_576;
const processTimeoutMs = 15_000;

const storedSecretSchema = z
  .object({
    version: z.literal(1),
    reference: secretReferenceSchema,
    protectedValue: z.string().min(1).max(1_048_576),
  })
  .strict();

export interface SecretProtector {
  protect(value: string): Promise<string>;
  unprotect(protectedValue: string): Promise<string>;
}

export class SecretProtectionError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "SecretProtectionError";
  }
}

export interface WindowsDpapiProtectorOptions {
  readonly platform?: NodeJS.Platform;
  readonly powershellExecutable?: string;
}

export class WindowsDpapiProtector implements SecretProtector {
  private readonly platform: NodeJS.Platform;
  private readonly powershellExecutable: string;

  constructor(options: WindowsDpapiProtectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.powershellExecutable = options.powershellExecutable ?? "powershell.exe";
  }

  async protect(value: string): Promise<string> {
    this.assertWindows();
    return runPowerShell(this.powershellExecutable, protectScript, value);
  }

  async unprotect(protectedValue: string): Promise<string> {
    this.assertWindows();
    return runPowerShell(this.powershellExecutable, unprotectScript, protectedValue);
  }

  private assertWindows(): void {
    if (this.platform !== "win32") {
      throw new SecretProtectionError("Windows DPAPI is only available on Windows.");
    }
  }
}

export class DpapiFileSecretVault implements SecretVault {
  constructor(
    private readonly directory: string,
    private readonly protector: SecretProtector,
  ) {}

  async get(referenceInput: string): Promise<string | undefined> {
    const reference = secretReferenceSchema.parse(referenceInput);
    let contents: string;
    try {
      contents = await readFile(this.filePath(reference), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }

    const stored = storedSecretSchema.parse(JSON.parse(contents));
    if (stored.reference !== reference) {
      throw new SecretProtectionError("Stored secret reference does not match its file name.");
    }
    return this.protector.unprotect(stored.protectedValue);
  }

  async set(referenceInput: string, value: string): Promise<void> {
    const reference = secretReferenceSchema.parse(referenceInput);
    if (value.length === 0 || value.length > maxSecretLength) {
      throw new SecretProtectionError(
        `Secret values must contain between 1 and ${maxSecretLength} characters.`,
      );
    }

    const protectedValue = await this.protector.protect(value);
    const stored = storedSecretSchema.parse({ version: 1, reference, protectedValue });
    await mkdir(this.directory, { recursive: true });
    const targetPath = this.filePath(reference);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, targetPath);
  }

  async delete(referenceInput: string): Promise<boolean> {
    const reference = secretReferenceSchema.parse(referenceInput);
    try {
      await unlink(this.filePath(reference));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async listReferences(): Promise<readonly string[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const references: string[] = [];
    for (const fileName of fileNames.filter((name) => name.endsWith(".json"))) {
      const stored = storedSecretSchema.parse(
        JSON.parse(await readFile(join(this.directory, fileName), "utf8")),
      );
      if (this.filePath(stored.reference) !== join(this.directory, fileName)) {
        throw new SecretProtectionError("Stored secret file name is invalid.");
      }
      references.push(stored.reference);
    }
    return references.sort((left, right) => left.localeCompare(right));
  }

  private filePath(reference: string): string {
    const digest = createHash("sha256").update(reference, "utf8").digest("hex");
    return join(this.directory, `${digest}.json`);
  }
}

async function runPowerShell(
  executable: string,
  script: string,
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const fail = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      reject(new SecretProtectionError("Windows DPAPI operation failed.", { cause }));
    };

    child.once("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxProcessOutputBytes) fail();
      else stdout += chunk;
    });
    child.stderr.resume();
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new SecretProtectionError("Windows DPAPI operation failed."));
    });
    child.stdin.once("error", fail);
    timeout = setTimeout(() => fail(), processTimeoutMs);
    child.stdin.end(input, "utf8");
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const protectScript = String.raw`
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($value)
$entropy = [Text.Encoding]::UTF8.GetBytes('ProviderDock/DPAPI/v1')
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const unprotectScript = String.raw`
Add-Type -AssemblyName System.Security
$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$entropy = [Text.Encoding]::UTF8.GetBytes('ProviderDock/DPAPI/v1')
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $entropy,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
