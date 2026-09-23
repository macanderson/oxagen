import { cookies } from "next/headers";
import { z } from "zod";
import { runIssueAuthorizationComplete } from "@oxagen/oxagen/contracts/run.issue.authorization.complete";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { responseRedirect } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";
const cookieSchema = z.object({
  org: z.string().min(1),
  ws: z.string().min(1),
  runId: z.string().min(1),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export async function handleLinearCallback(
  request: Request,
): Promise<Response> {
  const jar = await cookies();
  const raw = jar.get("oxagen_run_linear")?.value;
  jar.set("oxagen_run_linear", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/api/run-outcomes/linear/callback",
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw ?? "null");
  } catch {
    return new Response(
      "Linear authorization could not be verified. Return to the Run and try again.",
      { status: 400 },
    );
  }
  const cookie = cookieSchema.safeParse(decoded);
  const query = new URL(request.url).searchParams;
  if (
    !cookie.success ||
    query.get("state") !== cookie.data.state ||
    !query.get("code")
  )
    return new Response(
      "Linear authorization could not be verified. Return to the Run and try again.",
      { status: 400 },
    );
  const { org, ws, runId, state } = cookie.data;
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, runIssueAuthorizationComplete, {
    state,
    code: query.get("code") ?? "",
  });
  if (!result.ok)
    return new Response(
      "Linear authorization was refused. Return to the Run to check consent and try again.",
      { status: 403 },
    );
  return responseRedirect(request, routes.run(org, ws, runId));
}
