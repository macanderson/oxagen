// The agent key's namespace prefix (`org_ns.ws_ns`, ADR-024) for the workspace
// the Agents page lists. No read answers it directly, so the page takes it
// from a key it already holds: every key in a workspace starts with the same
// two namespaces, and a slug carries no dot.
//
// This is a plain module, not a "use client" one, because the server-rendered
// Agents page calls it. A function exported from a "use client" module is a
// client reference on the server and throws when called there
// (test/arch/client-values.test.ts).

/** The prefix of the first recorded key, or null when no key is recorded. */
export function keyPrefixOf(keys: readonly (string | null)[]): string | null {
  for (const key of keys) {
    if (key === null) continue;
    const dot = key.lastIndexOf(".");
    if (dot > 0) return key.slice(0, dot);
  }
  return null;
}
