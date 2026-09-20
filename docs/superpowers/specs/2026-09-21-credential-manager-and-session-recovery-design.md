# Credential Manager and Session Recovery Design

Status: draft for user review  
Date: 2026-09-21  
Scope: ProviderDock provider API credentials and portal/session credentials

## 1. Shared understanding

The system needs one internal credential module used by rare maintenance
commands and by normal provider/portal runtime code. A user must never see a
plaintext key: the normal view shows a short mask such as `abc…WXYZ`. One
provider may own several API credentials, with one explicitly active
credential. Rotation must encrypt the replacement first, optionally verify it,
activate it, and only then allow the old credential to be removed.

The current local vault contains 36 encrypted records (19 provider API-key
records and 17 portal/session records). All records are present but currently
undecryptable in this Windows DPAPI context. Existing ciphertext must therefore
be preserved; an unavailable record is not treated as deleted. The
`.env-key` file is a temporary raw `vsllm` credential source and must never be
committed or copied into a plaintext application file.

## 2. Goals and non-goals

Goals:

- centralize credential resolution, masking, rotation, backup, restore, and
  deletion behind one deep module;
- support several credentials for one provider without duplicating auth logic;
- keep provider API credentials separate from portal cookies/session tokens;
- survive loss of the current Windows DPAPI context through an explicitly
  unlocked portable backup;
- fail closed when a credential is malformed, missing, revoked, or referenced
  by an active profile;
- keep secrets out of logs, profiles, model catalogs, health records, and UI
  responses;
- preserve the existing `auth.secretRef` and portal `auth.secretRef` shape
  during the first migration so unrelated routing code does not need a broad
  rewrite.

Non-goals:

- recovering plaintext from a DPAPI ciphertext that cannot be decrypted;
- automatically obtaining new API keys or portal cookies from provider sites;
- automatic retry across multiple API keys for one request;
- storing a master passphrase in the repository, environment snapshots, or
  the same portable backup it unlocks;
- changing provider account identity, origin, model, or protocol decisions.

## 3. Recommended module and seam

Introduce one deep `CredentialManager` module at
`src/core/security/credential-manager.ts`. Its external interface is small;
the implementation owns metadata validation, masking, encrypted payload
storage, DPAPI/portable adapters, reference checks, and recovery diagnostics.
Callers do not manipulate encrypted files or cryptographic envelopes directly.

The interface is conceptually:

```ts
type CredentialPurpose = "provider-api" | "portal-session";

interface CredentialSummary {
  readonly id: string;
  readonly providerId: string;
  readonly purpose: CredentialPurpose;
  readonly label?: string;
  readonly maskedValue: string;
  readonly state: "active" | "available" | "revoked" | "unavailable";
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

interface CredentialManager {
  list(providerId?: string, purpose?: CredentialPurpose): Promise<readonly CredentialSummary[]>;
  resolveActive(providerId: string, purpose: CredentialPurpose): Promise<string>;
  add(input: AddCredentialInput): Promise<CredentialSummary>;
  activate(providerId: string, credentialId: string): Promise<CredentialSummary>;
  remove(providerId: string, credentialId: string): Promise<void>;
  createBackup(destination: string): Promise<void>;
  restoreBackup(source: string): Promise<RestoreReport>;
}
```

`add`, `activate`, `remove`, `createBackup`, and `restoreBackup` are internal
maintenance operations. Runtime provider and portal code only needs
`resolveActive`; ordinary UI code only needs `list`. The module accepts its
storage, profile repository, portal-reference checker, clock, and crypto
adapters through its constructor, so tests cross the same seam with in-memory
adapters.

The existing `auth.secretRef` remains a compatibility pointer to the active
record. Activating a credential updates that pointer through the injected
profile/portal repositories; all other consumers continue to use the current
request-building seam. This keeps the interface deep and prevents encryption
details from spreading into bridges, doctors, or launchers.

## 4. Storage model

The module owns a versioned metadata registry under the ProviderDock data
directory, separate from encrypted payloads:

```text
credentials/registry.json       # IDs, provider, purpose, state, timestamps, mask
secrets/<sha256(ref)>.json      # existing local protected-value envelope
credentials/portable-backup.pdv # optional encrypted recovery artifact
```

Registry metadata contains no plaintext credential and no reversible copy of a
secret. Each credential gets a stable opaque ID and a generated secret
reference. API and portal credentials use different purposes even when they
belong to the same provider, so rotating an API key never invalidates a portal
cookie in the registry.

The registry is written atomically with restrictive permissions. A write is
ordered as: validate input, protect payload, persist payload, persist metadata,
then update the active profile pointer. If any step fails, the old active
pointer remains unchanged.

## 5. Cryptography and recovery

Local operation keeps the current DPAPI adapter as a convenience backend, but
DPAPI is no longer the only recovery path. Portable backup uses only Node's
built-in `crypto` primitives:

