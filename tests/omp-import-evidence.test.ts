import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { inventoryOmpProviderMappings } from "../src/migration/omp-provider-inventory.js";
import type { MigrationSourcePolicy } from "../src/migration/migration-manifest.js";
import {
  isAutomatedNativeImportSupported,
  OMP_IMPORT_CAPABILITY,
  PINNED_OMP_COMMIT,
  type OmpImportCapability,
} from "../src/migration/omp-import-capability.js";

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

describe("OMP import capability verdict", () => {
  it("reports the automated native import as unsupported with content-free blockers", () => {
    expect(OMP_IMPORT_CAPABILITY.route).toBe("unsupported-automated-native-import");
    expect(isAutomatedNativeImportSupported()).toBe(false);
    expect(OMP_IMPORT_CAPABILITY.blockers).toContain("cli-factory-hardcodes-home-source-root");
    expect(OMP_IMPORT_CAPABILITY.blockers).toContain("codex-store-requires-bun-sqlite-runtime");
    // Reasons must stay identifiers, never transcript content or absolute paths.
    for (const blocker of OMP_IMPORT_CAPABILITY.blockers) {
      expect(blocker).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("still records what the importer genuinely supports, to avoid under-claiming", () => {
    expect(OMP_IMPORT_CAPABILITY.supported.explicitSourceRootAtClassLevel).toBe(true);
    expect(OMP_IMPORT_CAPABILITY.supported.isolatedTargetSessionDir).toBe(true);
    expect(OMP_IMPORT_CAPABILITY.supported.noNetworkOrInferenceOnImport).toBe(true);
    expect(OMP_IMPORT_CAPABILITY.pinnedCommit).toBe(PINNED_OMP_COMMIT);
  });

  it("is frozen so a caller cannot quietly upgrade the verdict to supported", () => {
    expect(Object.isFrozen(OMP_IMPORT_CAPABILITY)).toBe(true);
    expect(() => {
      (OMP_IMPORT_CAPABILITY as { route: string }).route = "supported-context-transfer-adapter";
    }).toThrow();
  });

  it("would report supported only if a route with zero blockers were ever provided", () => {
    const hypothetical: OmpImportCapability = {
      ...OMP_IMPORT_CAPABILITY,
      route: "supported-context-transfer-adapter",
      blockers: [],
    };
    expect(isAutomatedNativeImportSupported(hypothetical)).toBe(true);
    // A route flip alone, with blockers still present, must NOT read as supported.
    expect(
      isAutomatedNativeImportSupported({
        ...OMP_IMPORT_CAPABILITY,
        route: "supported-context-transfer-adapter",
      }),
    ).toBe(false);
  });
});
