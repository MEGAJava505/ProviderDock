# Credential Manager and Session Recovery Implementation Plan

> **Historical process note:** This plan originally used checkbox steps and superpowers implementation skills; it is retained for design history, not execution.

> **Historical plan:** The unchecked boxes below are not a current task queue. Check the implementation and [current remaining plan](../../omp-migration/REMAINING_PLAN.md) before taking action; credential management and the VSLLM portal recovery have advanced since this plan was written.

**Goal:** Add a single internal credential module that safely rotates multiple provider keys and portal sessions, survives DPAPI-context loss through an encrypted backup, and restores `vsllm` without exposing plaintext secrets.

**Architecture:** Keep `auth.secretRef` as the active-pointer compatibility seam while a new credential registry owns non-secret metadata and purpose (`provider-api` or `portal-session`). A deep `CredentialManager` owns masking, encrypted payload lifecycle, rotation ordering, backup/restore, and unavailable-record diagnostics; file, memory, DPAPI, and portable-AEAD adapters stay behind its interface. Runtime request and portal code receives only the existing `SecretStore` seam, while internal CLI commands use the manager's maintenance interface.

**Tech Stack:** TypeScript, Node 20 built-in `crypto.scrypt` and AES-256-GCM, Zod, existing `SecretVault`/DPAPI adapters, Vitest, atomic JSON file repositories.

**Spec:** `docs/superpowers/specs/2026-09-21-credential-manager-and-session-recovery-design.md`

## Global Constraints

- Existing encrypted files are never deleted during migration or failed decryption.
- No plaintext credential, cookie, passphrase, request header, or response body may enter logs, profiles, model catalogs, health records, or UI responses.
- One provider may have many credentials, but exactly one credential per `(providerId, purpose)` is active; requests never automatically retry another credential.
- `auth.secretRef` remains the active compatibility pointer during the first migration.
- Portable backup uses Node built-in `scrypt` plus AES-256-GCM; the master passphrase is never stored.
- `.env-key` is an input source only, is ignored by Git, and is never copied into an application data file as plaintext.
- Use existing domain test files and parameterized cases; do not create one test file per helper.
- Do not modify or delete provider tokens, portal sessions, `accounts.json`, user homes, or live OMP route/evidence files without the explicit operation described in the task.
- All real provider calls remain bounded to the approved `vsllm` metadata check and one minimal `glm-5.2-free` request unless a later step is explicitly approved.

## Review Focus

- DPAPI decrypt failure with a valid ciphertext file: report `unavailable`, preserve the file, and continue only through an explicit fallback. Covered in Task 2 and Task 4.
- Tampered or wrong-passphrase portable backup: reject before returning any plaintext or partially applying records. Covered in Task 1 and Task 5.
- Rotation with an active provider or portal reference: encrypt the replacement and switch the pointer before any old-record removal. Covered in Task 3.
- API and portal credentials sharing a provider ID: keep purposes and invalidation independent. Covered in Task 3 and Task 4.
- Raw `.env-key` import and masked listing: never echo the value, never serialize it in metadata, and prevent accidental Git tracking. Covered in Task 5 and Task 6.

### Task 1: Portable authenticated secret envelope

**Files:**
- Create: `src/core/security/portable-secret-vault.ts`
- Modify: `src/index.ts`
- Test: `tests/dpapi-secret-vault.test.ts`

**Interfaces:**
- Consumes: a passphrase, a JSON-safe backup payload, and injected randomness/clock only where tests need deterministic values.
- Produces: `PortableSecretEnvelope`, `encryptPortableSecretPayload(payload, passphrase)`, and `decryptPortableSecretPayload(envelope, passphrase)` with generic failure errors.

- [ ] **Step 1: Write failing envelope tests in the existing vault suite.** Add cases that assert:
  - an object containing two credential records round-trips;
  - the serialized envelope contains version, KDF parameters, salt, nonce, tag, and ciphertext but no plaintext value;
  - a wrong passphrase rejects with `SecretProtectionError`;
  - flipping one ciphertext/tag byte rejects before returning a payload;
  - an unsupported version and malformed base64 reject without leaking the underlying crypto error.

