#!/usr/bin/env node
import { createDefaultProviderDockAsync } from "./application/create-default-application.js";
import { runProviderDockCli } from "./cli/provider-dock-cli.js";
import { ProviderPluginLoadError } from "./core/plugins/provider-plugin-loader.js";

try {
  const providerDock = await createDefaultProviderDockAsync();
  process.exitCode = await runProviderDockCli(process.argv.slice(2), {
    application: providerDock.application,
    ompLauncher: providerDock.ompLauncher,
  });
} catch (error) {
  if (error instanceof ProviderPluginLoadError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
