# @oxagen/github — GitHub Write Client SDD Report

**Date:** 2026-06-27
**Package:** `packages/github` → `@oxagen/github`
**Octokit version:** `@octokit/rest@22.0.1`

---

## Operations built

| # | Method | Description |
|---|--------|-------------|
| 1 | `createRepoInOrg` | Create a repository inside a GitHub organisation |
| 2 | `putFile` | Create or update a single file (base64-encodes content, detects existing file sha for updates) |
| 3 | `forkRepo` | Fork a repository with polling until the fork is reachable (up to 10 attempts) |
| 4 | `createBranch` | Create a branch from an existing branch (default: `main`) |
| 5 | `openPullRequest` | Open a pull request with optional body and draft flag |
| 6 | `getAuthenticatedUser` | Return the login of the authenticated token |

---

## GitHubClient interface

```typescript
export interface GitHubClient {
  createRepoInOrg(args: {
    org: string;
    name: string;
    description?: string;
    private?: boolean;
    autoInit?: boolean;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>;

  putFile(args: {
    owner: string;
    repo: string;
    path: string;
    content: string;   // raw UTF-8 — base64 encoding is internal
    message: string;
    branch?: string;
  }): Promise<{ commitSha: string; htmlUrl: string }>;

  forkRepo(args: {
    owner: string;
    repo: string;
    org?: string;
  }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>;

  createBranch(args: {
    owner: string;
    repo: string;
    branch: string;
    fromBranch?: string;
  }): Promise<{ ref: string; sha: string }>;

  openPullRequest(args: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
  }): Promise<{ number: number; htmlUrl: string }>;

  getAuthenticatedUser(): Promise<{ login: string }>;
}
```

---

## Test results

```
 RUN  v2.1.9

 ✓ src/__tests__/octokit-client.test.ts (18 tests) 5ms

 Test Files  1 passed (1)
       Tests  18 passed (18)
    Start at  17:37:33
    Duration  222ms

% Coverage report from v8
-------------------|---------|----------|---------|---------|
File               | % Stmts | % Branch | % Funcs | % Lines |
-------------------|---------|----------|---------|---------|
All files          |   98.96 |    92.85 |      80 |   98.96 |
 src               |   95.55 |    94.87 |   77.77 |   95.55 |
  index.ts         |       0 |        0 |       0 |       0 |
  octokit-client.ts|   96.26 |    97.36 |    87.5 |   96.26 |
 src/__tests__     |     100 |    90.32 |     100 |     100 |
  octokit-client.test.ts | 100 | 90.32 |     100 |     100 |
-------------------|---------|----------|---------|---------|

Thresholds: lines ≥85 ✓ | branches ≥80 ✓ | functions ≥80 ✓ | statements ≥85 ✓
```

---

## Design notes

### Vendor neutrality
The public API (`GitHubClient`, `GitHubClientOptions`) contains zero Octokit types. Callers program against the interface only.

### OctokitLike for testability
An internal `OctokitLike` interface (exported for tests) captures only the ~10 Octokit methods used. Tests inject a `vi.fn()`-backed fake; no `vi.mock` magic is needed. The real `Octokit` is cast via `as unknown as OctokitLike` at construction time — intentional, documented in a comment, because `repos.getContent` in @octokit/rest v22 returns a `file | dir | submodule | symlink` union that is wider than what we consume.

### putFile: sha detection
Before writing, `repos.getContent` is called to check for an existing file. A 404 (file absent) is silently swallowed; any other error propagates. When the file exists, its `sha` is forwarded to `createOrUpdateFileContents`, satisfying GitHub's update requirement.

### forkRepo: polling
GitHub's fork API returns immediately but the fork repo may not be reachable. The implementation polls `repos.get` up to 10 times, sleeping `opts.sleepMs` (default 2 s) between attempts. A `sleep` option is injectable for zero-delay tests. After 10 failed polls, it falls back to the fork-creation response data.

### TypeScript strictness
- No `any` used anywhere.
- `exactOptionalPropertyTypes: false` (inherited from tsconfig.base.json) — optional args omitted with spread checks, not `undefined` assignment.
- Types extracted to `src/types.ts`; implementation in `src/octokit-client.ts`; barrel in `src/index.ts`.
