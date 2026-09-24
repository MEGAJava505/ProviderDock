import { describe, expect, it } from "vitest";
import { win32 } from "node:path";
import {
  compileOmpConfig, OmpConfigError, type OmpProviderConfig,
} from "../src/clients/omp/omp-config-compiler.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { resolveOmpChildEnvironment } from "../src/clients/omp/omp-credentials.js";
import { createOmpRuntimePaths } from "../src/clients/omp/omp-runtime-paths.js";
import { providerSecretRevisionFingerprint } from "../src/core/security/secret-revision.js";

function compiled() {
  return compileOmpConfig({
    routes: [{
      profile: parseProviderProfile({
        id: "fixture", displayName: "Fixture", apiType: "openai-chat-completions",
        baseUrl: "https://fixture.invalid/v1", auth: { kind: "bearer", secretRef: "selected.key" },
      }),
      accountId: "selected-account", allowedOrigins: ["https://fixture.invalid"], models: [{ id: "model" }],
    }],
  });
}

/**
 * Self-contained downstream fixture of pin 0c6c981...:
 * model-registry.ts:1909 resolves headers, custom-models.ts:34-40 passes that
 * plaintext to createLiveConfigHeaders, whose materializer resolves it AGAIN.
 * Resolver/materializer branches mirror model-config-values.ts:55-86.
 * No shell API exists in this fixture: command resolution only records input.
 */
function consumePinnedProvider(config: OmpProviderConfig, env: Readonly<NodeJS.ProcessEnv>) {
  const commands: string[] = [];
  const resolveValue = (valueConfig: string): string => {
    if (valueConfig.startsWith("!")) {
      commands.push(valueConfig.slice(1).trim());
      return "recording-stub-output";
    }
    const envValue = Object.hasOwn(env, valueConfig) ? env[valueConfig] : undefined;
    return envValue || valueConfig;
  };
  const materialize = (source?: Readonly<Record<string, string>>, auth = false) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(source ?? {})) {
      const next = resolveValue(value);
      if (next) headers[key] = next;
    }
    if (auth && config.apiKey) {
      const resolvedKey = resolveValue(config.apiKey);
      if (resolvedKey) headers.Authorization = `Bearer ${resolvedKey}`;
    }
    return headers;
  };
  const preResolved = materialize(config.headers);
  return {
    headers: materialize(preResolved, config.authHeader),
    apiKey: config.apiKey ? resolveValue(config.apiKey) : undefined,
    commands,
  };
}

// Includes runtime-only overrides, not merely the credential module's allowlist.
const finalChildNames = [
  "PATH", "HOME", "USERPROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_NATIVE_VARIANT",
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "APPDATA", "LOCALAPPDATA", "FUTURE_RUNTIME_ENV_NAME",
];

