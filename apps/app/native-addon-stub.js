// Stub for native addon packages (blake3, duckdb) — prevents Turbopack from
// parsing their package.json `binary` field (which lacks the `napi_versions`
// field Turbopack's NodePreGypConfigReference expects). These packages are
// listed in serverExternalPackages but Turbopack still traverses their metadata
// during the build graph walk. At runtime the real modules are loaded via
// Node's native require (server-external), so this stub is never actually
// executed in production.
throw new Error(
  "A stubbed native addon (blake3 / duckdb) was required in a bundled context. " +
    "These packages are listed in serverExternalPackages and must be loaded via " +
    "Node's native require, not through the bundle.",
);
