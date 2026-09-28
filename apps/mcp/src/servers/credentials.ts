// credentials.ts: the CredentialSource the served tools call through (lane
// M15; mcp-studio-spec, Credentials).
//
// The vault's source (lane M8, @oxagen/handlers) answers every mode in the
// spec's Authentication table. It reads the mcp.credentials row the
// environment names, refreshes an OAuth token before it expires, and answers
// an operator-oauth server with the token of the person who operates the run.
//
// Building that source reads the workspace's published servers, and the
// served ports are built for every request, including the many that call no
// tool. So the served source builds it on the first resolve and reuses it for
// the rest of the request. A build that fails is dropped, so the next resolve
// tries again.
import type { CredentialRequest, CredentialSource, ResolvedCredential } from "@oxagen/mcp-studio";

/** A CredentialSource that builds the real one on its first resolve. */
export function lazyCredentialSource(build: () => Promise<CredentialSource>): CredentialSource {
  let source: Promise<CredentialSource> | undefined;
  return {
    async resolve(request: CredentialRequest, signal: AbortSignal): Promise<ResolvedCredential> {
      source ??= build().catch((error: unknown) => {
        source = undefined;
        throw error;
      });
      return (await source).resolve(request, signal);
    },
  };
}
