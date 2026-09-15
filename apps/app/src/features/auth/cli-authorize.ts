// /cli/authorize: the authorize leg of the CLI's RFC 8252 loopback OAuth + PKCE
// login, carried over from apps/app_deprecated/src/app/cli/authorize.
//
// Security invariants:
//   1. A bad redirect_uri is never followed, not even to report an error
//      (RFC 8252 §7.3): parameter errors render inline, and only a LoopbackUri
//      reaches a redirect.
//   2. Every parameter is re-checked in the approve and cancel actions; nothing
//      from the client is trusted, and the organization and workspace resolve
//      through requireViewer.
//   3. The code is minted by authorize_cli, whose handler checks the role.
// The challenge, method and state rules are the contract's own schemas.
import { authCliAuthorize } from "@oxagen/oxagen/contracts/auth.cli.authorize";
import { type LoopbackUri, parseLoopbackUri } from "@/shared/loopback-uri";
import { firstParam, routes, type SafePath } from "@/shared/safe-path";

export type CliAuthorizeParams = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  label: string;
};

export type CliParamError =
  | "redirectUri"
  | "codeChallenge"
  | "codeChallengeMethod"
  | "state";

/** A checked request: the loopback target branded and the method narrowed to the one the contract accepts. */
type CliAuthorizeRequest = {
  redirectUri: LoopbackUri;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  label: string;
};

const DEFAULT_CLI_LABEL = "Oxagen CLI";

const { shape } = authCliAuthorize.input;

export function readAuthorizeParams(
  params: Readonly<Record<string, string | string[] | undefined>>,
): CliAuthorizeParams {
  const label = (firstParam(params.label) ?? "").trim().slice(0, 120);
  return {
    redirectUri: firstParam(params.redirect_uri) ?? "",
    state: firstParam(params.state) ?? "",
    codeChallenge: firstParam(params.code_challenge) ?? "",
    codeChallengeMethod: firstParam(params.code_challenge_method) ?? "",
    label: label || DEFAULT_CLI_LABEL,
  };
}

export function checkAuthorizeParams(
  p: CliAuthorizeParams,
):
  | { ok: true; request: CliAuthorizeRequest }
  | { ok: false; errors: CliParamError[] } {
  const redirectUri = parseLoopbackUri(p.redirectUri);
  const method = shape.codeChallengeMethod.safeParse(p.codeChallengeMethod);
  const errors: CliParamError[] = [];
  if (redirectUri === null) errors.push("redirectUri");
  if (!shape.codeChallenge.safeParse(p.codeChallenge).success)
    errors.push("codeChallenge");
  if (!method.success) errors.push("codeChallengeMethod");
  if (!shape.state.safeParse(p.state).success) errors.push("state");
  if (redirectUri === null || !method.success || errors.length > 0)
    return { ok: false, errors };
  return {
    ok: true,
    request: {
      redirectUri,
      state: p.state,
      codeChallenge: p.codeChallenge,
      codeChallengeMethod: method.data,
      label: p.label,
    },
  };
}

/** This exact request, for a signed-out person to come back to after logging in. */
export function authorizeReturnPath(p: CliAuthorizeParams): SafePath {
  return routes.cliAuthorize({
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    label: p.label,
  });
}
