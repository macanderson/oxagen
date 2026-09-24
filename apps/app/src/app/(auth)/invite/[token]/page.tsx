import type { Metadata } from "next";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { cache, Suspense } from "react";
import {
  InvitationBody,
  InvitationNotFound,
  InvitationWrongAccount,
  decideInvitation,
  getAuthUser,
  loadInvitation,
} from "@/features/auth";
import { AuthColumn, AuthSkeleton } from "@/ui/auth-shell";
import { PageHeader } from "@/ui/page-header";

// generateMetadata and the page read the token once per request.
const invitation = cache(loadInvitation);

/** pages.invitation when the token resolves, pages.invitationNotFound otherwise: the tab title and the h1. */
async function titled(token: string) {
  const [read, t] = await Promise.all([
    invitation(token),
    getTranslations("pages"),
  ]);
  const title = read.ok
    ? t("invitation", { org: read.value.orgName })
    : t("invitationNotFound");
  return { read, title };
}

export async function generateMetadata({
  params,
}: PageProps<"/invite/[token]">): Promise<Metadata> {
  const { token } = await params;
  const { title } = await titled(token);
  return { title };
}

// Public: the token is the capability. A signed-out visitor sees what the
// invitation email already said and is asked to sign in as the invited address.
export default function InvitePage(props: PageProps<"/invite/[token]">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Invite params={props.params} />
    </Suspense>
  );
}

async function Invite({
  params,
}: {
  params: PageProps<"/invite/[token]">["params"];
}) {
  const { token } = await params;
  const [{ read, title }, user, t] = await Promise.all([
    titled(token),
    getAuthUser(),
    getTranslations("auth.invite"),
  ]);
  if (!read.ok) {
    return (
      <AuthColumn wide>
        <PageHeader eyebrow={t("eyebrow")} title={title} />
        <InvitationNotFound />
      </AuthColumn>
    );
  }
  // Expiry is judged against the request's clock, never a prerendered one.
  await connection();
  const decision = decideInvitation(read.value, user?.email ?? null);
  // Another signed-in account gets one full card in place of the page.
  if (decision.kind === "wrong-account") {
    return (
      <AuthColumn wide>
        <InvitationWrongAccount
          invitation={read.value}
          signedInAs={decision.signedInAs}
        />
      </AuthColumn>
    );
  }
  return (
    <AuthColumn wide>
      <PageHeader eyebrow={t("eyebrow")} title={title} />
      <InvitationBody invitation={read.value} decision={decision} />
    </AuthColumn>
  );
}
