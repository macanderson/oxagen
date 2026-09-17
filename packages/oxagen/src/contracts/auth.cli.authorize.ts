import { z } from "zod";
import { registerCapability } from "../registry";

// Mint the single-use authorization code that completes a CLI login (RFC 8252
// loopback + PKCE S256). The signed-in person consents on the app's
// /cli/authorize page for one org and workspace; the code is bound to that
// scope, to the approving user and to the CLI's code challenge, and the CLI
// exchanges it with its verifier at POST /v1/auth/cli/token for an API key.
//
// The mint has no API or MCP caller: consent needs a Better Auth browser
// session, so `surfaces` is empty and the only invoker is the app's kernel
// seam, which passes no `opts.surface` (apps/app/ARCHITECTURE.md §3.2 step 3).
// `layers` gains "app" when the consent page is wired (WL-50).
//
// Authorization: org Owner or Admin, checked in the handler with
// assertOrgRole; the kernel's IAM check allows every capability for a
// non-enterprise org, so `defaultRoles` is documentation there.
//
// `codeChallenge` and `codeChallengeMethod` are validated here to RFC 7636:
// only S256 is accepted, and a challenge is exactly 43 unpadded base64url
// characters. `redirectUri` is checked by the handler against the one
// loopback rule in @oxagen/auth/cli-auth, so this schema requires only a
// string; a non-loopback target is refused as `invalid_input`.
export const authCliAuthorize = registerCapability({
  name: "authorize_cli",
  domain: "auth",
  description:
    "Mint the single-use PKCE authorization code that lets the Oxagen CLI obtain an API key for one org and workspace after the signed-in person consents.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs", "app"],
  scoped: true,
  // A credential-issuing settings write is never a governed action (§1.5).
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    codeChallenge: z
      .string()
      .regex(/^[A-Za-z0-9\-_]{43}$/)
      .describe("Base64url SHA-256 of the CLI's PKCE code_verifier (RFC 7636)"),
    codeChallengeMethod: z
      .literal("S256")
      .describe("The PKCE transform; S256 is the only accepted method"),
    redirectUri: z
      .string()
      .min(1)
      .describe(
        "The CLI's loopback listener (http://127.0.0.1:<port>/…); the handler refuses any non-loopback target",
      ),
    label: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Human label for the API key the code will be exchanged for"),
    state: z
      .string()
      .min(1)
      .describe(
        "The CLI's CSRF token; the consent page echoes it on the loopback redirect and the invocation records it",
      ),
  }),
  output: z.object({
    code: z
      .string()
      .describe(
        "The single-use authorization code, valid for five minutes, to send to the loopback redirect",
      ),
  }),
});
