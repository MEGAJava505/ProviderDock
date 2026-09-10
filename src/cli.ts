#!/usr/bin/env node
import { createDefaultApplicationAsync } from "./application/create-default-application.js";
import { runProviderDockCli } from "./cli/provider-dock-cli.js";
import { ProviderPluginLoadError } from "./core/plugins/provider-plugin-loader.js";

try {
  process.exitCode = await runProviderDockCli(process.argv.slice(2), {
    application: await createDefaultApplicationAsync(),
  });
} catch (error) {
  if (error instanceof ProviderPluginLoadError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