- [ ] **Step 2: Run the focused tests to verify failure.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts`

  Expected: FAIL because the portable envelope exports do not exist.

- [ ] **Step 3: Implement the minimal portable envelope.** Use `scrypt` with a per-envelope random salt to derive 32 bytes, AES-256-GCM with a 12-byte random nonce, and authenticated data containing the schema version and purpose. Store only a strict Zod-parsed envelope. Normalize all decrypt failures to `SecretProtectionError("Portable credential backup could not be opened.")` and never include plaintext or the passphrase in the error.

- [ ] **Step 4: Run the focused tests to verify the envelope.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts`

  Expected: PASS, including the existing DPAPI/file-vault cases.

- [ ] **Step 5: Export the public types and commit the isolated change.**

  Run:

  ```text
  git add src/core/security/portable-secret-vault.ts src/index.ts tests/dpapi-secret-vault.test.ts
  git commit -m "feat: add portable credential envelope"
  ```

### Task 2: Credential metadata registry and deep manager

**Files:**
- Create: `src/core/security/credential-manager.ts`
- Create: `src/core/security/credential-repository.ts`
- Modify: `src/core/security/secret-store.ts`
- Modify: `src/index.ts`
- Test: `tests/dpapi-secret-vault.test.ts`

**Interfaces:**
- Consumes: `SecretVault`, `PortableSecretEnvelope` helpers, a `CredentialMetadataRepository`, and a `CredentialBindingAdapter` that can list active provider/portal references.
- Produces: `CredentialManager`, `CredentialSummary`, `CredentialPurpose`, `CredentialState`, `add`, `list`, `resolveActive`, `activate`, `remove`, `createBackup`, and `restoreBackup`.

- [ ] **Step 1: Add failing manager tests to the existing vault suite.** Cover the interface-level outcomes only:
  - adding two `provider-api` values for one provider returns different IDs and masks (`abc…WXYZ` for a long value);
  - listing never includes a full value or encrypted payload;
  - an unreadable payload is listed as `unavailable` while its metadata remains;
  - `resolveActive` returns only the active value and rejects missing/revoked/unavailable values with a sanitized credential error;
  - `remove` refuses a referenced active record;
  - backup/restore preserves records through an in-memory repository and vault.

- [ ] **Step 2: Run the focused test to verify failure.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts`

  Expected: FAIL because the repository and manager interfaces do not exist.

- [ ] **Step 3: Implement the strict metadata repository.** Add a versioned `credentials/registry.json` document with atomic write, bounded record count, stable opaque IDs, provider/purpose/state/timestamps, and secret reference. Add memory and file adapters matching the existing repository patterns. Parse all stored data with Zod before use.

- [ ] **Step 4: Implement `CredentialManager` behind the small interface.** Generate a fresh secret reference for every import instead of overwriting an unreadable legacy reference. Persist protected payload first, then metadata, then call the binding adapter only during activation. Compute masks in memory; for unavailable values return `unavailable` rather than guessing. Make backup creation include only successfully resolved records and make restore additive by default, refusing ID/reference collisions unless the caller explicitly opts into replacement.

- [ ] **Step 5: Make environment fallback resilient without hiding vault corruption.** Update `ChainedSecretStore.get` to continue to the next adapter only for `SecretProtectionError`, while the manager's diagnostics retain the unavailable state. Keep missing references distinct from undecryptable references.

- [ ] **Step 6: Run the focused tests to verify the manager.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts`

  Expected: PASS with no plaintext in serialized registry, errors, or summaries.

- [ ] **Step 7: Export the manager/repository interfaces and commit the isolated change.**

  Run:

  ```text
  git add src/core/security/credential-manager.ts src/core/security/credential-repository.ts src/core/security/secret-store.ts src/index.ts tests/dpapi-secret-vault.test.ts
  git commit -m "feat: add credential registry and manager"
  ```

### Task 3: Provider and portal binding adapter

**Files:**
- Create: `src/core/security/credential-bindings.ts`
- Modify: `src/application/provider-dock-application.ts`
- Modify: `src/core/portals/provider-portal-service.ts`
- Modify: `src/core/providers/provider-profile-repository.ts`
- Modify: `src/core/portals/portal-repository.ts`
- Test: `tests/provider-dock-application.test.ts`
- Test: `tests/provider-portal-dashboard.test.ts`

