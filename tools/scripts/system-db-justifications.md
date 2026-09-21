# System database bypass review

`pnpm check:system-db` checks production JavaScript and TypeScript under `apps`,
`packages`, and `tools`. Test, integration, and fixture directories are excluded.
`check:contracts` runs it in CI and in the configured pre-push hook.

Put a `tenancy:` comment directly before the statement that calls `withSystemDb`.
Name the query's scope and the check that established authority, or the global
table or scheduled system operation that replaces tenant scope. For example:

```ts
// tenancy: filtered by orgId after verified membership in the authenticated request.
const rows = await withSystemDb((tx) => readInvoices(tx, orgId));
```

The checker requires scope and authority vocabulary with at least eight words.
This rejects empty markers. It cannot prove that the query follows the comment.
The reviewer must check the predicate, the authority check, and their order.
Named import aliases, property access, computed property access, and simple
local aliases are scanned. Arbitrary higher-order or dynamic indirection still
needs review. This check does not make the underlying bypass unforgeable.

Existing uncommented calls are listed in
`system-db-justifications.baseline.json`, tracked by #2972's absorbed #1394.
Each entry records the source path and a hash of the call's syntax with comments
removed. Formatting leaves the hash stable. Changing a query requires a
justification rather than carrying the old exception to new behavior.
Duplicate hashes remain separate entries, so a copied call needs its own review.

Remove the matching baseline entry when adding its justification or deleting
the call. Stale entries fail the check. CI compares the proposed baseline with
the pull request's base commit, so it rejects additions even when the new code
and exception arrive together. Push checks use the previous commit from the
GitHub event. Local checks use `origin/main` and fail if that ref is unavailable.
The initial baseline can include only calls already present on the base branch.

This implements the justification guard deferred by ADR-125. Separate system
credentials and production drift evidence remain requirements of #2972.
