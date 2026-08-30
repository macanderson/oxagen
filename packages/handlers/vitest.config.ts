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
      // Ratchet only — never lowered, capped at 90, with headroom below the
      // measured figure so environment noise cannot fail CI.
      thresholds: {
        lines: 85,
        branches: 77,
        functions: 74,
        statements: 85,
      },
      exclude: [
        // Preserve vitest default exclusions (test files, type declarations, etc.)
        ...coverageConfigDefaults.exclude,
        // plugin.*.ts — installable-plugin handlers, out of scope for unit
        // coverage while the plugin API surface is still moving. Listed one by
        // one rather than as "src/plugin.*.ts" so plugin.version.list.ts, which
        // is wired to the connector_schemas catalog and unit-tested, stays IN
        // the gate.
        "src/plugin.catalog.browse.ts",
        "src/plugin.catalog.get.ts",
        "src/plugin.credential.reauth.ts",
        "src/plugin.credential.set_secret.ts",
        "src/plugin.org.install.ts",
        "src/plugin.org.install_bulk.ts",
        "src/plugin.org.list.ts",
        "src/plugin.set_enabled.ts",
        "src/plugin.org.uninstall.ts",
        "src/plugin.registry.add.ts",
        "src/plugin.registry.list.ts",
        "src/plugin.registry.remove.ts",
        "src/plugin.schema.get.ts",
        "src/plugin.schema.validate.ts",
        "src/plugin.settings.set_auth_alerts.ts",
        // research.swarm.status.ts — depends on external job-store lookups;
        // integration-tested at the API layer. Stub excluded from unit coverage.
        "src/research.swarm.status.ts",
        // schema.*.ts — schema-registry handlers (registry versioning + drizzle
        // queries) backing the schema.* capabilities. Integration-tested at the
        // API layer (apps/api/src/__tests__/routes.schema.test.ts) rather than
        // here; re-include once unit tests land.
        "src/schema.chat.ts",
        "src/schema.delete.ts",
        "src/schema.export.ts",
        "src/schema.list.ts",
        "src/schema.pinned.ts",
        "src/schema.setup.ts",
        "src/schema.toggle.ts",
        "src/schema.recommend.ts",
        "src/schema.registry.config.ts",
        "src/schema.registry.get.ts",
        "src/schema.versioning.ts",
        "src/schema.version.create.ts",
        "src/schema.version.diff.ts",
        "src/schema.version.list.ts",
        "src/schema.version.pin.ts",
        "src/schema.label.delete.ts",
        "src/schema.label.upsert.ts",
        "src/schema.property.delete.ts",
        "src/schema.property.upsert.ts",
        "src/schema.relationship.delete.ts",
        "src/schema.relationship.upsert.ts",
        // agent.execution.record.ts / chat.message.execution.ts — execution
        // recording handlers; the writes are exercised via Inngest + API
        // integration tests, not unit-tested. connection.delete.ts /
        // connection.mappings.suggest.ts — connector handlers with no unit tests
        // yet. event-client.ts — 3-line Inngest event-client wrapper (mocked
        // everywhere, no business logic). Coverage debt; re-include as unit
        // tests land.
        "src/agent.execution.record.ts",
        "src/chat.message.execution.ts",
        "src/connection.delete.ts",
        "src/connection.mappings.suggest.ts",
        "src/event-client.ts",
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
