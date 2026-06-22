import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 84 (measured 89.81); target 80 — already above target
      // branches floor 77 (measured 82.49); target 75 — already above target
      thresholds: {
        lines: 84,
        branches: 77,
        functions: 74,
        statements: 84,
      },
      exclude: [
        // Preserve vitest default exclusions (test files, type declarations, etc.)
        ...coverageConfigDefaults.exclude,
        // plugin.*.ts — handlers shipped as part of the installable-plugins epic
        // (OXA-1573+ / re-inclusion tracked by OXA-1611). Still OUT OF SCOPE for
        // unit coverage because the plugin API surface is subject to change.
        // Listed explicitly (not "src/plugin.*.ts") so plugin.version.list.ts —
        // now wired to the connector_schemas catalog with real unit tests — is
        // re-included in the coverage gate while the rest stay excluded.
        "src/plugin.catalog.browse.ts",
        "src/plugin.catalog.get.ts",
        "src/plugin.credential.reauth.ts",
        "src/plugin.credential.set_secret.ts",
        "src/plugin.org.install.ts",
        "src/plugin.org.install_bulk.ts",
        "src/plugin.org.list.ts",
        "src/plugin.org.set_enabled.ts",
        "src/plugin.org.uninstall.ts",
        "src/plugin.registry.add.ts",
        "src/plugin.registry.list.ts",
        "src/plugin.registry.remove.ts",
        "src/plugin.schema.get.ts",
        "src/plugin.schema.validate.ts",
        "src/plugin.settings.set_auth_alerts.ts",
        "src/plugin.workspace.set_enabled.ts",
        // NOTE: repo.*.ts and integration.{delete,get,install,list,metrics}.ts
        // were previously excluded here as "stubs pending tests". They are now
        // wired to ingestion.source_connections / connector_schemas / Inngest and
        // carry full unit tests, so they are back IN the coverage gate.
        // research.swarm.status.ts — depends on external job-store lookups;
        // integration-tested at the API layer. Stub excluded from unit coverage.
        "src/research.swarm.status.ts",
        // privacy.data.*.ts — erasure and export handlers with complex async flows;
        // tested at the Inngest function level (packages/inngest-functions).
        "src/privacy.data.erase.ts",
        "src/privacy.data.export.ts",
        // Pure barrel / registration wiring — no business logic.
        // index.ts re-exports all handlers; register.ts registers them with the
        // handler registry. Both are side-effect-only and have no branch logic.
        "src/index.ts",
        "src/register.ts",
      ],
    },
  },
});
