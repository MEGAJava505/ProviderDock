#!/usr/bin/env node
import { createDefaultApplication } from "./application/create-default-application.js";
import { runProviderDockCli } from "./cli/provider-dock-cli.js";

process.exitCode = await runProviderDockCli(process.argv.slice(2), {
  application: createDefaultApplication(),
});
