// Step 4 wire-shape test, NOT provider compatibility/identity/approval.
// Reads only a sanitized offline inventory. Never opens the real vault or uses
// a real origin. Every actual OMP request must hit this loopback fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OmpRuntime } from "../dist/clients/omp/omp-runtime.js";
import { ompConfigSchemaCommit } from "../dist/clients/omp/omp-config-compiler.js";
import { parseProviderProfile } from "../dist/core/providers/provider-profile.js";
import {
  parseSmokeInventory, assertFDriveOutput, hasExpectedRequestShape, containsKey,
} from "./lib/omp-provider-smoke-policy.mjs";

try {
  await main();
} catch {
  // Parser/IO/assertion errors may contain compared values or secret-bearing
  // input. No raw error, cause, stack, argv, stdout or stderr escapes this CLI.
  console.error("OMP_LOCAL_SMOKE_FAILED");
  process.exitCode = 1;
}

async function main() {
const { values } = parseArgs({ strict: true, options: {
  inventory: { type: "string" }, executable: { type: "string" }, "output-root": { type: "string" },
} });
for (const key of ["inventory", "executable", "output-root"]) {
  assert.ok(values[key] && isAbsolute(values[key]), `Explicit absolute --${key} required`);
}
assertFDriveOutput(values["output-root"]);
assertFDriveOutput(await realpath(values["output-root"]));
const inventoryBytes = await readFile(values.inventory);
const assessment = parseSmokeInventory(inventoryBytes.toString("utf8"));
assert.equal(assessment.compilerSourceCommit, ompConfigSchemaCommit);
assert.equal(assessment.providers.length, assessment.counts.total);
assert.equal(new Set(assessment.providers.map(p => p.providerId)).size, assessment.counts.total);
const executable = resolve(values.executable);
const executableSha256 = await hashFile(executable);
assert.equal(executableSha256, "1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba");
// Caller chooses an existing trusted output root on F: for large native assets.
const root = await mkdtemp(join(resolve(values["output-root"]), "provider-local-smoke-"));
const project = join(root, "проект с пробелами");
await mkdir(project);
await writeFile(join(project, "read-fixture.txt"), "OMP_MAPPING_READ_RESULT", { flag: "wx" });
const key = `!OMP_MAPPING_FIXTURE_${randomUUID()}`;
const runtime = new OmpRuntime({
  rootDirectory: join(root, "managed"),
  artifact: { executable, sha256: executableSha256, sourceCommit: ompConfigSchemaCommit },
  secretStore: { get: async reference => { assert.equal(reference, "fixture.key"); return key; } },
  ambientEnvironment: process.env,
});
let active;
const event = (data, name) =>
  `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const server = createServer(async (req, res) => {
  try {
    let source = "";
    for await (const part of req) {
      source += part;
      assert.ok(source.length < 1024 * 1024, "Request too large");
    }
    const body = JSON.parse(source);
    active.requests++;
    assert.equal(req.method, "POST");
    assert.equal(req.url, active.endpoint);
    assert.equal(body.model, active.modelId);
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.equal(req.headers["x-api-key"], undefined);
    const toolCall = active.useTool && active.requests === 1;
    assert.ok(hasExpectedRequestShape(body, active.protocol, active.useTool,
      active.useTool && !toolCall));
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
      id: "chat-local-fixture", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (active.protocol === "openai-chat-completions") {
      res.end(toolCall
        ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call-local-fixture", type: "function",
          function: { name: "read", arguments: '{"path":"read-fixture.txt"}' } }] })
          + chunk({}, "tool_calls") + "data: [DONE]\n\n"
        : chunk({ role: "assistant", content: "OMP_MAPPING_FIXTURE_OK" })
          + chunk({}, "stop") + "data: [DONE]\n\n");
    } else {
      const item = toolCall
        ? { id: "out-tool-local-fixture", type: "function_call", call_id: "call-local-fixture",
          name: "read", arguments: '{"path":"read-fixture.txt"}', status: "completed" }
        : { id: "out-local-fixture", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "OMP_MAPPING_FIXTURE_OK", annotations: [] }] };
      const response = { id: "resp-local-fixture", object: "response", status: "completed",
        model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.end(event({ type: "response.created", sequence_number: 0,
        response: { ...response, status: "in_progress", output: [] } })
        + event({ type: "response.output_item.added", sequence_number: 1, output_index: 0,
          item: toolCall ? { ...item, arguments: "", status: "in_progress" }
            : { ...item, status: "in_progress", content: [] } })
        + (toolCall
          ? event({ type: "response.function_call_arguments.delta", sequence_number: 2,
            output_index: 0, item_id: item.id, delta: item.arguments })
          : event({ type: "response.content_part.added", sequence_number: 2, output_index: 0,
            item_id: item.id, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] } })
            + event({ type: "response.output_text.delta", sequence_number: 3, output_index: 0,
              item_id: item.id, content_index: 0, delta: "OMP_MAPPING_FIXTURE_OK" }))
        + event({ type: "response.output_item.done", sequence_number: 4, output_index: 0, item })
        + event({ type: "response.completed", sequence_number: 5, response }));
    }
  } catch {
    // No assertion error strings: they can contain compared authorization.
    if (active) active.wireAssertionFailed = true;
    res.writeHead(400); res.end("{}");
  }
});
server.listen(0, "127.0.0.1");
await new Promise((accept, reject) => { server.once("listening", accept); server.once("error", reject); });
const loopback = `http://127.0.0.1:${server.address().port}`;
const results = [];
const skipped = [];
try {
  for (const row of assessment.providers) {
    assert.equal(row.status, "pending");
    const d = row.declared;
    const models = row.configuredModels.filter(m => !m.disabled && m.compiler === "passed");
    const endpointSuffix = d.apiType === "openai-chat-completions" ? "/chat/completions"
      : d.apiType === "openai-responses" ? "/responses" : undefined;
    if (endpointSuffix === undefined || d.authKind !== "bearer" ||
        d.staticHeaderNames.length || d.secretHeaderNames.length || d.queryParameterNames.length ||
        !models.length || !d.baseUrl) {
      skipped.push({ providerId: row.providerId, profileSha256: row.profileSha256,
        reason: "no-supported-explicit-model-route", unresolved: row.unresolved });
      continue;
    }
    // Preserve only the path, never the hostname/port/credentials of the source.
    const sourceUrl = new URL(d.baseUrl);
    assert.ok(!sourceUrl.username && !sourceUrl.password && !sourceUrl.search && !sourceUrl.hash);
    const basePath = sourceUrl.pathname.replace(/\/+$/, "");
    assert.ok(!/[\\%?#]/.test(basePath) && !basePath.startsWith("//"));
    const baseUrl = `${loopback}${basePath}`;
    assert.equal(new URL(baseUrl).origin, loopback);
    for (const model of models) for (const useTool of [false, true]) {
      active = { endpoint: `${basePath}${endpointSuffix}`, modelId: model.id,
        protocol: d.apiType, useTool, requests: 0, wireAssertionFailed: false };
      const prepared = await runtime.prepare(randomUUID(), {
        route: {
          profile: parseProviderProfile({
            id: row.providerId, displayName: "Offline wire-shape fixture",
            baseUrl, apiType: d.apiType, auth: { kind: "bearer", secretRef: "fixture.key" },
          }),
          accountId: "local-fixture-not-real-account", allowedOrigins: [loopback],
          // Do not invent real capability settings. The fixture only tests wire
          // serialization of this exact literal ID, not its real capabilities.
          models: [{ id: model.id }],
        },
        projectDirectory: project, mode: "tui",
        permissionAcknowledgement: "read-only-pilot-no-sandbox",
      });
      const args = prepared.args.filter((arg, i, list) =>
        useTool || (arg !== "--tools" && list[i - 1] !== "--tools"));
      args.push(...(useTool ? [] : ["--no-tools"]), "--no-session", "--print",
        useTool ? "Read read-fixture.txt, then reply OMP_MAPPING_FIXTURE_OK" : "Reply OMP_MAPPING_FIXTURE_OK");
      const child = spawn(prepared.executable, args, {
        cwd: prepared.cwd, env: prepared.environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "", timedOut = false, tooMuchOutput = false;
      child.stdout.on("data", b => { stdout += b; if (stdout.length > 1024 * 1024) { tooMuchOutput = true; child.kill(); } });
      child.stderr.on("data", b => { stderr += b; if (stderr.length > 1024 * 1024) { tooMuchOutput = true; child.kill(); } });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45_000);
      let exitCode;
      try {
        exitCode = await new Promise((accept, reject) => {
          child.once("error", () => reject(new Error("FIXTURE_SPAWN_FAILED")));
          child.once("close", code => accept(code));
        });
      } finally { clearTimeout(timer); }
      const keyInOutput = stdout.includes(key) || stderr.includes(key);
      const keyOnDisk = await containsKey(root, Buffer.from(key));
      const passed = exitCode === 0 && !timedOut && !tooMuchOutput && !active.wireAssertionFailed &&
        active.requests === (useTool ? 2 : 1) && stdout.includes("OMP_MAPPING_FIXTURE_OK") && !keyInOutput && !keyOnDisk;
      const result = { providerId: row.providerId, profileSha256: row.profileSha256, modelId: model.id,
        protocol: d.apiType, useTool, requests: active.requests, exitCode, timedOut, tooMuchOutput,
        wireAssertionFailed: active.wireAssertionFailed, keyInOutput, keyOnDisk, passed };
      results.push(result);
      console.log(JSON.stringify(result)); // Never stdout/stderr, raw frames or env.
      assert.ok(passed, "LOCAL_PROFILE_SMOKE_FAILED");
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise(accept => server.close(accept));
  await writeFile(join(root, "report.json"), JSON.stringify({
    purpose: "loopback-wire-shape-only-not-real-provider-acceptance",
    inventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"),
    executableSha256, sourceCommit: ompConfigSchemaCommit, root,
    results, skipped, allProfilesAccountedFor: new Set([
      ...results.map(r => r.providerId), ...skipped.map(r => r.providerId),
    ]).size === assessment.counts.total,
  }, null, 2) + "\n", { flag: "wx" });
}
assert.ok(results.length, "NO_ELIGIBLE_MODELS");
console.log(JSON.stringify({ result: "passed", cases: results.length, skipped: skipped.length, root }));
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
