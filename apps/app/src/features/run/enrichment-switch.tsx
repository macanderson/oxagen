"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useNavigate } from "@/ui/navigation";
import { useActionFailure, UNANSWERED } from "@/ui/command-failure";
import { setRunEnrichment } from "./actions";

export function EnrichmentSwitch({
  org,
  ws,
  enabled,
  canEdit,
}: {
  org: string;
  ws: string;
  enabled: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations("run.enrichment");
  const navigate = useNavigate();
  const failureText = useActionFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="max-w-prose text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit || pending}
          onChange={async (event) => {
            const next = event.target.checked;
            setPending(true);
            setFailure(null);
            try {
              const result = await setRunEnrichment(org, ws, next);
              if (result.ok) navigate.refresh();
              else setFailure(failureText(result));
            } catch {
              setFailure(failureText(UNANSWERED));
            } finally {
              setPending(false);
            }
          }}
        />
        {t("label")}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
