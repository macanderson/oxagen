import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { TwoFactorForm, readNext } from "@/features/auth";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
} from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";

// Public: after the password step the person holds only Better Auth's short-lived
// two-factor cookie, not a session (src/proxy.ts PUBLIC_PATHS).
export default function TwoFactorPage(props: PageProps<"/two-factor">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <TwoFactor searchParams={props.searchParams} />
    </Suspense>
  );
}

async function TwoFactor({
  searchParams,
}: {
  searchParams: PageProps<"/two-factor">["searchParams"];
}) {
  const params = await searchParams;
  const next = readNext(params);
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("twoFactor.eyebrow")}
        title={t("twoFactor.title")}
      />
      <TwoFactorForm next={next} />
      <AuthFooter>
        <Link href="/login" className={linkText}>
          {t("twoFactor.back")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