**Interfaces:**
- Consumes: `CredentialManager` activation/removal operations, provider profiles with `auth.secretRef`, and portal records with `connection.auth.secretRef`.
- Produces: a binding adapter that enumerates references with purpose, switches exactly one active reference per provider/purpose, and invalidates only the affected portal record.

- [ ] **Step 1: Add failing binding tests to existing application and portal suites.** Assert that:
  - activating a second API credential updates only the provider profile pointer;
  - activating a portal credential updates only the portal connection pointer;
  - API rotation leaves the portal connection and cached portal data untouched;
  - removing a referenced credential is rejected before repository mutation;
  - legacy profiles with only `auth.secretRef` are reconciled into metadata as available/unavailable records without replacing their pointer.

- [ ] **Step 2: Run the focused tests to verify failure.**

  Run: `npm test -- --run tests/provider-dock-application.test.ts tests/provider-portal-dashboard.test.ts`

  Expected: FAIL because binding and manager integration are not wired.

- [ ] **Step 3: Implement `CredentialBindingAdapter`.** Read all provider profiles and portal records, classify references as `provider-api` or `portal-session`, and expose an atomic bind operation. Keep provider and portal writes separate so an API activation cannot invalidate a cookie. Add a reference check used by `CredentialManager.remove`.

- [ ] **Step 4: Add application-level credential operations.** Construct the manager with the file registry, current vault, profile repository, and portal service. Add methods for masked listing, raw import, activation, removal, backup, and restore. Preserve the existing `setSecret`/`removeSecret` compatibility methods and route their storage through the manager where possible.

- [ ] **Step 5: Run the focused tests to verify binding behavior.**

  Run: `npm test -- --run tests/provider-dock-application.test.ts tests/provider-portal-dashboard.test.ts`

  Expected: PASS; portal tests must still prove API profile survival after disconnect and secret invalidation isolation.

- [ ] **Step 6: Commit the binding integration.**

  Run:

  ```text
  git add src/core/security/credential-bindings.ts src/application/provider-dock-application.ts src/core/portals/provider-portal-service.ts src/core/providers/provider-profile-repository.ts src/core/portals/portal-repository.ts tests/provider-dock-application.test.ts tests/provider-portal-dashboard.test.ts
  git commit -m "feat: bind rotated credentials to providers and portals"
  ```

### Task 4: Default composition and runtime resolution

**Files:**
- Modify: `src/application/create-default-application.ts`
- Modify: `src/core/providers/provider-http-request.ts`
- Modify: `src/core/portals/new-api-portal-adapter.ts`
- Modify: `src/core/portals/nofx-portal-adapter.ts`
- Modify: `src/core/portals/helyx-portal-adapter.ts`
- Modify: `tests/provider-http-request.test.ts`
- Modify: `tests/provider-portals.test.ts`
- Modify: `tests/provider-dock-application.test.ts`

**Interfaces:**
- Consumes: the manager-backed `SecretStore` and the existing request/portal seams.
- Produces: normal runtime calls that resolve active credentials without knowing whether the value came from DPAPI, environment fallback, or an explicitly unlocked portable backup.

- [ ] **Step 1: Add failing runtime tests.** Assert that a provider request resolves the active credential, a portal adapter resolves the portal-session credential, a DPAPI failure can fall through to an explicitly supplied environment value, and no raw credential appears in a `ProviderRequestError` or portal snapshot.

- [ ] **Step 2: Run the focused tests to verify failure.**

  Run: `npm test -- --run tests/provider-http-request.test.ts tests/provider-portals.test.ts tests/provider-dock-application.test.ts`

  Expected: FAIL for the new fallback/composition expectations.

- [ ] **Step 3: Wire the manager into `createDefaultApplicationRuntime`.** Construct one manager-backed store for adapters, Doctor, bridges, OMP runtime, and portal adapters. Keep the existing DPAPI vault object available for migration and preserve the current platform switch. Add a registry path under the resolved ProviderDock data directory.