describe("OMP child credentials", () => {
  it("binds an authenticated route to the encrypted secret generation, not just its reference", async () => {
    const routeProfile = parseProviderProfile({ id: "fixture", displayName: "Fixture",
      baseUrl: "https://fixture.invalid/v1", auth: { kind: "bearer", secretRef: "selected.key" } });
    const secrets = new MemorySecretStore({ "selected.key": "first-secret" });
    const first = await providerSecretRevisionFingerprint(routeProfile, secrets);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await secrets.set("selected.key", "second-secret");
    expect(await providerSecretRevisionFingerprint(routeProfile, secrets)).not.toBe(first);
    expect(await providerSecretRevisionFingerprint(routeProfile, { get: async () => "second-secret" })).toBeUndefined();
  });
  it("resolves only selected SecretStore refs and never merges ambient credentials or overrides", async () => {
    const config = compiled();
    const envName = config.requiredSecrets[0]!.envName;
    const ambient = Object.freeze({
      Path: "C:\\Windows\\System32;C:\\fixture\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\temp",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD", TERM: "xterm-256color",
      OPENAI_API_KEY: "ambient-marker", ANTHROPIC_AUTH_TOKEN: "ambient-marker",
      OMP_PROFILE: "ambient-marker", PI_PROFILE: "ambient-marker",
      PI_CODING_AGENT_DIR: "ambient-marker", PI_CONFIG_DIR: "ambient-marker",
      CODEX_HOME: "ambient-marker", CLAUDE_CONFIG_DIR: "ambient-marker",
      ANTHROPIC_BASE_URL: "https://evil.invalid", ANTHROPIC_CUSTOM_HEADERS: "ambient-marker",
      NODE_OPTIONS: "--require=evil", BUN_OPTIONS: "ambient-marker",
      HOME: "C:\\real-user", USERPROFILE: "C:\\real-user", APPDATA: "C:\\real-user\\config",
      AWS_SECRET_ACCESS_KEY: "ambient-marker", GITHUB_TOKEN: "ambient-marker",
      HTTP_PROXY: "https://user:ambient-marker@evil.invalid",
      [envName]: "ambient-marker",
    });
    const store = new MemorySecretStore({
      "selected.key": "fixture-selected-secret", "other.key": "fixture-unrelated-secret",
      "portal.cookie": "fixture-cookie",
    });
    const seen: string[] = [];
    const env = await resolveOmpChildEnvironment(config.requiredSecrets, {
      async get(ref) { seen.push(ref); return store.get(ref); },
    }, ambient);
    expect(env).toEqual({
      PATH: ambient.Path, SYSTEMROOT: ambient.SystemRoot, TEMP: ambient.TEMP,
      COMSPEC: ambient.COMSPEC, PATHEXT: ambient.PATHEXT, TERM: ambient.TERM,
      [envName]: "fixture-selected-secret",
    });
    expect(seen).toEqual(["selected.key"]);
    expect(JSON.stringify(env)).not.toContain("ambient-marker");
    expect(JSON.stringify(config)).not.toContain("fixture-selected-secret");
    expect(ambient[envName]).toBe("ambient-marker");
  });

  it.each([undefined, "", "   "])("fails closed on a missing/empty secret (%s), even with ambient fallback", async (value) => {
    const requirements = compiled().requiredSecrets;
    await expect(resolveOmpChildEnvironment(requirements, { async get() { return value; } }, {
      [requirements[0]!.envName]: "fixture-ambient-secret", OPENAI_API_KEY: "fixture-ambient-secret",
      "selected.key": "fixture-ambient-secret",
    })).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it.each(["first\r\nX-Injected: value", "key\0value", " key", "key ", "N/A", "sk-ant-oat-fixture"])(
    "rejects invalid or pin-special credential material without including it in errors (%s)", async (value) => {
      const result = resolveOmpChildEnvironment(compiled().requiredSecrets, new MemorySecretStore({ "selected.key": value }));
      await expect(result).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
      await result.catch((error: unknown) => {
        expect(String(error)).not.toContain(value);
        expect(JSON.stringify(error)).not.toContain(value);
      });
    },
  );

  it("does not leak a SecretStore error or partially resolved keys", async () => {
    const first = compiled().requiredSecrets[0]!;
    const requirements = [first, { secretRef: "missing.key", envName: `PROVIDERDOCK_OMP_${"B".repeat(64)}` }];
    const result = resolveOmpChildEnvironment(requirements, {
      async get(ref) {
        if (ref === first.secretRef) return "fixture-secret-success";
        throw new Error("fixture-secret-failure");
      },
    });
    await expect(result).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain("fixture-secret");
      expect(JSON.stringify(error)).not.toContain("fixture-secret");
      expect((error as Error).cause).toBeUndefined();
    });
  });

  it("validates every requirement before reading secrets and rejects env-name collisions", async () => {
    const requirement = compiled().requiredSecrets[0]!;
    const cases = [
      [requirement, { ...requirement, envName: "PATH" }],
      [{ ...requirement, envName: "OMP_PROFILE" }],
      [{ ...requirement, secretRef: "!command fixture-secret" }],
      [requirement, { ...requirement, secretRef: "different.key" }],
    ];
    for (const required of cases) {
      const seen: string[] = [];
      await expect(resolveOmpChildEnvironment(required, {
        async get(ref) { seen.push(ref); return "fixture-secret"; },
      })).rejects.toMatchObject({ code: "INVALID_REQUIREMENTS" });
      expect(seen).toEqual([]);
    }
  });

  it("reads a shared requested ref once for bearer routes", async () => {
    const first = compiled().requiredSecrets[0]!;
    const second = { ...first, envName: `PROVIDERDOCK_OMP_${"B".repeat(64)}` };
    const seen: string[] = [];
    const environment = await resolveOmpChildEnvironment([first, first, second], {
      async get(ref) { seen.push(ref); return "!literal-not-a-command"; },
    });
    expect(environment).toEqual({
      [first.envName]: "!literal-not-a-command", [second.envName]: "!literal-not-a-command",
    });
    expect(seen).toEqual(["selected.key"]);
  });

  it("returns no implicit environment and rejects ambiguous Windows case aliases", async () => {
    const store = new MemorySecretStore();
    expect(await resolveOmpChildEnvironment([], store)).toEqual({});
    expect(await resolveOmpChildEnvironment([], store, { PATH: "safe", Path: "safe" })).toEqual({ PATH: "safe" });
    await expect(resolveOmpChildEnvironment([], store, { PATH: "safe", Path: "other" }))
      .rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
    await expect(resolveOmpChildEnvironment([], store, { TEMP: "bad\0path" }))
      .rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
  });

  it("does not even inspect values of excluded ambient variables", async () => {
    const ambient: NodeJS.ProcessEnv = { PATH: "safe" };
    Object.defineProperty(ambient, "OPENAI_API_KEY", {
      enumerable: true,
      get() { throw new Error("unrequested ambient secret was accessed"); },
    });
    expect(await resolveOmpChildEnvironment([], new MemorySecretStore(), ambient)).toEqual({ PATH: "safe" });
  });
});

