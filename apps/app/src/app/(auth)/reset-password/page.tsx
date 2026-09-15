import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/features/auth";
import { firstParam } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
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
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("reset.eyebrow")}
        title={pages("resetPassword")}
        description={t("reset.lead")}
      />
      <ResetPasswordForm token={token} />
      <AuthFooter>
        <Link href="/login" className={linkText}>
          {t("reset.back")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