- [ ] **Step 4: Ensure runtime resolution is active-pointer based.** Request and portal adapters continue to receive only `SecretStore`; the manager resolves the secret reference or active binding internally. A failed DPAPI record produces the stable unavailable diagnostic and never falls back to a different provider credential automatically.

- [ ] **Step 5: Run focused runtime tests.**

  Run: `npm test -- --run tests/provider-http-request.test.ts tests/provider-portals.test.ts tests/provider-dock-application.test.ts`

  Expected: PASS with existing error redaction and portal isolation behavior intact.

- [ ] **Step 6: Commit runtime composition.**

  Run:

  ```text
  git add src/application/create-default-application.ts src/core/providers/provider-http-request.ts src/core/portals/new-api-portal-adapter.ts src/core/portals/nofx-portal-adapter.ts src/core/portals/helyx-portal-adapter.ts tests/provider-http-request.test.ts tests/provider-portals.test.ts tests/provider-dock-application.test.ts
  git commit -m "feat: resolve runtime credentials through manager"
  ```

### Task 5: Internal credential CLI and `.env-key` import

**Files:**
- Create: `src/cli/secret-prompt.ts`
- Modify: `src/cli/provider-dock-cli.ts`
- Modify: `src/cli.ts`
- Modify: `src/application/provider-dock-application.ts`
- Modify: `tests/provider-dock-cli.test.ts`

**Interfaces:**
- Consumes: application credential methods and a raw one-line import file.
- Produces: `providerdock credentials list|import|activate|remove|backup|restore` with masked output and no plaintext command-line argument.

- [ ] **Step 1: Add failing CLI tests to the existing CLI suite.** Cover masked list output, raw import from a file without echoing the value, activation requiring provider/credential IDs, removal refusal for active references, and backup/restore using injected passphrase readers in tests.

- [ ] **Step 2: Run the focused CLI tests to verify failure.**

  Run: `npm test -- --run tests/provider-dock-cli.test.ts`

  Expected: FAIL because the `credentials` command is unknown.

- [ ] **Step 3: Implement the CLI parser and hidden passphrase reader.** Support:

  ```text
  providerdock credentials list [--provider ID] [--purpose provider-api|portal-session] [--json]
  providerdock credentials import --provider ID --purpose provider-api|portal-session --file PATH [--activate]
  providerdock credentials activate --provider ID --purpose provider-api|portal-session --credential ID
  providerdock credentials remove --provider ID --purpose provider-api|portal-session --credential ID
  providerdock credentials backup --file PATH
  providerdock credentials restore --file PATH
  ```

  Read `.env-key` as exactly one non-empty line, reject extra lines, symlinks/reparse points, and oversized files, and print only the resulting credential ID/mask. Use an injected hidden reader for backup/restore so production can use a TTY-safe prompt and tests never need a real terminal.

- [ ] **Step 4: Update CLI help and sanitized error routing.** Add `credentials` to dispatch/help, map manager errors to stable messages, and ensure raw key values cannot appear in caught error text or JSON output.

- [ ] **Step 5: Run the focused CLI tests.**

  Run: `npm test -- --run tests/provider-dock-cli.test.ts`

  Expected: PASS, including the existing rejection of command-line API-key fields.

- [ ] **Step 6: Commit the maintenance command.**

  Run:

  ```text
  git add src/cli/secret-prompt.ts src/cli/provider-dock-cli.ts src/cli.ts src/application/provider-dock-application.ts tests/provider-dock-cli.test.ts
  git commit -m "feat: add internal credential maintenance commands"
  ```

### Task 6: Safe local migration and repository protection

**Files:**
- Modify: `.gitignore`
- Modify: `docs/omp-migration/REMAINING_PLAN.md` (current status; this historical plan previously named a retired handoff)
- Modify: `.superpowers/sdd/2026-09-14-omp-migration-ru/progress.md`
- Test: `tests/dpapi-secret-vault.test.ts`
- Test: `tests/provider-dock-cli.test.ts`

**Interfaces:**
- Consumes: the completed manager and the existing 36-record local vault.
- Produces: an additive migration report, an ignored `.env-key`, and explicit unavailable statuses for records that cannot be decrypted.

