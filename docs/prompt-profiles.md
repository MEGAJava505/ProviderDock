# Prompt and launch profiles (Phase 5)

Prompt profiles package reusable agent instructions with launch preferences.
They are ordinary non-secret configuration and must never contain API keys.

## Schema

```json
{
  "id": "practical",
  "name": "Practical Coding",
  "description": "Default implementation workflow",
  "instructions": "Inspect the existing implementation first.",
  "preferredProviderId": "agentrouter",
  "preferredModelId": "gpt-x",
  "preferredLogicalModelId": "gpt-x",
  "preferredClient": "codex",
  "reasoningLevel": "xhigh",
  "fallbackPolicy": "logical-model",
  "clientFlags": {
    "codex": ["--no-alt-screen"],
    "claudeCode": []
  }
}
```

`fallbackPolicy` is either:

- `disabled`: profile launch requires `preferredProviderId` and
  `preferredModelId`;
- `logical-model`: profile launch requires `preferredLogicalModelId` and uses
  the normal safe-fallback router.

Provider and logical-model references are checked before a profile is saved.
Referenced providers or logical models cannot be deleted until the profile is
updated or removed.

## Storage and CLI

Profiles are stored in a bounded, versioned document at:

```text
~/.provider-switcher/prompts/profiles.json
```

Writes are serialized and published with an atomic temporary-file rename.
Malformed, duplicate, unknown-version, and oversized documents fail closed.

```text
providerdock prompt-profiles list [--json]
providerdock prompt-profiles show <id>
providerdock prompt-profiles set --id ID --name NAME --instructions-file FILE [options]
providerdock prompt-profiles remove <id>
```

Important set options:

```text
--provider ID
--preferred-model MODEL
--logical-model ID
--client auto|codex|claude-code
--reasoning LEVEL
--fallback disabled|logical-model
--codex-flag=ARG
--claude-flag=ARG
```

Instructions are read from a file to preserve multiline content and avoid
shell quoting damage.

## Profile launch

```text
providerdock launch codex --prompt-profile ID --project DIRECTORY
providerdock launch claude --prompt-profile ID --project DIRECTORY
```

Profile launch always uses a managed bridge so instructions can be applied
without modifying the project, the user's Codex configuration, or global
environment:

- Responses requests receive profile text before any client-supplied
  `instructions`;
- Anthropic Messages requests receive profile text before the client `system`
  prompt, preserving string and block-array forms;
- the effective request, including profile instructions, is admitted to the
  anti-replay ledger before upstream contact.

Client flags are appended only to the selected child process. Codex profiles
also expose `reasoningLevel` as the managed model's default/supported reasoning
level. Claude reasoning semantics are provider/client-specific, so the stored
preference is not guessed into Anthropic `thinking`; an explicit
`--claude-flag` can be used when needed.

`providerdock launch auto` applies `preferredClient` when it is `codex` or
`claude-code`. For `auto`, ProviderDock uses the selected provider's explicit
preference first, then chooses Claude Code for Anthropic Messages and Codex for
Responses/Chat profiles. An explicit `launch codex` or `launch claude` command
remains the user override required by the specification.

## Project profiles

An exact project directory can be bound to a prompt profile:

```text
providerdock project-profiles list [--json]
providerdock project-profiles show --project DIRECTORY
providerdock project-profiles set --project DIRECTORY --prompt-profile ID
providerdock project-profiles remove --project DIRECTORY
```

Bindings are normalized to absolute paths and stored atomically in:

```text
~/.provider-switcher/projects/profiles.json
```

When `launch codex` or `launch claude` receives only `--project` and no
provider/model/logical/prompt selector, ProviderDock resolves the exact project
binding and launches its prompt profile. An explicit route or
`--prompt-profile` remains the user override. Prompt profiles cannot be deleted
while project bindings reference them.

Automatic selection supports the same route forms:

```text
providerdock launch auto --provider ID --model MODEL --project DIRECTORY
providerdock launch auto --logical-model ID --project DIRECTORY
providerdock launch auto --prompt-profile ID --project DIRECTORY
providerdock launch auto --project DIRECTORY
```

The current implementation intentionally uses exact-directory matching; it
does not silently inherit configuration from parent directories.

## Remaining Phase 5 work

- persisted measured compatibility as an additional Auto-selection signal;
- reusable fallback/reasoning preset catalogs;
- optional, explicit project-profile inheritance policy;
- UI selection and editing.
