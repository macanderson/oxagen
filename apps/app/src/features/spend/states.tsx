// The Spend page's not-loaded states (#2962): a refused, pending or failed
// read, and a period with nothing rolled up. Each replaces the page body
// under the tabs and never the shell.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { SpendAt } from "./view";

type Failed = Extract<Read<never>, { ok: false }>;

const box = `${panel} flex flex-col gap-2 p-6`;

export function SpendReadFailure({ read }: { read: Failed }) {
  const t = useTranslations("spend");
  switch (read.reason) {
    case "denied":
      return (
        <section data-state="denied" className={box}>
          <h2 className="text-base font-semibold">
            {t("failure.denied.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("failure.denied.body", { permission: read.permission })}
          </p>
        </section>
      );
    case "pending_approval":
      return (
        <section data-state="pending_approval" className={box}>
          <h2 className="text-base font-semibold">
            {t("failure.pending.title")}
          </h2>
          <p className={`text-sm text-muted-foreground ${mono}`}>
            {t("failure.pending.body", { request: read.accessRequestId })}
          </p>
        </section>
      );
    case "error":
      return (
        <section data-state="error" className={box}>
          <h2 className="text-base font-semibold">
            {t("failure.error.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("failure.error.body")}
          </p>
          <p className={`text-xs text-muted-foreground ${mono}`}>
            {t("failure.error.code", {
              code: read.code,
              status: String(read.status),
            })}
          </p>
        </section>
      );
  }
}

export function SpendEmpty({ at }: { at: SpendAt }) {
  const t = useTranslations("spend");
  return (
    <section data-state="empty" className={box}>
      <h2 className="text-base font-semibold">{t("empty.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("empty.body")}</p>
      <SafeLink to={routes.fleet(at.org, at.ws)} className={linkText}>
        {t("empty.back")}
      </SafeLink>
    </section>
  );
}
