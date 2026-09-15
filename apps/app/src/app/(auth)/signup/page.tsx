import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AFTER_SIGNUP, OAuthButtons, SignupForm } from "@/features/auth";
import { readNext, routes } from "@/shared/safe-path";
import {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthSkeleton,
} from "@/ui/auth-shell";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

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
  const next = readNext(params, AFTER_SIGNUP);
  const t = await getTranslations("auth");
  return (
    <AuthColumn>
      <AuthHeading
        kicker={t("signup.eyebrow")}
        title={t("signup.title")}
        lead={t("signup.lead")}
      />
      <div className="flex flex-col gap-4">
        <OAuthButtons callbackURL={next} />
        <SignupForm next={next} />
      </div>
      <AuthFooter>
        {t("signup.haveAccount")}{" "}
        <SafeLink
          to={routes.login(next === AFTER_SIGNUP ? routes.root() : next)}
          className={linkText}
        >
          {t("signup.logIn")}
        </SafeLink>
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