1. derive a 256-bit key from an operator-supplied master passphrase with
   `scrypt` and a random per-backup salt;
2. encrypt the canonical backup payload with AES-256-GCM and a random nonce;
3. store a versioned envelope containing algorithm, KDF parameters, salt,
   nonce, authentication tag, and ciphertext;
4. bind the envelope version and purpose to authenticated data;
5. never store or cache the master passphrase.

Backup and restore prompt for the passphrase only in internal maintenance
commands. A wrong passphrase or tampered envelope returns a generic recovery
error and never leaks partial plaintext. The raw `.env-key` importer reads a
single value into memory, validates it, immediately hands it to the manager,
and never writes the raw value to disk or logs it.

If DPAPI becomes unavailable, the manager reports `unavailable` and preserves
the ciphertext. It may resolve an explicitly supplied environment credential
or an explicitly unlocked backup, but it must not silently guess or delete
records.

## 6. Rotation and multi-credential behavior

The normal policy is one active credential per `(providerId, purpose)` and any
number of additional `available` records. Requests never automatically retry
with another credential; that would duplicate paid requests and hide account
selection. A maintenance command can explicitly test and activate a chosen
record.

Rotation sequence:

1. import the replacement from a protected input source;
2. encrypt and persist it under a new credential ID;
3. optionally run a caller-approved metadata or minimal test;
4. atomically switch the provider/portal pointer to the new ID;
5. mark the old record `available` or `revoked`;
6. remove the old encrypted payload only when no profile or portal record
   references it and the operator explicitly requests removal.

The UI and `list` command show only summaries and masks. For values shorter
than eight characters, the mask is intentionally less revealing; no operation
ever returns a full value to a UI response.

## 7. Portal/session handling

Portal cookies and session tokens use the same module but the distinct
`portal-session` purpose. API-key rotation does not delete or rewrite portal
credentials. Removing a portal credential invalidates its cached portal
connection and forces a fresh login/import; it does not alter the provider API
credential.

For the 17 currently undecryptable portal records, recovery is possible only
from the original DPAPI context or a portable backup. If neither exists, the
operator must re-login or re-import the session; the module records this as
`unavailable`, not as a silently empty session.

## 8. Internal commands

Add a compact maintenance command family; exact CLI spelling is an
implementation detail, but it must support these operations:

- list masked credentials by provider and purpose;
- import one raw value from a file such as `.env-key`;
- activate a credential and optionally run a caller-selected safe test;
- revoke/remove a credential after reference checks;
- create an encrypted backup with a prompted master passphrase;
- restore an encrypted backup without replacing existing records by default.

The command output contains IDs, provider IDs, purposes, masks, states, and
sanitized error codes only. It never prints a raw key, cookie, passphrase,
request header, or response body.

## 9. Error and safety rules

- Existing encrypted files are never deleted during migration or failed
  decryption.
- A malformed registry or backup fails closed before any credential is
  resolved.
- Active references block destructive removal unless an explicit replacement
  is activated first.
- `SecretProtectionError` becomes a stable `CREDENTIAL_UNAVAILABLE`
  diagnostic; the underlying DPAPI detail is not exposed to UI or logs.
- `.env-key`, portable backups, temporary import files, and recovery reports
  are ignored by Git and must be checked for symlink/reparse-point surprises
  before reading or writing.

## 10. Testing and rollout

Tests cross the `CredentialManager` interface with in-memory registry,
secret-storage, and crypto adapters. Keep related coverage in existing domain
test files rather than creating one file per helper. Required cases include:

- mask behavior and no-plaintext metadata serialization;
- multiple credentials per provider and explicit activation;
- atomic rotation and removal refusal while referenced;
- portal/API purpose separation;
- DPAPI-unavailable status preserving ciphertext;
- backup round-trip, wrong passphrase, tampered envelope, and version
  rejection;
- `.env-key` import with no raw value in output or persisted metadata;
- compatibility with existing `auth.secretRef` and portal references.

Rollout is additive: first add the manager and registry, then add import and
backup commands, then wire runtime resolution, and only after successful
verification migrate active pointers. No existing provider profile, session,
token, or user home is deleted as part of this change.

## 11. Acceptance criteria

- A newly imported API key can be listed only as a mask, activated, resolved by
  the provider request path, and rotated without exposing plaintext.
- Two or more API keys can coexist for one provider with one explicit active
  key and no automatic fallback.
- A portal-session credential can be rotated/revoked independently of the API
  key.
- A portable backup can restore credentials after DPAPI becomes unavailable,
  provided the operator supplies the master passphrase.
- Failed decryption preserves all old ciphertext and produces a sanitized
  diagnostic.
- Existing tests remain green, test-file growth is consolidated into related
  suites, and `.env-key` cannot be committed accidentally.