describe("OMP credentials at the pinned downstream consumption seam", () => {
  it.each(["ordinary-fixture-key", "!fixture-command", ...finalChildNames, "OTHER_SELECTED_ENV"])(
    "blocks raw header material before either downstream resolver can reinterpret %s", async (secret) => {
      const other = compiled();
      const otherEnv = other.requiredSecrets[0]!.envName;
      const value = secret === "OTHER_SELECTED_ENV" ? otherEnv : secret;
      for (const [apiType, headerName] of [
        ["openai-chat-completions", "x-api-key"],
        ["openai-chat-completions", "api-key"],
        ["openai-chat-completions", "Authorization"],
        ["openai-responses", "x-api-key"],
        ["openai-responses", "api-key"],
        ["openai-responses", "Authorization"],
        ["anthropic-messages", "Authorization"],
      ] as const) {
        const reads: string[] = [];
        let outcome: unknown;
        try {
          const result = compileOmpConfig({ routes: [{
            profile: parseProviderProfile({
              id: "header-route", displayName: "Fixture", apiType, baseUrl: "https://fixture.invalid/v1",
              auth: { kind: "header", headerName, secretRef: "header.key" },
            }),
            accountId: "one", allowedOrigins: ["https://fixture.invalid"], models: [{ id: "model" }],
          }] });
          const env = await resolveOmpChildEnvironment(result.requiredSecrets, {
            async get(ref) { reads.push(ref); return value; },
          });
          Object.assign(env, Object.fromEntries(finalChildNames.map((name) => [name, "runtime-value"])), {
            [otherEnv]: "other-account-key",
          });
          outcome = consumePinnedProvider(Object.values(result.modelsConfig.providers)[0]!, env);
        } catch (error) {
          if (!(error instanceof OmpConfigError)) throw error;
          outcome = { rejected: error.code };
          expect(String(error)).not.toContain(value);
        }
        expect({ outcome, reads }).toEqual({ outcome: { rejected: "UNSUPPORTED_AUTH" }, reads: [] });
      }
    },
  );

  it.each(["!literal-not-a-command", ...finalChildNames, "OTHER_SELECTED_ENV"])(
    "keeps accepted API-key material literal downstream without unnecessarily rejecting %s", async (secret) => {
      const otherEnv = compiled().requiredSecrets[0]!.envName;
      const value = secret === "OTHER_SELECTED_ENV" ? otherEnv : secret;
      for (const apiType of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
        const result = compileOmpConfig({ routes: [{
          profile: parseProviderProfile({
            id: "bearer-route", displayName: "Fixture", apiType, baseUrl: "https://fixture.invalid/v1",
            auth: { kind: "bearer", secretRef: "selected.key" },
          }),
          accountId: "one", allowedOrigins: ["https://fixture.invalid"], models: [{ id: "model" }],
        }] });
        const env = await resolveOmpChildEnvironment(result.requiredSecrets, new MemorySecretStore({
          "selected.key": value,
        }));
        Object.assign(env, Object.fromEntries(finalChildNames.map((name) => [name, "runtime-value"])), {
          [otherEnv]: "other-account-key",
        });
        expect(consumePinnedProvider(Object.values(result.modelsConfig.providers)[0]!, env)).toEqual({
          apiKey: value, headers: { Authorization: `Bearer ${value}` }, commands: [],
        });
      }
      const native = compileOmpConfig({ routes: [{
        profile: parseProviderProfile({
          id: "native-header", displayName: "Fixture", apiType: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          auth: { kind: "header", headerName: "x-api-key", secretRef: "selected.key" },
        }),
        accountId: "one", allowedOrigins: ["https://api.anthropic.com"], models: [{ id: "model" }],
      }] });
      const nativeEnv = await resolveOmpChildEnvironment(native.requiredSecrets, new MemorySecretStore({
        "selected.key": value,
      }));
      Object.assign(nativeEnv, Object.fromEntries(finalChildNames.map((name) => [name, "runtime-value"])), {
        [otherEnv]: "other-account-key",
      });
      const nativeConfig = Object.values(native.modelsConfig.providers)[0]!;
      expect(nativeConfig.headers).toBeUndefined();
      expect(consumePinnedProvider(nativeConfig, nativeEnv)).toEqual({ apiKey: value, headers: {}, commands: [] });
    },
  );
});

