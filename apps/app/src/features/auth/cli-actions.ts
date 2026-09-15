"use server";
// Approve or cancel a CLI login (RFC 8252 loopback + PKCE); see cli-authorize.ts
// for the invariants. Approve mints a single-use code through authorize_cli for
// the organization and workspace the viewer resolves to, bound to the CLI's
// PKCE challenge, then hands it to the loopback listener. Cancel asks for the
// same signed-in person before it answers the listener.
import { authCliAuthorize } from "@oxagen/oxagen/contracts/auth.cli.authorize";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireUser, requireViewer } from "@/server/viewer";
import { parseLoopbackUri } from "@/shared/loopback-uri";
import { redirectToLoopback } from "@/shared/navigation";
import { checkAuthorizeParams, readAuthorizeParams } from "./cli-authorize";

export type CliActionState = ActionResult<never> | null;

const PARAM_FIELDS = [
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "label",
] as const;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function invalid(field: string | undefined): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

export async function approveCliAuth(
  _prev: CliActionState,
  form: FormData,
): Promise<ActionResult<never>> {
  const checked = checkAuthorizeParams(
    readAuthorizeParams(
      Object.fromEntries(PARAM_FIELDS.map((name) => [name, text(form, name)])),
    ),
  );
  if (!checked.ok) return invalid(checked.errors[0]);
  const { request } = checked;
  const ctx = await requireViewer(
    text(form, "org_slug"),
    text(form, "workspace_slug"),
  );
  const result = await kernelWrite(ctx, authCliAuthorize, request);
  if (!result.ok) return result;
  return redirectToLoopback(request.redirectUri, {
    code: result.value.code,
    state: request.state,
  });
}

export async function cancelCliAuth(
  _prev: CliActionState,
  form: FormData,
): Promise<ActionResult<never>> {
  await requireUser();
  // Only a checked loopback URI is ever followed.
  const redirectUri = parseLoopbackUri(text(form, "redirect_uri"));
  const state = text(form, "state");
  if (redirectUri === null) return invalid("redirectUri");
  if (state === "") return invalid("state");
  return redirectToLoopback(redirectUri, { error: "access_denied", state });
}
