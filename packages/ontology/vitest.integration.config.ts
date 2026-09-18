import { defineConfig } from "vitest/config";

// The real-Neo4j cross-tenant probe (M0). Needs NEO4J_URI / NEO4J_USERNAME /
// NEO4J_PASSWORD pointing at a live server; CI runs it in the rls-integration
// job, which carries a neo4j:5.24-community service.
export default defineConfig({
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    globals: false,
    fileParallelism: false, // one shared database; run serially
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
