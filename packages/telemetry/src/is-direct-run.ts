/**
 * Bundle-safe "is this module the process entrypoint?" check.
 *
 * The idiomatic ESM guard (import.meta.url equals "file://" + process.argv[1])
 * MISFIRES when the module is bundled into a single-file entry (e.g. the
 * standalone `oxagen` CLI). The bundler rewrites `import.meta.url` to the
 * bundle's own path, which is exactly `process.argv[1]`, so the bare equality is
 * always true — and every bundled top-level self-run block (a ClickHouse
 * migration, a DB seed) fires on CLI boot, crashing any run whose environment
 * doesn't have that side effect's prerequisites (e.g. no `CLICKHOUSE_*` env).
 *
 * Requiring `process.argv[1]`'s basename to also match the script's own name
 * distinguishes a genuine `node …/migrate.js` (basename `migrate.js`) from a
 * `node …/oxagen.mjs` bundle boot (basename `oxagen.mjs`) — the latter fails the
 * name check, so the self-run block stays dormant inside the bundle while still
 * firing when the script is executed directly.
 *
 * @param importMetaUrl the calling module's `import.meta.url`
 * @param argv1         `process.argv[1]` — the script node was actually told to run
 * @param scriptName    this script's basename without extension (e.g. `"migrate"`)
 */
export function isDirectRunEntry(
  importMetaUrl: string,
  argv1: string | undefined,
  scriptName: string,
): boolean {
  const path = argv1 ?? "";
  if (importMetaUrl !== `file://${path}`) return false;
  const base = path.split(/[/\\]/).pop() ?? "";
  // Match `<scriptName>` optionally with a .ts/.js/.mts/.cts/.mjs/.cjs extension.
  return new RegExp(`^${scriptName}(\\.[mc]?[jt]s)?$`).test(base);
}