describe("OMP runtime paths (pure, no directories created)", () => {
  it("isolates provider and account state under an explicit root, never an implicit user home", () => {
    const first = createOmpRuntimePaths({
      rootDirectory: "C:\\managed\\omp", providerId: "gateway-a", accountId: "account-one",
    });
    const otherProvider = createOmpRuntimePaths({
      rootDirectory: "C:\\managed\\omp", providerId: "gateway-b", accountId: "account-one",
    });
    const otherAccount = createOmpRuntimePaths({
      rootDirectory: "C:\\managed\\omp", providerId: "gateway-a", accountId: "account-two",
    });
    expect(first.scopeDirectory).toMatch(/^C:\\managed\\omp\\provider-gateway-a\\account-[a-f0-9]{64}$/);
    expect(first).toEqual({
      scopeDirectory: first.scopeDirectory,
      agentDirectory: `${first.scopeDirectory}\\agent`,
      modelsPath: `${first.scopeDirectory}\\agent\\models.yml`,
      configPath: `${first.scopeDirectory}\\agent\\config.yml`,
      sessionsDirectory: `${first.scopeDirectory}\\agent\\sessions`,
      agentDbPath: `${first.scopeDirectory}\\agent\\agent.db`,
    });
    expect(first.scopeDirectory).not.toBe(otherProvider.scopeDirectory);
    expect(first.scopeDirectory).not.toBe(otherAccount.scopeDirectory);
    expect(JSON.stringify(first)).not.toContain(".omp");
    expect(createOmpRuntimePaths({
      rootDirectory: "C:\\managed\\omp", providerId: "gateway-a", accountId: "account-one",
    })).toEqual(first);
  });

  it.each([
    { rootDirectory: "." },
    { rootDirectory: "C:relative" },
    { rootDirectory: "C:\\Users\\fixture\\.omp" },
    { rootDirectory: "C:\\Users\\fixture\\.OMP.\\agent" },
    { rootDirectory: "C:\\Users\\fixture\\.omp::$INDEX_ALLOCATION" },
    { rootDirectory: "C:\\Users\\fixture\\.omp\\..\\elsewhere" },
    { rootDirectory: "/home/fixture/.omp/agent" },
    { rootDirectory: "C:\\managed\\bad\0path" },
    { providerId: "../escape" },
    { providerId: "bad\\path" },
    { providerId: "Bad-case" },
    { providerId: undefined },
    { accountId: "" },
    { accountId: "bad\naccount" },
    { accountId: "../escape" },
    { accountId: ".." },
    { accountId: "account/name" },
    { accountId: "account\\name" },
  ])("rejects unmanaged, aliased or invalid paths/identities: %j", (patch) => {
    expect(() => createOmpRuntimePaths({
      rootDirectory: "C:\\managed\\omp", providerId: "gateway", accountId: "one", ...patch,
    } as never)).toThrowError(expect.objectContaining({ code: "INVALID_RUNTIME_PATH" }));
  });

  it("hashes opaque account identities without lossy slug or Windows device-name collisions", () => {
    const paths = ["account.a", "account-a", "CON", "账户", "\ud800", "\ud801"].map((accountId) =>
      createOmpRuntimePaths({ rootDirectory: "/managed/omp", providerId: "con", accountId }),
    );
    expect(new Set(paths.map((item) => item.scopeDirectory)).size).toBe(6);
    for (const item of paths) {
      expect(item.scopeDirectory).toMatch(/^\/managed\/omp\/provider-con\/account-[a-f0-9]{64}$/);
    }
  });

  it("preserves the same UNC share for forward and backslash roots without touching either location", () => {
    const slashRoot = "//fixture-server/fixture-share/managed";
    const backslashRoot = "\\\\fixture-server\\fixture-share\\managed";
    const slash = createOmpRuntimePaths({
      rootDirectory: slashRoot, providerId: "fixture", accountId: "one",
    });
    const backslash = createOmpRuntimePaths({
      rootDirectory: backslashRoot, providerId: "fixture", accountId: "one",
    });
    expect(slash).toEqual(backslash);
    for (const path of Object.values(slash)) {
      const relative = win32.relative(slashRoot, path);
      expect(win32.isAbsolute(relative)).toBe(false);
      expect(relative.split(win32.sep)).not.toContain("..");
      expect(path.startsWith(`${backslashRoot}\\`)).toBe(true);
    }
  });

  it.each(["//fixture-server", "//fixture-server/", "///fixture-server/share", "\\\\fixture-server"])(
    "rejects an incomplete or ambiguous UNC root instead of guessing a local destination: %s", (rootDirectory) => {
      expect(() => createOmpRuntimePaths({ rootDirectory, providerId: "fixture", accountId: "one" }))
        .toThrowError(expect.objectContaining({ code: "INVALID_RUNTIME_PATH" }));
    },
  );
});
