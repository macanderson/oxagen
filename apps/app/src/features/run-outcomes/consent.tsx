"use client";
import type { RunOutcomesPolicy } from "@oxagen/oxagen/run-outcomes";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { Read } from "@/data/read";
import { buttonSecondary, panel } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { FormAlert } from "@/ui/form-feedback";
import { ReadFailure } from "@/ui/read-failure";
import { setRunOutcomesConsentAction } from "./actions";

export function RunOutcomesConsent({
  at,
  policy,
  canManage,
}: {
  at: { org: string; ws: string };
  policy: Read<RunOutcomesPolicy>;
  canManage: boolean;
}) {
  const t = useTranslations("runOutcomes");
  const navigate = useNavigate();
  const [saved, setSaved] = useState<{
    base: RunOutcomesPolicy;
    value: RunOutcomesPolicy;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = policy.ok
    ? saved?.base === policy.value
      ? saved.value
      : policy.value
    : null;
  async function toggle() {
    if (pending || !current || !canManage) return;
    setPending(true);
    setError(null);
    try {
      const result = await setRunOutcomesConsentAction(
        at,
        !current.customerEnabled,
      );
      if (result.ok) {
        if (policy.ok) setSaved({ base: policy.value, value: result.value });
        navigate.refresh();
      } else
        setError(result.reason === "denied" ? t("denied") : t("saveFailed"));
    } catch {
      setError(t("saveFailed"));
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label={t("title")} className={`${panel} space-y-3 p-4`}>
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      {!policy.ok ? (
        <ReadFailure read={policy} section={t("title")} />
      ) : current ? (
        <>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          <p role="status" className="text-sm">
            {current.platformDisabled
              ? t("platformDisabled")
              : current.customerEnabled
                ? t("enabled")
                : t("disabled")}
          </p>
          {current.platformDisabledReason ? (
            <p className="text-sm text-muted-foreground">
              {current.platformDisabledReason}
            </p>
          ) : null}
          {canManage ? (
            <button
              type="button"
              data-testid="run-outcomes-consent"
              className={buttonSecondary}
              disabled={
                pending ||
                (current.platformDisabled && !current.customerEnabled)
              }
              onClick={() => {
                void toggle();
              }}
            >
              {pending
                ? t("saving")
                : current.customerEnabled
                  ? t("disable")
                  : t("enable")}
            </button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("ownerRequired")}
            </p>
          )}
          {error ? <FormAlert>{error}</FormAlert> : null}
        </>
      ) : null}
    </section>
  );
}
