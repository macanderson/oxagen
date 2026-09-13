import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
  ResetPasswordForm,
  firstParam,
  linkText,
} from "@/features/auth";

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
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("reset.eyebrow")}
        title={t("reset.title")}
        lead={t("reset.lead")}
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
