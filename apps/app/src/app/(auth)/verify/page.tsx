import Link from "next/link";

import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AFTER_SIGNUP,
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
  VerifyPanel,
  firstParam,
  linkText,
  sanitizeNext,
} from "@/features/auth";

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
  const next = sanitizeNext(firstParam(params.next), AFTER_SIGNUP);
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("verify.eyebrow")}
        title={t("verify.title")}
        lead={email ? t("verify.lead", { email }) : t("verify.leadNoEmail")}
      />
      <VerifyPanel email={email} expired={expired} next={next} />
      <AuthFooter>
        {t("verify.wrongAddress")}{" "}
        <Link href={"/signup"} className={linkText}>
          {t("verify.startOver")}
        </Link>
      </AuthFooter>
    </AuthColumn>
  );
}
