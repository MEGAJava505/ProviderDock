import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { assessOmpProviderMappings } from "../src/migration/omp-provider-mapping.js";
import { inventoryOmpProviderMappings } from "../src/migration/omp-provider-inventory.js";
import type { MigrationSourcePolicy } from "../src/migration/migration-manifest.js";

function profile(overrides: Record<string, unknown> = {}) {
  return parseProviderProfile({
    id: "gateway", displayName: "Gateway", baseUrl: "https://gateway.invalid/v1",
    apiType: "openai-chat-completions", auth: { kind: "bearer", secretRef: "gateway.key" },
    manualModelIds: ["vendor/claude-gpt:exact"], ...overrides,
  });
}

describe("read-only OMP provider mapping assessment", () => {
  it("classifies explicit configuration but never fabricates migration acceptance or identity", () => {
    const input = [profile()];
    const before = JSON.stringify(input);
    const report = assessOmpProviderMappings(input);
    const row = report.providers[0]!;
    expect(report).toMatchObject({ version: 1, purpose: "offline-assessment-not-launch-authorization", counts: { total: 1, enabled: 1 } });
    expect(row).toMatchObject({
      providerId: "gateway", status: "pending",
      declared: { baseUrl: "https://gateway.invalid/v1", apiType: "openai-chat-completions", authKind: "bearer" },
      accountId: null, approvedOrigins: [], portalAssociation: "unknown-not-inferred",
      configuredModels: [{ id: "vendor/claude-gpt:exact", sources: ["manual"], disabled: false, compiler: "passed" }],
      transportTrials: [{ protocol: "openai-chat-completions", compiler: "passed" }],
    });
    expect(row.unresolved).toEqual(expect.arrayContaining([
      "ACCOUNT_IDENTITY_REQUIRED", "ORIGIN_CONFIRMATION_REQUIRED", "MODEL_CAPABILITIES_UNVERIFIED", "REAL_PILOT_NOT_APPROVED",
    ]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not infer an auto protocol from brand, adapter, model, URL, or a passing transport trial", () => {
    const row = assessOmpProviderMappings([profile({
      apiType: "auto", adapterId: "generic-anthropic", manualModelIds: ["claude-opus", "gpt-model"],
    })]).providers[0]!;
    expect(row.unresolved).toContain("PROTOCOL_UNRESOLVED");
    expect(row.configuredModels.map((m) => m.compiler)).toEqual(["PROTOCOL_UNRESOLVED", "PROTOCOL_UNRESOLVED"]);
    expect(row.transportTrials).toHaveLength(3);
    expect(row.transportTrials.every((trial) => trial.compiler === "passed")).toBe(true);
    expect(row.status).toBe("pending");
    expect(row).not.toHaveProperty("protocolMappings");
  });

  it("reports header restrictions independently of auto's unresolved protocol", () => {
    const row = assessOmpProviderMappings([profile({
      apiType: "auto", staticHeaders: { "User-Agent": "private-header-value", Originator: "!do-not-run" },
    })]).providers[0]!;
    expect(row.transportTrials.every((trial) => trial.compiler === "UNSUPPORTED_HEADERS")).toBe(true);
    expect(row.unresolved).toEqual(expect.arrayContaining(["PROTOCOL_UNRESOLVED", "UNSUPPORTED_HEADERS"]));
    expect(row.declared.staticHeaderNames).toEqual(["Originator", "User-Agent"]);
    expect(JSON.stringify(row)).not.toContain("private-header-value");
    expect(JSON.stringify(row)).not.toContain("!do-not-run");
  });

  it("rejects third-party Messages x-api-key instead of silently changing it to bearer", () => {
    const row = assessOmpProviderMappings([profile({
      apiType: "anthropic-messages", auth: { kind: "header", headerName: "x-api-key", secretRef: "gateway.key" },
    })]).providers[0]!;
    expect(row.declared.authKind).toBe("header");
    expect(row.declared.authHeaderName).toBe("x-api-key");
    expect(row.transportTrials).toEqual([{ protocol: "anthropic-messages", compiler: "UNSUPPORTED_AUTH" }]);
    expect(row.unresolved).toContain("UNSUPPORTED_AUTH");
    expect(row.status).toBe("pending"); // Not a user-accepted unsupported profile.
  });

  it("retains native official Messages support without accepting the real account", () => {
    const row = assessOmpProviderMappings([profile({
      baseUrl: "https://api.anthropic.com", apiType: "anthropic-messages",
      auth: { kind: "header", headerName: "x-api-key", secretRef: "gateway.key" },
    })]).providers[0]!;
    expect(row.transportTrials[0]!.compiler).toBe("passed");
    expect(row.accountId).toBeNull();
    expect(row.approvedOrigins).toEqual([]);
  });

  it.each([
    { auth: { kind: "header", headerName: "Authorization", secretRef: "gateway.key" } },
    { auth: { kind: "query", parameterName: "api_key", secretRef: "gateway.key" } },
    { baseUrl: "https://account.openai.azure.com/v1" },
    { secretHeaders: { "X-Custom-Key": "private.reference" } },
    { queryParameters: { region: "private-query-value" } },
  ])("keeps unsupported transports pending: %j", (overrides) => {
    const row = assessOmpProviderMappings([profile(overrides)]).providers[0]!;
    expect(row.transportTrials[0]!.compiler).not.toBe("passed");
    expect(row.status).toBe("pending");
    expect(JSON.stringify(row)).not.toContain("private-query-value");
  });

  it("preserves a nonstandard path; does not add /v1 or select a protocol", () => {
    const row = assessOmpProviderMappings([profile({ baseUrl: "https://gateway.invalid/api/chat", apiType: "auto" })]).providers[0]!;
    expect(row.declared.baseUrl).toBe("https://gateway.invalid/api/chat");
    expect(row.unresolved).toContain("PROTOCOL_UNRESOLVED");
    expect(row.approvedOrigins).toEqual([]);
  });

  it("does not turn an empty model list or a literal model 'auto' into a chosen model/protocol", () => {
    const empty = assessOmpProviderMappings([profile({ manualModelIds: [] })]).providers[0]!;
    expect(empty.configuredModels).toEqual([]);
    expect(empty.unresolved).toContain("MODEL_SELECTION_REQUIRED");
    expect(empty.transportTrials[0]!.compiler).toBe("passed"); // Shape trial uses an explicitly synthetic model.
    const literal = assessOmpProviderMappings([profile({ manualModelIds: ["auto"] })]).providers[0]!;
    expect(literal.configuredModels[0]).toMatchObject({ id: "auto", compiler: "passed" });
    expect(literal.declared.apiType).toBe("openai-chat-completions");
  });

  it("keeps same-origin profiles distinct, counts drift, and never drops an eighteenth profile", () => {
    const rows = Array.from({ length: 18 }, (_, i) => profile({ id: `account-${i}` }));
    const report = assessOmpProviderMappings(rows, { expectedProviderCount: 17 });
    expect(report.counts).toMatchObject({ total: 18, enabled: 18, expected: 17, drift: true });
    expect(new Set(report.providers.map((r) => r.providerId)).size).toBe(18);
    expect(report.providers.every((r) => r.accountId === null && r.status === "pending")).toBe(true);
  });

  it("does not invent missing critical fields using schema defaults", () => {
    for (const key of ["id", "baseUrl", "auth", "apiType"] as const) {
      const raw: Record<string, unknown> = { ...profile() };
      delete raw[key];
      expect(() => assessOmpProviderMappings([raw])).toThrow("INVALID_PROVIDER_EVIDENCE");
    }
    expect(() => assessOmpProviderMappings([profile(), profile()])).toThrow("DUPLICATE_PROVIDER_ID");
  });

  it("does not expose credentials embedded in an invalid URL or parser error", () => {
    for (const baseUrl of [
      "https://user:private-password@gateway.invalid/v1",
      "https://gateway.invalid/v1?token=private-query-token",
      "https://gateway.invalid/v1#private-fragment",
    ]) {
      const row = assessOmpProviderMappings([profile({ baseUrl })]).providers[0]!;
      expect(row.declared.baseUrl).toBeNull();
      expect(row.transportTrials[0]!.compiler).toBe("INVALID_URL");
      expect(JSON.stringify(row)).not.toMatch(/private-password|private-query-token|private-fragment/);
    }
    expect(() => assessOmpProviderMappings([{ rawSecret: "private-value" }])).toThrow("INVALID_PROVIDER_EVIDENCE");
  });

  it("preserves model provenance/disabled status without silently downgrading capabilities", () => {
    const row = assessOmpProviderMappings([profile({
      manualModelIds: ["first", "disabled", "glob*"],
      modelPricing: { first: { inputPerMillion: 1, outputPerMillion: 2 }, priced: { inputPerMillion: 1, outputPerMillion: 2 } },
      disabledModelIds: ["DISABLED"],
    })]).providers[0]!;
    expect(row.configuredModels).toEqual([
      { id: "first", sources: ["manual", "pricing"], disabled: false, compiler: "passed" },
      { id: "disabled", sources: ["manual"], disabled: true, compiler: "MODEL_DISABLED" },
      { id: "glob*", sources: ["manual"], disabled: false, compiler: "UNSUPPORTED_MODEL_SELECTOR" },
      { id: "priced", sources: ["pricing"], disabled: false, compiler: "passed" },
    ]);
    expect(row.unresolved).toContain("MODEL_CAPABILITIES_UNVERIFIED");
    expect(row.featurePolicy).toBe("no-feature-downgrade; responses-namespace-not-chat-compatible");
  });

  it("fingerprints complete profile evidence so auth, endpoint, headers and model changes invalidate it", () => {
    const original = assessOmpProviderMappings([profile()]).providers[0]!.profileSha256;
    for (const overrides of [
      { auth: { kind: "bearer", secretRef: "other.key" } },
      { baseUrl: "https://gateway.invalid/custom" },
      { staticHeaders: { "X-Flag": "new" } },
      { manualModelIds: ["different-model"] },
    ]) {
      expect(assessOmpProviderMappings([profile(overrides)]).providers[0]!.profileSha256).not.toBe(original);
    }
    expect(assessOmpProviderMappings([profile()]).providers[0]!.profileSha256).toBe(original);
  });

  it("rejects undefined or omitted transport evidence rather than defaulting it", () => {
    for (const field of [
      "auth", "apiType", "enabled", "staticHeaders", "secretHeaders",
      "queryParameters", "manualModelIds", "disabledModelIds", "modelPricing",
    ]) {
      const missing: Record<string, unknown> = { ...profile() };
      delete missing[field];
      expect(() => assessOmpProviderMappings([missing])).toThrow("INVALID_PROVIDER_EVIDENCE");
      expect(() => assessOmpProviderMappings([{ ...profile(), [field]: undefined }]))
        .toThrow("INVALID_PROVIDER_EVIDENCE");
    }
  });

  it("rejects critical normalization and schema-discarded header names", () => {
    for (const overrides of [
      { id: " gateway " }, { baseUrl: " https://gateway.invalid/v1 " },
      { baseUrl: "https://gateway.invalid/v1/" }, { manualModelIds: [" model "] },
      { auth: { kind: "bearer", secretRef: " gateway.key " } },
      { staticHeaders: JSON.parse('{"__proto__":"private-value"}') },
    ]) {
      // Patch raw evidence AFTER parsing so the test does not normalize it.
      expect(() => assessOmpProviderMappings([{ ...profile(), ...overrides }]))
        .toThrow("INVALID_PROVIDER_EVIDENCE");
    }
  });

  it("does not echo complete header lines or query assignments disguised as names", () => {
    for (const overrides of [
      { auth: { kind: "header", headerName: "Authorization: Bearer PRIVATE_VALUE", secretRef: "key" } },
      { staticHeaders: { "X-Header: PRIVATE_VALUE": "other" } },
      { secretHeaders: { "X-Key: PRIVATE_VALUE": "key" } },
      { queryParameters: { "token=PRIVATE_VALUE": "other" } },
    ]) {
      expect(() => assessOmpProviderMappings([{ ...profile(), ...overrides }]))
        .toThrow("INVALID_PROVIDER_EVIDENCE");
    }
  });

  it("withholds unreviewed URL paths including encoded credentials, without rewriting endpoints", () => {
    for (const baseUrl of [
      "https://gateway.invalid/proxy/PRIVATE_VALUE/v1",
      "https://gateway.invalid/v1%3Ftoken%3DPRIVATE_VALUE",
      "https://gateway.invalid/PRIVATE_VALUE/../v1",
      "https://gateway.invalid/PRIVATE_VALUE/.\t./v1",
      "https://gateway.invalid/PRIVATE_VALUE/.\r./v1",
      "https://gateway.invalid/PRIVATE_VALUE/.\n./v1",
    ]) {
      const row = assessOmpProviderMappings([profile({ baseUrl })]).providers[0]!;
      expect(row.declared.baseUrl).toBeNull();
      expect(row.unresolved).toContain("ENDPOINT_REVIEW_REQUIRED");
      expect(JSON.stringify(row)).not.toContain("PRIVATE_VALUE");
      expect(row.approvedOrigins).toEqual([]);
    }
  });

  it("isolates transport shape trials from disabled-provider and synthetic-model restrictions", () => {
    const row = assessOmpProviderMappings([profile({
      enabled: false, disabledModelIds: ["offline-shape-trial"],
      staticHeaders: { "X-Flag": "private-value" },
    })]).providers[0]!;
    expect(row.transportTrials).toEqual([{ protocol: "openai-chat-completions", compiler: "UNSUPPORTED_HEADERS" }]);
    expect(row.configuredModels[0]!.compiler).toBe("PROVIDER_DISABLED");
    expect(row.unresolved).toEqual(expect.arrayContaining(["PROVIDER_DISABLED", "UNSUPPORTED_HEADERS"]));
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-provider-inventory-"));
  for (const folder of ["providers", "portals", "secrets"]) await mkdir(join(root, folder));
  const profile = parseProviderProfile({
    id: "gateway", displayName: "Gateway", baseUrl: "https://gateway.invalid/v1",
    apiType: "openai-chat-completions", auth: { kind: "bearer", secretRef: "fixture.key" },
    manualModelIds: ["exact-model"],
  });
  const secretPath = `secrets/${createHash("sha256").update("fixture.key").digest("hex")}.json`;
  // Ciphertext is intentionally NOT a parseable vault document.
  await writeFile(join(root, secretPath), "DO_NOT_PARSE_OR_DECRYPT");
  await writeFile(join(root, "providers/providers.json"), JSON.stringify([profile]));
  await writeFile(join(root, "portals/accounts.json"), Buffer.alloc(72));
  const source: MigrationSourcePolicy = { root, files: [
    { relativePath: "providers/providers.json", kind: "provider-metadata" },
    { relativePath: "portals/accounts.json", kind: "portal-metadata" },
    { relativePath: secretPath, kind: "protected-secret" },
  ] };
  return { root, profile, secretPath, source };
}

describe("OMP provider evidence inventory", () => {
  it("hashes an explicit allowlist read-only and does not parse secrets or repair portals", async () => {
    const { source, root } = await fixture();
    const before = await Promise.all(source.files.map((f) => readFile(join(root, f.relativePath))));
    const report = await inventoryOmpProviderMappings(source, { expectedProviderCount: 17 });
    expect(report.assessment.counts).toMatchObject({ total: 1, expected: 17, drift: true });
    expect(report.assessment.providers[0]!.portalAssociation).toBe("unknown-not-inferred");
    expect(report.manifest.files).toHaveLength(3);
    expect(report.manifest.files.find((f) => f.kind === "portal-metadata")!.validation).toBe("nul-bytes");
    expect(report.manifest.files.find((f) => f.kind === "protected-secret")!.validation).toBe("not-inspected");
    expect(report.credentialEvidence).toEqual([{
      providerId: "gateway", requirements: [{ role: "auth", fileStatus: "present-not-decrypted" }],
    }]);
    expect(report.sourceUnchangedAtVerification).toBe(true);
    expect(report.quiescentBackup).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/fixture\.key|DO_NOT_PARSE_OR_DECRYPT/);
    expect(await readdir(join(root, "portals"))).toEqual(["accounts.json"]);
    expect(await Promise.all(source.files.map((f) => readFile(join(root, f.relativePath))))).toEqual(before);
  });

  it("does not claim missing or non-allowlisted ciphertext is usable or unused", async () => {
    const { source } = await fixture();
    const report = await inventoryOmpProviderMappings({ ...source, files: source.files.slice(0, 2) });
    expect(report.credentialEvidence[0]!.requirements[0]!.fileStatus).toBe("not-in-inventory");
    expect(report.assessment.providers[0]!.unresolved).toContain("CREDENTIAL_AVAILABILITY_UNVERIFIED");
  });

  it("refuses ambiguous provider sources instead of choosing one", async () => {
    const { source, root, profile } = await fixture();
    await writeFile(join(root, "providers/other.json"), JSON.stringify([profile]));
    await expect(inventoryOmpProviderMappings({ ...source, files: [
      ...source.files, { relativePath: "providers/other.json", kind: "provider-metadata" },
    ] })).rejects.toThrow("AMBIGUOUS_PROVIDER_SOURCE");
  });

  it("never invokes schema defaults for absent auth in otherwise valid metadata", async () => {
    const { source, root, profile } = await fixture();
    const { auth: _auth, ...withoutAuth } = profile;
    await writeFile(join(root, "providers/providers.json"), JSON.stringify([withoutAuth]));
    await expect(inventoryOmpProviderMappings(source)).rejects.toThrow("INVALID_PROVIDER_EVIDENCE");
  });

  it("fails safely on corrupt provider evidence without logging parser input", async () => {
    const { source, root } = await fixture();
    await writeFile(join(root, "providers/providers.json"), "SECRET_INVALID_JSON");
    await expect(inventoryOmpProviderMappings(source)).rejects.toThrow("INVALID_METADATA");
  });
});
