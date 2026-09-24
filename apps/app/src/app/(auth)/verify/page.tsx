import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AFTER_SIGNUP, VerifyPanel } from "@/features/auth";
import { firstParam, readNext } from "@/shared/safe-path";
import { AuthColumn, AuthFooter, AuthSkeleton } from "@/ui/auth-shell";
import { linkText, mono } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("verify") };
}

export default function VerifyPage(props: PageProps<"/verify">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Verify searchParams={props.searchParams} />
    </Suspense>
  );
}

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

async function Verify({
  searchParams,
}: {
  searchParams: PageProps<"/verify">["searchParams"];
}) {
  const params = await searchParams;
  const raw = firstParam(params.email)?.trim() ?? "";
  // Shown back to the person who typed it, never looked up: a malformed value is simply not echoed.
  const email = EMAIL_SHAPE.test(raw) ? raw : null;
  const expired = firstParam(params.error) !== undefined;
  const next = readNext(params, AFTER_SIGNUP);
  const [t, pages] = await Promise.all([
    getTranslations("auth"),
    getTranslations("pages"),
  ]);
  return (
    <AuthColumn>
      <PageHeader
        eyebrow={t("verify.eyebrow")}
        title={pages("verify")}
        description={
          email
            ? t.rich("verify.lead", {
                email,
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })
            : t("verify.leadNoEmail")
        }
      />
      <VerifyPanel email={email} expired={expired} next={next} />
      <AuthFooter>
        {t("verify.wrongAddress")}{" "}
        <Link href="/signup" className={linkText}>
          {t("verify.changeIt")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
