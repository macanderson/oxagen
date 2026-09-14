// GitHub App "Setup URL" landing: a callback, not a page (spec Appendix F).
// Resolves where the person lands and redirects; see features/auth/github-setup.ts.
import { type NextRequest, NextResponse } from "next/server";
import {
  getAuthUser,
  githubSetupQueries,
  parseInstallationId,
  resolveGithubSetupTarget,
  withNext,
} from "@/features/auth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthUser();
  const here = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (!user)
    return NextResponse.redirect(
      new URL(withNext("/login", here), request.url),
    );
  const installationId = parseInstallationId(
    request.nextUrl.searchParams.get("installation_id") ?? undefined,
  );
  const target = await resolveGithubSetupTarget(
    user.id,
    installationId,
    githubSetupQueries(),
  );
  return NextResponse.redirect(new URL(target, request.url));
}
