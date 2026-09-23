import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/features/auth";
import { firstParam } from "@/shared/safe-path";
import { AuthColumn, AuthSkeleton } from "@/ui/auth-shell";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("resetPassword") };
}

export default function ResetPasswordPage(props: PageProps<"/reset-password">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Reset searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Reset({
  searchParams,
}: {
  searchParams: PageProps<"/reset-password">["searchParams"];
}) {
  const params = await searchParams;
  // Better Auth lands here with ?token= on a good link and ?error= on a spent one.
  const token =
    firstParam(params.error) === undefined
      ? (firstParam(params.token) ?? "")
      : "";
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  // The page is reached from the emailed link only, so it carries no footer
  // link. The lead cannot name the address until the token is readable (#3887).
  return (
    <AuthColumn>
      <ResetPasswordForm
        token={token}
        header={
          <PageHeader
            eyebrow={t("reset.eyebrow")}
            title={pages("resetPassword")}
            description={t("reset.lead")}
          />
        }
      />
    </AuthColumn>
  );
}
