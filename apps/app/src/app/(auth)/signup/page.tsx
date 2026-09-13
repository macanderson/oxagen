import Link from "next/link";

import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import {
  AFTER_SIGNUP,
  OAuthButtons,
  SignupForm,
  firstParam,
  sanitizeNext,
  withNext,
} from "@/features/auth";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
} from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { isFixtureMode } from "@/server/fixture-session";

export default function SignupPage(props: PageProps<"/signup">) {
  return (
    <Suspense fallback={<AuthSkeleton />}>
      <Signup searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Signup({
  searchParams,
}: {
  searchParams: PageProps<"/signup">["searchParams"];
}) {
  const params = await searchParams;
  const next = sanitizeNext(firstParam(params.next), AFTER_SIGNUP);
  const t = await getTranslations("auth");
  const fixture = isFixtureMode();
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("signup.eyebrow")}
        title={t("signup.title")}
        lead={t("signup.lead")}
      />
      <div className="flex flex-col gap-4">
        {fixture ? null : <OAuthButtons callbackURL={next} />}
        <SignupForm fixture={fixture} next={next} />
      </div>
      <AuthFooter>
        {t("signup.haveAccount")}{" "}
        <Link
          href={withNext("/login", next === AFTER_SIGNUP ? "/" : next)}
          className={linkText}
        >
          {t("signup.logIn")}
        </Link>
      </AuthFooter>
      <ul
        className="flex flex-wrap justify-center gap-2"
        aria-label={t("shell.brand")}
      >
        {(["free", "markup", "evidence"] as const).map((tag) => (
          <li
            key={tag}
            className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
          >
            {t(`shell.tags.${tag}`)}
          </li>
        ))}
      </ul>
    </AuthColumn>
  );
}
