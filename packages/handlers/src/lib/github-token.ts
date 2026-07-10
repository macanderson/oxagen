// Per-workspace GitHub token resolution (ADR-020) now lives in @oxagen/github so
// it can be shared without a packages/agent → packages/handlers dependency cycle
// (handlers already depends on agent). It is exposed on the `./workspace-token`
// subpath — NOT the barrel — so unit tests that fully mock the `@oxagen/github`
// module for installation-token stubbing don't accidentally clobber it.
export {
  resolveGitHubToken,
  type GitHubWorkspaceScope,
} from "@oxagen/github/workspace-token";
