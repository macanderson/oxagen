import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { TwoFactorForm } from "@/features/auth";
import { readNext } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("twoFactor") };
}

// Public: after the password step the person holds only Better Auth's short-lived
// two-factor cookie, not a session (src/proxy.ts PUBLIC_PATHS). The proxy sends
// a visitor holding neither to /login before this page renders.
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
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <TwoFactorForm
        next={next}
        eyebrow={t("twoFactor.eyebrow")}
        title={pages("twoFactor")}
      />
      <AuthFooter>
        <Link href="/login" className={linkText}>
          {t("twoFactor.back")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
