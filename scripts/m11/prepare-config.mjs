import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { OmpRuntime } from "../../dist/clients/omp/omp-runtime.js";
import { parseProviderProfile } from "../../dist/core/providers/provider-profile.js";

const root = resolve(process.argv[2]);
const statePath = join(root, "private", "state.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
const executable = join(root, "program", "omp.exe");
const binary = await readFile(executable);
const sha256 = createHash("sha256").update(binary).digest("hex");
if (sha256 !== "1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba") {
  throw new Error("Pinned binary mismatch");
}
const project = join(state.workDirectory, "project");
await mkdir(project, { recursive: true });
const runtime = new OmpRuntime({
  rootDirectory: join(state.workDirectory, "managed"),
  artifact: {
    executable,
    sha256,
    sourceCommit: "0c6c981ee5838d97700180383077eb0a3790637c",
  },
  ambientEnvironment: Object.fromEntries(
    ["SYSTEMROOT", "WINDIR", "COMSPEC"].filter(key => process.env[key]).map(key => [key, process.env[key]]),
  ),
  secretStore: { get: async () => undefined },
});
const prepared = await runtime.prepare(randomUUID(), {
  route: {
    profile: parseProviderProfile({
      id: "m11-a1d-inert",
      displayName: "M11 A1-D inert fixture",
      baseUrl: "http://127.0.0.1:9/v1",
      apiType: "openai-chat-completions",
      auth: { kind: "none" },
    }),
    accountId: "inert",
    allowedOrigins: ["http://127.0.0.1:9"],
    models: [{ id: "m11-a1d-fixture-model", contextWindow: 8192, maxTokens: 64, reasoning: false }],
  },
  projectDirectory: project,
  mode: "rpc",
  permissionAcknowledgement: "read-only-pilot-no-sandbox",
});
prepared.args[prepared.args.length - 1] = "acp";
Object.assign(prepared.environment, {
  TEMP: state.workDirectory,
  TMP: state.workDirectory,
  TMPDIR: state.workDirectory,
});
await writeFile(join(root, "private", "prepared.json"), `${JSON.stringify(prepared)}\n`, { flag: "wx", mode: 0o600 });
const configPath = prepared.args[prepared.args.indexOf("--config") + 1];
const modelsPath = join(prepared.agentDirectory, "models.yml");
const updated = {
  ...state,
  preparedAtUtc: new Date().toISOString(),
  preparedArgsCount: prepared.args.length,
  configSha256: createHash("sha256").update(await readFile(configPath)).digest("hex"),
  modelsSha256: createHash("sha256").update(await readFile(modelsPath)).digest("hex"),
  liveCredentialCount: 0,
  providerRequestsPermitted: 0,
  inferencePermitted: false,
};
await writeFile(statePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ prepared: true, liveCredentialCount: 0, inferencePermitted: false, args: prepared.args.length }));
