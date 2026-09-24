import { defineConfig } from "vitest/config";

// Local vendor checkouts use other runtimes (notably Bun). They are not part of
// ProviderDock's Node/Vitest suite, even when they live beneath this checkout.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".scratch/**", ".provider-dock/**"],
  },
});
