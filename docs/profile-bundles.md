# Profile bundle import and export

ProviderDock can move its non-secret configuration between installations with
a versioned JSON bundle:

```text
providerdock profiles export --file providerdock-profiles.json
providerdock profiles import --file providerdock-profiles.json
```

Use `--force` to replace an existing export file. Import rejects collisions by
default; use `--overwrite` only when the bundle is intended to replace matching
entries.

## Bundle contents

Format version 1 contains:

- provider profiles;
- logical-model routing profiles;
- prompt/launch profiles;
- exact-directory project bindings.

Providers contain secret **references** such as `ROUTER_API_KEY`, never the
secret value stored in DPAPI, an OS vault, or the environment. Health history,
Doctor diagnostics, runtime sessions, logs, temporary client configuration,
usage events, and credentials are not exported. Optional non-secret per-model
pricing metadata is part of the provider profile and is exported.

Project bindings contain absolute local paths. They are useful for backup and
same-machine migration, but normally need editing when imported on another
machine or operating system.

## Import safety

Before writing anything, import:

1. schema-validates the full versioned document;
2. rejects duplicate IDs/directories;
3. checks every logical-model provider reference;
4. checks prompt provider/logical-model references;
5. checks project-to-prompt references;
6. rejects existing-entry collisions unless `--overwrite` is explicit.

Writes run in dependency order: providers, logical models, prompt profiles,
then project bindings. If a repository write fails, completed writes are
rolled back in reverse order. A rollback failure is surfaced explicitly rather
than being hidden.

Import is a merge operation. It does not delete local entries that are absent
from the bundle.
