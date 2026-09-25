# @oxagen/gitlab

`@oxagen/gitlab` is the gitlab.com REST v4 client. It reads and writes one project with a project access token, validates project paths, and checks and parses project webhooks. Steering publishes merge requests through it when a workspace binds a gitlab.com project as its main repository (#3762).

## Boundary

- **Owns:** the REST client with its retry, timeout, pagination, and error redaction (`src/client.ts`), the camelCase shapes every response maps into (`src/types.ts`), project path validation (`src/project-path.ts`), and the constant-time webhook token check and webhook body parser (`src/webhook.ts`).
- **Does not own:** the steering provider seam and its GitLab implementation (`packages/handlers/src/context.steering.host.ts` and `context.steering.gitlab.ts`), token storage and decryption (`packages/handlers/src/lib/gitlab-credential.ts`), the webhook HTTP route (`apps/api/src/routes/v1/gitlab-webhook.ts`), or the `attach_gitlab_project` contract in [`@oxagen/oxagen`](../oxagen/README.md) (`packages/oxagen/src/contracts/repository.gitlab.attach.ts`).
- **Depends on:** no workspace package. The only runtime import is `node:crypto`, for `timingSafeEqual`.
- **Used by:** [`@oxagen/handlers`](../handlers/README.md) and the live exercise script `tools/scripts/gitlab-steering-exercise.ts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `createGitLabClient(options)` | export | `packages/gitlab/src/client.ts` | `packages/handlers/src/context.steering.gitlab.ts`, `gitlab.webhook.ts`, `repository.gitlab-connection.ts`, and `repository.gitlab.attach.ts`, each through an injectable `client(token)` factory so tests pass a fake |
| `GitLabApiError` | export | `packages/gitlab/src/client.ts` | The same handlers and `packages/handlers/src/workspace.create.ts`, which branch on `status`, for example 401 for a rejected token, 404 for an absent project or file, and 409 for a merge request whose head moved |
| `GitLabClient` | port | `packages/gitlab/src/types.ts` | `packages/handlers/src/context.steering.gitlab.test-support.ts`, the in-memory gitlab.com project the steering tests run against |
| `parseGitLabProjectPath(input)` | export | `packages/gitlab/src/project-path.ts` | `packages/handlers/src/repository.gitlab.attach.ts` and `workspace.create.ts`, before any request leaves |
| `verifyGitLabWebhookToken`, `parseGitLabWebhookEvent` | boundary | `packages/gitlab/src/webhook.ts` | `packages/handlers/src/gitlab.webhook.ts`, which `apps/api/src/routes/v1/gitlab-webhook.ts` mounts at `POST /webhooks/gitlab/:connection` |

## Entry points

- `.` (`src/index.ts`): the client factory, `GitLabApiError`, the response types, `parseGitLabProjectPath`, and the two webhook functions. The package has no subpath exports.

## Rules

- The token travels only in the `PRIVATE-TOKEN` header. It never appears in a URL, an error message, or a log line. `GitLabApiError` messages redact the token and any webhook secret the request sent, because those messages reach logs and run records.
- Only gitlab.com is supported. `baseUrl` exists for tests. A self-managed host needs a host setting and an outbound-network review first.
- Address a project by its numeric id where you have it. The id survives a rename or a transfer to another group, and a full path does not.
- The client retries 429, 502, 503, and 504 up to twice by default. It honors `Retry-After` in seconds or as a date, and otherwise doubles the wait from one second. A `Retry-After` longer than 60 seconds throws instead of sleeping. Each attempt times out after 30 seconds.
- Pagination follows both the `Link: rel="next"` header and `X-Next-Page`. A `Link` target outside this client's API root is refused, because the token rides on every request.
- `parseGitLabProjectPath` refuses input rather than repairing it. Surrounding whitespace, a leading or trailing slash, and a trailing `.git` all return null, so the caller can say what was wrong.
- GitLab does not sign webhook bodies. The `X-Gitlab-Token` comparison is the whole authentication step, so it runs in constant time, and an empty stored secret matches nothing.
- `mergeMergeRequest` sends `sha`, so GitLab refuses with 409 when the merge request's head moved past the checked commit.

## Tests

```bash
pnpm --filter @oxagen/gitlab test:unit src/client.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`. The coverage thresholds in `vitest.config.ts` are 85 percent of lines and statements and 80 percent of branches and functions.