- [ ] **Step 1: Add failing migration tests.** Assert that reconciliation discovers legacy provider/portal references, marks undecryptable records `unavailable`, leaves ciphertext bytes untouched, and imports a new raw key under a new reference instead of overwriting an unreadable legacy file.

- [ ] **Step 2: Run focused migration tests to verify failure.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts tests/provider-dock-cli.test.ts`

  Expected: FAIL for the new registry reconciliation/import behavior.

- [ ] **Step 3: Add `.env-key` to `.gitignore` and implement additive reconciliation.** Do not remove or rewrite existing secret files. Generate a report with counts and sanitized states; update the handoff/progress docs with the actual 19 API and 17 portal records, not their plaintext.

- [ ] **Step 4: Import the provided `vsllm` key through the internal command.** Use the existing `.env-key` path, create a new credential ID, activate it for `vsllm`, and leave the unreadable legacy `VSLLM_API_KEY` record in place. Verify the mask and registry metadata without printing the key.

- [ ] **Step 5: Run focused migration tests and inspect the sanitized report.**

  Run: `npm test -- --run tests/dpapi-secret-vault.test.ts tests/provider-dock-cli.test.ts`

  Expected: PASS; the report lists unavailable legacy records and one active `vsllm` provider credential without any raw value.

- [ ] **Step 6: Commit only migration protection/docs with the implementation change.**

  Run:

  ```text
  git add .gitignore docs/omp-migration/REMAINING_PLAN.md .superpowers/sdd/2026-09-14-omp-migration-ru/progress.md tests/dpapi-secret-vault.test.ts tests/provider-dock-cli.test.ts
  git commit -m "feat: protect and migrate local credentials safely"
  ```

### Task 7: Verification and the next Step 4 OMP boundary

**Files:**
- Modify: `docs/omp-migration/REMAINING_PLAN.md` (current status; this historical plan previously named a retired handoff)
- Modify: `.superpowers/sdd/2026-09-14-omp-migration-ru/progress.md`
- Use: current OMP route/evidence sources under `src/migration/`

**Interfaces:**
- Consumes: the active `vsllm` credential, the fresh model catalog, the pinned OMP compiler, and explicit non-secret route inputs.
- Produces: verified local credentials, a sanitized pilot result, and a clear stop at the next missing route decision rather than a guessed live route.

- [ ] **Step 1: Run the full local verification matrix.**

  Run:

  ```text
  npm test
  npm run typecheck
  npm run build
  node scripts/dashboard-ui-smoke.mjs
  git diff --check
  ```

  Expected: all tests pass, typecheck/build exit 0, dashboard smoke has no browser exceptions, and diff check reports no new whitespace errors.

- [ ] **Step 2: Run the real `vsllm` metadata check through the manager.** Confirm 72 current models, the active credential status, and sanitized health evidence. Do not persist a route decision yet.

- [ ] **Step 3: Query only non-secret account metadata needed for OMP identity.** If the provider exposes an authenticated `/v1/me` response, retain only the account ID/fingerprint and provenance; never store the response body or key. If no authoritative account ID is available, stop with `ACCOUNT_IDENTITY_REQUIRED`.

- [ ] **Step 4: Re-run the bounded minimal pilot.** Use `glm-5.2-free` and `openai-chat-completions` only. Record pass/fail, latency, model, protocol, profile hash, and credential ID without recording the prompt response body or secret.

- [ ] **Step 5: Run the OMP local smoke/preflight.** Require explicit account ID, `https://vsllm.cc/v1` origin, `glm-5.2-free` model, `openai-chat-completions` protocol, and observed capabilities. If any input is missing, leave the profile `pending` and document the exact next decision.

- [ ] **Step 6: Update the ledger and handoff with evidence and stop condition.** State clearly that direct provider compatibility passed, whether OMP preflight passed, and which exact non-secret field remains before a live OMP route decision. Do not create a live route file from inferred or stale values.

- [ ] **Step 7: Review the entire branch before claiming completion.** Confirm no key/session files were deleted, no plaintext appears in tracked files or test output, and all acceptance criteria in the design spec have evidence. Only then report the next Step 4 boundary.
