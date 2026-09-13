import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AuthColumn,
  AuthHeading,
  AuthSkeleton,
  InvitationBody,
  InvitationNotFound,
  decideInvitation,
  getAuthUser,
  loadInvitation,
} from "@/features/auth";

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
  const [read, user, t] = await Promise.all([
    loadInvitation(token),
    getAuthUser(),
    getTranslations("auth.invite"),
  ]);
  if (!read.ok) {
    return (
      <AuthColumn wide>
        <AuthHeading kicker={t("eyebrow")} title={t("notFoundTitle")} />
        <InvitationNotFound />
      </AuthColumn>
    );
  }
  // Expiry is judged against the request's clock, never a prerendered one.
  await connection();
  const decision = decideInvitation(read.value, user?.email ?? null);
  return (
    <AuthColumn wide>
      <AuthHeading
        kicker={t("eyebrow")}
        title={t("title", { org: read.value.orgName })}
      />
      <InvitationBody invitation={read.value} decision={decision} />
    </AuthColumn>
  );
}
