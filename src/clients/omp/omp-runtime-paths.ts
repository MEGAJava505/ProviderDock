import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export interface OmpRuntimePathInput {
  /** Explicit managed state root chosen by the runtime, never an implicit home. */
  readonly rootDirectory: string;
  readonly providerId: string;
  readonly accountId: string;
}

export interface OmpRuntimePaths {
  readonly scopeDirectory: string;
  readonly agentDirectory: string;
  readonly modelsPath: string;
  readonly configPath: string;
  readonly sessionsDirectory: string;
  readonly agentDbPath: string;
}

export class OmpRuntimePathError extends Error {
  readonly code = "INVALID_RUNTIME_PATH";

  constructor() {
    super("OMP runtime path rejected.");
    this.name = "OmpRuntimePathError";
  }
}

/**
 * Pure layout, not provisioning or a symlink/ACL security check. The caller owns
 * creation and containment checks on disk. PI_CODING_AGENT_DIR controls only the
 * agent directory upstream: do not use this result as an absolute PI_CONFIG_DIR.
 * Native loader XDG roots and managed PI_CONFIG_DIR are separate runtime policy.
 */
export function createOmpRuntimePaths(input: OmpRuntimePathInput): OmpRuntimePaths {
  if (
    typeof input.rootDirectory !== "string" || /[\x00-\x1f\x7f]/.test(input.rootDirectory) ||
    typeof input.providerId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.providerId) ||
    typeof input.accountId !== "string" || !input.accountId.trim() ||
    input.accountId.length > 256 || /[\x00-\x1f\x7f\\/]/.test(input.accountId) ||
    input.accountId === "." || input.accountId === ".."
  ) throw new OmpRuntimePathError();
  // Both //server/share and \\server\share are Windows UNC roots. A POSIX join
  // would collapse the first form's // and silently move state off that share.
  const unc = /^[\\/]{2}/.test(input.rootDirectory);
  if (unc && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(input.rootDirectory)) {
    throw new OmpRuntimePathError();
  }
  const paths = unc || /^[A-Za-z]:[\\/]/.test(input.rootDirectory) ? win32 : posix;
  const segments = input.rootDirectory.split(/[\\/]+/);
  if (
    !paths.isAbsolute(input.rootDirectory) ||
    segments.some((part) => part === "." || part === ".." || part.replace(/[ .]+$/, "").toLowerCase() === ".omp") ||
    (paths === win32 && segments.some((part, index) =>
      /[ .]$/.test(part) || /[<>"|?*]/.test(part) ||
      (part.includes(":") && !(index === 0 && /^[A-Za-z]:$/.test(part))),
    ))
  ) throw new OmpRuntimePathError();
  // JSON escapes unpaired UTF-16 surrogates instead of collapsing them in UTF-8.
  const accountKey = createHash("sha256").update(JSON.stringify(input.accountId)).digest("hex");
  const scopeDirectory = paths.join(input.rootDirectory, `provider-${input.providerId}`, `account-${accountKey}`);
  const agentDirectory = paths.join(scopeDirectory, "agent");
  return {
    scopeDirectory, agentDirectory,
    modelsPath: paths.join(agentDirectory, "models.yml"),
    configPath: paths.join(agentDirectory, "config.yml"),
    sessionsDirectory: paths.join(agentDirectory, "sessions"),
    agentDbPath: paths.join(agentDirectory, "agent.db"),
  };
}
