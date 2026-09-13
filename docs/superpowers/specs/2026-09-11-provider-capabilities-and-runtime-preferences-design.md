# ProviderDock capability, approval, and resource-ownership design

**Date:** 2026-09-11
**Status:** Implemented
**Scope:** Architectural fix for reasoning effort metadata, persistent approval preferences, and provider-owned state handling.

## Implementation status

This design is implemented in the current ProviderDock worktree. The implementation
uses the exact official model-capability overlay snapshot dated **September 11, 2026**,
with provider metadata as a labeled fallback only for model IDs absent from that
overlay. The dashboard and CLI resolve launch approval before dispatch; launch history
records the actual `resolvedApprovalLevel`. The Responses bridge tags provider-owned
reasoning state, validates its scope before forwarding, scrubs only local metadata, and
classifies ownership failures as the non-retryable `RESOURCE_SCOPE_MISMATCH`.

## Problem

1. ProviderDock currently infers reasoning efforts from model-name substrings. This produces incorrect values such as `gpt-6-astra -> low/medium/high` even though the official Codex catalog advertises `low/medium/high/xhigh/max/ultra`.
2. AgentRouter injects a hard-coded `glm-5.3 -> low/high/max` mapping that is not supported by Z.AI’s native thinking-mode contract.
3. Approval preferences are not persisted. The dashboard and CLI default to `ask` on every launch, so a user-selected `full-auto` does not survive later launches.
4. The Responses bridge removes top-level `previous_response_id` and `conversation`, but nested provider-owned reasoning items and encrypted content can still cross an upstream resource boundary. This causes Azure/OpenAI-compatible 400 errors such as “Use the same resource that created the item” and “encrypted content could not be verified”.

## Goals

- Replace name-based effort heuristics with a versioned capability model.
- Use the official Codex model catalog as the primary source for Codex picker values.
- Represent unknown and thinking-mode models without inventing effort enums.
- Persist per-project approval preferences.
- Model provider-owned state scope and prevent foreign nested state from crossing resource boundaries.
- Preserve compatibility with existing providers and avoid breaking current uncommitted work.

## Non-goals

- Automatically probing every provider model for capabilities.
- Changing provider authentication or secret storage.
- Modifying the active Codex process.
- Rewriting the existing model discovery protocol.

## Architecture

### 1. Capability model

Introduce a shared reasoning-capability record:

```ts
export type ReasoningCapabilitySource =
  | "official-model-catalog"
  | "provider-metadata"
  | "probe"
  | "user-override";

export type ReasoningCapability =
  | { kind: "unknown" }
  | { kind: "unsupported" }
  | {
      kind: "effort";
      values: readonly string[];
      default?: string;
      source: ReasoningCapabilitySource;
    }
  | {
      kind: "thinking-mode";
      mode: "forced" | "toggle" | "adaptive" | "unknown";
      source: ReasoningCapabilitySource;
    };
```

Resolution order:

1. Exact model ID in the official catalog overlay.
2. Provider-advertised metadata.
3. Successful probe evidence.
4. `unknown`.

Official model-owner values take precedence over gateway guesses unless the user explicitly chooses gateway behavior.

### 2. Official catalog overlay

Add a versioned local table generated from the official Codex `models.json` snapshot dated 2026-09-11. It includes at least:

- `gpt-6-astra`: default `low`, levels `low/medium/high/xhigh/max/ultra`
- `gpt-5.6-sol`: default `low`, levels `low/medium/high/xhigh/max/ultra`
- `gpt-5.6-terra`: default `medium`, levels `low/medium/high/xhigh/max/ultra`
- `gpt-5.6-luna`: default `medium`, levels `low/medium/high/xhigh/max`
- `gpt-daybreak-blue-latest`
- `gpt-daybreak-red-latest`
- `gpt-5.5`
- `gpt-5.4`
- `codex-auto-review`

The overlay also records Anthropic effort values and Z.AI thinking-mode capabilities for exact model IDs where official documentation is available.

Unknown models are exposed as `unknown`; ProviderDock must not synthesize `low/medium/high`.

### 3. Codex model catalog generation

`createCodexModelInfo` will:

- accept a `ReasoningCapability`;
- emit `supported_reasoning_levels` only for proven `effort` capabilities;
- emit no reasoning levels for `thinking-mode` or `unknown`;
- preserve provider-advertised values with provenance;
- remove the current substring-based fallback.

The generated catalog remains compatible with Codex CLI’s `ModelInfo` schema.

### 4. AgentRouter GLM handling

Remove the hard-coded `glm-5.3 -> low/high/max` override. Model GLM-5.3 as:

