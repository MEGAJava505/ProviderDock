# Provider plugin SDK

ProviderDock can load explicitly configured local JavaScript modules that add
provider adapters without changing the core adapter registry. Plugin API
version 1 covers provider-profile preparation, compatibility-fix reporting,
model discovery, and authenticated same-origin HTTP.

## Trust boundary

Provider plugins are **trusted local code**. They execute in the ProviderDock
Node.js process with the same filesystem, environment, network, and process
privileges. There is no process, VM, permission, or package sandbox. Install
and enable only modules whose source and dependencies you have reviewed.

The SDK does not hand the `SecretStore` or secret values to a plugin. A plugin
receives provider profiles containing secret references and a host HTTP client.
That client resolves the references, injects authentication, and sends the
request without returning the constructed authenticated request. This API
boundary is not a security sandbox: trusted JavaScript can still access Node.js
APIs directly.

ProviderDock does not:

- scan plugin directories;
- load modules named in provider profile metadata;
- accept remote, `data:`, or bare-package module specifiers;
- treat profile bundle contents as executable code.

## Enabling modules

Set `PROVIDER_DOCK_PLUGINS` to an operating-system path-delimiter-separated
list. Use `;` on Windows and `:` on Linux/macOS:

```powershell
$env:PROVIDER_DOCK_PLUGINS = "C:\ProviderDock\plugins\acme.mjs;C:\ProviderDock\plugins\local.mjs"
providerdock plugins list
```

```bash
PROVIDER_DOCK_PLUGINS=./plugins/acme.mjs:../shared/local.mjs \
  providerdock plugins list
```

Each entry must be an absolute filesystem path or begin with `./` or `../`.
The loader resolves the real path, requires a regular file, and rejects
duplicate module paths, plugin IDs, and adapter IDs. Any import, validation, or
initialization failure aborts startup before a command runs.

Programmatic integrations use `createDefaultApplicationAsync()` to enable
plugins. `createDefaultApplication()` remains synchronous and plugin-free:

```ts
const application = await createDefaultApplicationAsync({
  pluginPaths: ["./plugins/acme.mjs"],
});
```

## Module contract

A module exports its definition as either `default` or
`providerDockPlugin`. If both exist, they must reference the same definition.

```js
export default {
  manifest: {
    apiVersion: 1,
    id: "acme",
    name: "Acme provider adapter",
    version: "1.0.0",
    description: "Discovers models through Acme's catalog endpoint.",
    adapterIds: ["plugin:acme/catalog"],
  },

  createAdapters(context) {
    return [
      {
        id: "plugin:acme/catalog",

        supports(profile) {
          return profile.adapterId === this.id;
        },

        prepareProfile(profile) {
          return {
            ...profile,
            apiType: "openai-responses",
            modelsEndpoint: "catalog/models",
          };
        },

        compatibilityFixes() {
          return ["acme-catalog-endpoint"];
        },

        async discoverModels(profile) {
          const response = await context.http.request(
            profile,
            profile.modelsEndpoint,
          );
          if (!response.ok) {
            throw new Error(`Model catalog returned HTTP ${response.status}.`);
          }
          const payload = await response.json();
          return payload.models.map((model) => ({
            modelId: model.id,
            displayName: model.name ?? model.id,
            raw: model,
          }));
        },
      },
    ];
  },
};
```

Manifest IDs use lowercase letters, digits, `_`, and `-`. Adapter IDs are
namespaced as `plugin:PLUGIN_ID/ADAPTER_ID`; every declared adapter must be
returned exactly once, and returned adapters may not be undeclared.

## Runtime validation

ProviderDock wraps every loaded adapter and validates untrusted return values:

- `supports()` must return a boolean;
- `prepareProfile()` must return a valid provider profile;
- provider ID, base URL, adapter ID, authentication, and secret-header
  references cannot be changed by `prepareProfile()`;
- compatibility fixes must be bounded non-empty strings;
- discovered models must have bounded IDs, display names, and object metadata;
- duplicate discovered model IDs are rejected.

Adapter methods receive cloned profiles so mutation cannot modify the host's
stored object. Plugin failures are normalized as
`ProviderPluginExecutionError`; malformed modules and manifests fail startup.

An explicit `plugin:*` adapter selection fails closed when that adapter is not
loaded. It never falls through to a generic OpenAI or Anthropic adapter.

## Host HTTP client

`context.http.request(profile, endpoint, options)`:

- resolves endpoints against the configured provider base URL;
- rejects cross-origin absolute, scheme-relative, and traversal-derived URLs
  that change the origin;
- injects profile auth and secret-backed headers through the host secret store;
- applies the profile timeout;
- normalizes timeout and network failures;
- blocks plugin overrides of authorization, API-key, cookie, host,
  connection, and content-length headers;
- removes the authenticated request URL from the returned `Response`, which
  prevents query-auth values from appearing in `Response.url`.

The provider can still return sensitive data in its response body, so plugins
must avoid logging raw responses.

## CLI

List loaded module metadata:

```text
providerdock plugins list
providerdock plugins list --json
```

Configure a provider to use a loaded adapter:

```text
providerdock providers set \
  --id acme \
  --name Acme \
  --base-url https://api.acme.example/v1 \
  --adapter plugin:acme/catalog \
  --auth-kind bearer \
  --secret-ref ACME_API_KEY
```

The list output contains module paths and manifest metadata, never provider
credentials or secret values.
