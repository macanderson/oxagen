"use server";
import { cookies } from "next/headers";
import { runIssueAuthorizationBegin } from "@oxagen/oxagen/contracts/run.issue.authorization.begin";
import { runIssueProvidersGet } from "@oxagen/oxagen/contracts/run.issue.providers.get";
import { kernelWrite, kernelRead } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { parseLinearAuthorizationUrl } from "@/shared/linear-authorization-url";
import { redirectToLinearAuthorization } from "@/shared/navigation";

export async function loadRunIssueProviders(
  at: { org: string; ws: string },
  linearConnectionId?: string,
  after?: string,
) {
  const ctx = await requireViewer(at.org, at.ws);
  return kernelRead(ctx, {
    contract: runIssueProvidersGet,
    input: { linearConnectionId, after },
    page: "run",
  });
}
export async function authorizeRunIssues(
  at: { org: string; ws: string },
  runId: string,
) {
  const ctx = await requireViewer(at.org, at.ws);
  const result = await kernelWrite(ctx, runIssueAuthorizationBegin, {
    provider: "linear",
  });
  if (!result.ok) return result;
  const url = parseLinearAuthorizationUrl(result.value.authorizeUrl);
  if (!url)
    return {
      ok: false as const,
      reason: "unavailable" as const,
      code: "linear_authorization_url_invalid",
    };
  const state = new URL(url).searchParams.get("state");
  (await cookies()).set(
    "oxagen_run_linear",
    JSON.stringify({ ...at, runId, state }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/api/run-outcomes/linear/callback",
    },
  );
  redirectToLinearAuthorization(url);
}
