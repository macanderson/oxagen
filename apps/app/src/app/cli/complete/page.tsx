import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthColumn, AuthShell } from "@/ui/auth-shell";
import { OutcomePanel } from "@/ui/form-feedback";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("cliComplete") };
}

/**
 * The last leg of `oxagen login`: where the browser lands once the CLI holds
 * its token.
 *
 * The CLI's loopback listener 302s here after the token exchange succeeds
 * (`apps/cli/src/auth/loopback-login.ts`, `cliLoginCompleteUrl`). It used to
 * serve this card itself from `127.0.0.1:<port>`, which ended a production
 * sign-in on a localhost address that reads as a misdirected redirect; a page
 * on the app origin is the honest ending (#3076).
 *
 * It resolves no viewer and reads nothing. The route is public in `proxy.ts`
 * because the browser that finished the exchange may hold no app cookie at all
 * — the token is already in the terminal — and a gated route would end a
 * successful sign-in on `/login` (#3091).
 */
export default async function CliLoginCompletePage() {
  const [t, pages] = await Promise.all([
    getTranslations("auth.cli"),
    getTranslations("pages"),
  ]);
  return (
    <AuthShell>
      <AuthColumn>
        <PageHeader title={pages("cliComplete")} />
        <OutcomePanel
          tone="ok"
          testId="cli-complete"
          title={t("complete.title")}
        >
          <p>{t("complete.body")}</p>
        </OutcomePanel>
      </AuthColumn>
    </AuthShell>
  );
}