```ts
{
  kind: "thinking-mode",
  mode: "forced",
  source: "official-model-catalog"
}
```

If AgentRouter later documents an explicit effort mapping, it can be added as provider metadata with provenance.

### 5. Launch preference repository

Add a versioned, atomic, serialized repository:

- File: `launch/preferences.json`
- Key: normalized project directory
- Value: approval level
- Default: `ask`
- Methods: `get`, `upsert`, `delete`, `list`

The dashboard and CLI resolve a stored preference when a request omits `approvalLevel`. When a launch explicitly includes `approvalLevel`, ProviderDock persists it for that project.

Launch records expose the resolved approval level so the UI can prove what was actually used.

### 6. Resource-scope handling

Introduce a `ResourceScope` concept in the Responses bridge:

```ts
interface ResourceScope {
  providerId: string;
  baseUrl: string;
  protocol: "openai-responses" | "openai-chat-completions";
  upstreamResourceId?: string;
}
```

The bridge will:

1. Continue stripping top-level `previous_response_id` and `conversation`.
2. Track the resource scope that created provider-owned items.
3. Detect nested provider-owned IDs and encrypted reasoning content in `input`.
4. If the scope does not match the current upstream route:
   - reject locally with `RESOURCE_SCOPE_MISMATCH`,
   - do not forward, rewrite, or silently delete the nested provider-owned state,
   - record a sanitized diagnostic.
5. Never silently forward foreign encrypted reasoning across a resource boundary.
6. If an upstream ownership 400 still occurs, classify it as `RESOURCE_SCOPE_MISMATCH` rather than a generic invalid request.

## Data flow

1. Provider discovery returns raw model metadata.
2. Capability resolver merges:
   - official overlay,
   - provider metadata,
   - probe evidence,
   - user overrides.
3. Codex catalog generator converts only proven effort capabilities into Codex `supported_reasoning_levels`.
4. Dashboard/UI displays known, unknown, or thinking-mode capabilities.
5. Launch request resolves approval level from explicit request or persisted preference.
6. Bridge attaches resource scope to provider-owned state and validates nested input before forwarding.

## Error handling

- Unknown capability: show `unknown`; do not invent values.
- Provider/official conflict: prefer official source and expose the conflict in diagnostics.
- Missing preference: default to `ask`.
- Invalid preference file: fail closed to `ask` and report a sanitized storage error.
- Foreign nested state: reject locally with `RESOURCE_SCOPE_MISMATCH`; do not blindly remove or rewrite encrypted reasoning.
- Ownership 400: normalize to `RESOURCE_SCOPE_MISMATCH` with provider, model, route, and request ID.

## Testing

Use TDD:

1. Capability resolver tests:
   - exact official values;
   - provider metadata precedence;
   - unknown models;
   - thinking-mode models.
2. Codex catalog tests:
   - `gpt-6-astra` emits six levels;
   - `gpt-5.6-sol` emits six levels;
   - unknown emits no levels;
   - GLM emits thinking-mode rather than efforts.
3. AgentRouter adapter tests:
   - no hard-coded GLM effort injection.
4. Launch preference tests:
   - persistence round trip;
   - default `ask`;
   - explicit `full-auto` persists;
   - invalid storage fails closed.
5. Dashboard/CLI tests:
   - omitted approval resolves stored preference;
   - launch record includes resolved level.
6. Bridge ownership tests:
   - top-level state handles are stripped;
   - nested foreign reasoning state is rejected locally before upstream forwarding;
   - ownership 400 is classified correctly;
   - retry does not resend foreign encrypted content.

## Migration

- Add capability fields without removing existing model catalog fields until all consumers are migrated.
- Keep current tests passing by updating expectations that encode the old three-level fallback.
- Preserve existing uncommitted work.

## Implemented invariants

- The official overlay is exact-ID and versioned; it wins over stale provider
  `supportedReasoningLevels` and provider metadata unless a caller supplies an explicit
  `user-override`.
- Unknown models retain `unknown` and do not receive a synthetic effort menu.
- `glm-5.3` is `thinking-mode: forced`; it is never emitted as an effort enum.
- Explicit approval choices are persisted per normalized project directory in
  `launch/preferences.json`; omitted choices resolve to the stored value or `ask`.
- Every launch record exposes the resolved approval level used by the child process.
- Native Responses and translated Chat JSON/SSE paths tag nested reasoning items with
  the creating resource scope. Before forwarding, only
  `providerdock_resource_scope` is removed.
- Foreign or untagged encrypted reasoning is rejected locally as
  `RESOURCE_SCOPE_MISMATCH`, and that error cannot trigger fallback replay.
