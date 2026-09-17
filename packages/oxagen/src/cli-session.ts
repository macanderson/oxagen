// cli-session.ts — the API-key scope purpose `oxagen login` mints a terminal
// session with, and the predicate that recognises a request to self-assert it.
//
// It lives here, beside `agent-credential.ts`, for the same reason that one
// does: the purpose is a fact about a credential, and the packages that need
// to agree on it — `@oxagen/auth` (which resolves the key to its person),
// `@oxagen/handlers` (which refuses to mint or rotate one) and `@oxagen/iam`
// (which decides what such a key may invoke) — all already depend on
// `@oxagen/oxagen` and must not have to depend on each other to read a
// fifteen-character string. `@oxagen/auth` is the Better Auth transport
// layer; pointing policy at it to learn a constant is a dependency edge that
// buys nothing and constrains everything downstream of it.
//
// The scope is server-owned: `POST /v1/auth/cli/token` is its one writer, and
// `create_api_key` / `rotate_api_key` refuse to mint or preserve it, the same
// trust boundary the Tacho host and agent credential purposes keep.

/**
 * The scope purpose of the key the CLI token exchange mints. `resolveApiKey`
 * authenticates a key carrying it as the user who approved the authorize flow
 * (`CliAuthCodeData.userId`, recorded as the key's creator) and re-checks that
 * user's org and workspace membership on every call, so a handler's role gate
 * sees the person behind the terminal.
 *
 * A surface that presents such a key without resolving that person is not
 * presenting a person's credential — `machineKeyDenial` refuses it rather than
 * exempting it (`packages/iam/src/machine-key-scope.ts`).
 */
export const CLI_SESSION_SCOPE_PURPOSE = "cli_session_v1" as const;

/** Whether a caller-supplied scope asks for the reserved CLI session purpose. */
export function requestsReservedCliSessionPurpose(scope: unknown): boolean {
  return (
    typeof scope === "object" &&
    scope !== null &&
    "purpose" in scope &&
    scope.purpose === CLI_SESSION_SCOPE_PURPOSE
  );
}
