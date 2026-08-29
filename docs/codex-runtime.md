# Codex runtime configuration

ProviderDock launches Codex with an isolated, randomly named config profile rather than
rewriting the user's `~/.codex/config.toml`.

The current official Codex configuration reference states that:

- user-level configuration lives at `~/.codex/config.toml`;
- provider keys cannot be overridden by project-local `.codex/config.toml`;
- profile files can live at `$CODEX_HOME/<profile-name>.config.toml` and are selected with
  `--profile <profile-name>`;
- custom providers use `model_providers`, `base_url`, `env_key`, and
  `env_http_headers`;
- `responses` is currently the only supported custom-provider `wire_api`.

Source: [OpenAI Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference),
retrieved 2026-08-29.

## Session lifecycle

```text
validate project/provider
  → write PREPARING manifest
  → create random $CODEX_HOME/providerdock-*.config.toml with create-new semantics
  → mark manifest READY
  → start codex --strict-config --profile providerdock-*
  → mark manifest ACTIVE with PID
  → wait for Codex exit
  → verify profile checksum
  → delete only the unchanged temporary profile and runtime manifest
```

The user's main config is never modified. Secrets are resolved just before launch and
placed only in randomly named child-process environment variables referenced by
`env_key` or `env_http_headers`; they are not written into TOML or the recovery manifest.

On startup, stale session manifests can be recovered. ProviderDock removes a temporary
profile only when its path is derived from the recorded random profile name and its
contents still match the recorded SHA-256 checksum. A changed profile produces a
conflict and is preserved for manual inspection.
