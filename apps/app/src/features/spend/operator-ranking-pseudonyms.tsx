"use client";
// The pseudonym switch beside the operator ranking's heading. Only an org
// Owner or Admin sets this, so the ranking shows the switch to them alone
// (`canSetOperatorPseudonyms`). A save refreshes the page, so the ranking
// reads again under the new setting.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { setOperatorPseudonymsAction } from "./operator-ranking-actions";
import type { SpendAt } from "./view";

export function OperatorPseudonymsToggle({
  at,
  pseudonyms,
}: {
  at: SpendAt;
  pseudonyms: boolean;
}) {
  const t = useTranslations("spend.ranking.pseudonyms");
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setOperatorPseudonymsAction(at, !pseudonyms);
      if (result.ok) navigate.refresh();
      else setError(result.reason === "denied" ? t("denied") : t("failed"));
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex max-w-xs flex-col items-end gap-1.5 text-right">
      <p role="status" className="text-xs text-muted-foreground">
        {pseudonyms ? t("on") : t("off")}
      </p>
      <button
        type="button"
        data-testid="operator-pseudonyms"
        className={buttonSecondary}
        disabled={pending}
        onClick={() => {
          void toggle();
        }}
      >
        {pending ? t("saving") : pseudonyms ? t("turnOff") : t("turnOn")}
      </button>
      {error ? <FormAlert>{error}</FormAlert> : null}
    </div>
  );
}
