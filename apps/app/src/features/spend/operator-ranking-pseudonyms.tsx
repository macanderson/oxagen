"use client";
// The pseudonym switch beside the operator ranking's heading. Only an org
// Owner or Admin sets this, so the ranking shows the switch to them alone
// (`canSetOperatorPseudonyms`). A save refreshes the page, so the ranking
// reads again under the new setting. When the ranking did not load, as on a
// period that holds two currencies, the setting it carries is unknown: the
// switch then offers both choices, so the setting stays in reach (#4574).
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { setOperatorPseudonymsAction } from "./actions";
import type { SpendAt } from "./view";

export function OperatorPseudonymsToggle({
  at,
  pseudonyms,
}: {
  at: SpendAt;
  /** The setting in force; null when the ranking that carries it did not load. */
  pseudonyms: boolean | null;
}) {
  const t = useTranslations("spend.ranking.pseudonyms");
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose(enabled: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setOperatorPseudonymsAction(at, enabled);
      if (result.ok) navigate.refresh();
      else setError(result.reason === "denied" ? t("denied") : t("failed"));
    } catch {
      setError(t("failed"));
    } finally {
      setPending(false);
    }
  }
  const button = (enabled: boolean, label: string) => (
    <button
      key={label}
      type="button"
      data-testid={
        pseudonyms === null
          ? `operator-pseudonyms-${enabled ? "on" : "off"}`
          : "operator-pseudonyms"
      }
      className={buttonSecondary}
      disabled={pending}
      onClick={() => {
        void choose(enabled);
      }}
    >
      {pending ? t("saving") : label}
    </button>
  );
  return (
    <div className="flex max-w-xs flex-col items-end gap-1.5 text-right">
      <p role="status" className="text-xs text-muted-foreground">
        {pseudonyms === null ? t("unknown") : pseudonyms ? t("on") : t("off")}
      </p>
      {pseudonyms === null ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {button(true, t("turnOn"))}
          {button(false, t("turnOff"))}
        </div>
      ) : pseudonyms ? (
        button(false, t("turnOff"))
      ) : (
        button(true, t("turnOn"))
      )}
      {error ? <FormAlert>{error}</FormAlert> : null}
    </div>
  );
}
