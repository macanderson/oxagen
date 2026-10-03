"use client";
// Read now: the button on every collector row that is not paused. It reads
// the collector's repositories again now (sync_work_collector) rather than at
// the next 15-minute sweep, queues one read, says so, and the page reads the
// collector again. A paused collector or a role that cannot change
// collectors is refused on the server, and the refusal is shown here.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/ui/button";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { syncCollector } from "../actions";
import { UNANSWERED, useListActionFailure } from "../list-action-failure";

export function Reconnect({
  org,
  ws,
  name,
  canControl,
}: {
  org: string;
  ws: string;
  /** The collector's name, unique in the workspace, which sync_work_collector names. */
  name: string;
  /** Whether the viewer may change collectors; unknown reads as allowed and the server decides. */
  canControl: boolean;
}) {
  const t = useTranslations("work.setup.collectors");
  const failureText = useListActionFailure();
  const navigate = useNavigate();
  const reasonId = useId();
  const [pending, setPending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function readAgain() {
    if (pending) return;
    setPending(true);
    setQueued(false);
    setFailure(null);
    try {
      const result = await syncCollector(org, ws, { name });
      if (result.ok) {
        setQueued(true);
        navigate.refresh();
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        data-testid={`work-reconnect-${name}`}
        data-touch-target=""
        disabled={!canControl}
        aria-describedby={canControl ? undefined : reasonId}
        aria-disabled={pending || undefined}
        aria-label={pending ? undefined : t("reconnectLabel", { name })}
        title={canControl ? undefined : t("noRole")}
        variant="outline"
        onClick={() => void readAgain()}
      >
        {pending ? t("reconnectPending") : t("reconnect")}
      </Button>
      {canControl ? null : (
        <span id={reasonId} className="sr-only">
          {t("noRole")}
        </span>
      )}
      <p
        role="status"
        data-testid={`work-reconnect-status-${name}`}
        className="text-base text-muted-foreground"
      >
        {queued ? t("reconnectQueued", { name }) : null}
      </p>
      {failure === null ? null : (
        <FormAlert testId={`work-reconnect-failure-${name}`}>{failure}</FormAlert>
      )}
    </div>
  );
}
