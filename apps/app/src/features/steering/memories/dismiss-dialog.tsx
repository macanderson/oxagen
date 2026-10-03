"use client";
// Dismiss (memory-collection spec, Lifecycle; the mockup's steering.js
// `DIALOGS["str-mem-dismiss"]`): the selected rows' waiting memories, set
// aside so the curator does not propose their statements again. Restore in
// the drawer brings one back.
//
// dismiss_memories takes no reason, so the dialog asks for none: a reason the
// write cannot keep would read as recorded when it is not. A refused or
// failed call keeps the dialog, says what failed, and moves no memory.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { WorkspaceMemory } from "@/data/contracts/steering";
import { buttonPrimary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import type { SteeringAt } from "../view";
import { dismissMemories } from "./actions";
import { AgentValue, type MemoryAgents, memoryName } from "./cells";
import {
  type MemoryWriteFailure,
  UNANSWERED,
  useMemoryWriteFailure,
} from "./failure";

export function DismissDialog({
  at,
  rows,
  agents,
  onClose,
  onDone,
}: {
  at: SteeringAt;
  /** One entry per selected row: the memories that say the same thing. */
  rows: readonly (readonly WorkspaceMemory[])[];
  agents: MemoryAgents;
  onClose: () => void;
  /** Called with the sentence the page toasts once the memories are dismissed. */
  onDone: (text: string) => void;
}) {
  const t = useTranslations("steering.memories.dismiss");
  const failureText = useMemoryWriteFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const waiting = rows.flatMap((row) =>
    row.filter((memory) => memory.state === "waiting"),
  );
  const submit = async () => {
    setPending(true);
    setFailure(null);
    const result: Awaited<ReturnType<typeof dismissMemories>> =
      await dismissMemories(
        at.org,
        at.ws,
        waiting.map((memory) => memory.id),
        false,
      ).catch((): MemoryWriteFailure => UNANSWERED);
    setPending(false);
    if (result.ok) onDone(t("done", { count: result.value.changed }));
    else setFailure(failureText(result));
  };
  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title", { count: waiting.length })}
      subtitle={t("sub")}
      testId="dismiss-dialog"
      closeLabel={t("cancel")}
      headerClose
      dismissible={!pending}
      footer={
        waiting.length === 0 ? null : (
          <button
            type="button"
            data-testid="dismiss-submit"
            className={buttonPrimary}
            disabled={pending}
            onClick={() => {
              void submit();
            }}
          >
            {pending ? t("pending") : t("confirm", { count: waiting.length })}
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {waiting.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t("noneWaiting")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-[13px]" data-testid="dismiss-list">
            {waiting.map((memory) => (
              <li key={memory.id} className="flex flex-col gap-0.5">
                <span className="text-foreground">{memoryName(memory)}</span>
                <span className="text-[12px] text-muted-foreground">
                  <AgentValue agent={memory.agent} agents={agents} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {failure === null ? null : (
          <FormAlert testId="dismiss-failure">{failure}</FormAlert>
        )}
      </div>
    </SheetDialog>
  );
}
