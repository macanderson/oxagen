"use client";
// The writes on an agent identity, each behind a confirming dialog: rotate the
// credential (the new secret shown once, in the dialog), suspend or resume,
// and deregister (retire_agent). A refusal is named in the dialog and changes
// nothing; a completed suspend or deregister reloads the page it leaves.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { buttonDanger } from "./parts";
import {
  retireAgent,
  rotateAgentCredential,
  setAgentSuspended,
} from "./actions";
import { useFormatter } from "@/ui/formatter";

type Copy = {
  open: string;
  title: string;
  body: string;
  confirm: string;
  pending: string;
};

function WriteDialog<O>({
  copy,
  testId,
  write,
  onDone,
  done,
  danger = false,
}: {
  copy: Copy;
  testId: string;
  write: () => Promise<ActionResult<O>>;
  /** Runs after the write answered ok; returning true closes the dialog. */
  onDone: (value: O) => boolean;
  /** What the dialog shows once the write answered ok and stayed open. */
  done?: (value: O) => ReactNode;
  /** A write that ends something draws its opener in the danger ink (`.btn.danger`). */
  danger?: boolean;
}) {
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [value, setValue] = useState<{ result: O } | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setValue(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) {
        if (onDone(result.value)) setOpen(false);
        else setValue({ result: result.value });
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
    <>
      <button
        type="button"
        className={danger ? buttonDanger : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {copy.open}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={copy.title}
        testId={testId}
      >
        {value !== null && done !== undefined ? (
          done(value.result)
        ) : (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{copy.body}</p>
            {failure === null ? null : (
              <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={copy.confirm}
              pendingLabel={copy.pending}
            />
          </form>
        )}
      </SheetDialog>
    </>
  );
}

type Target = { org: string; ws: string; agentId: string; name: string };

/** The dialog's words for one write. */
function useCopy(
  key: "rotate" | "suspend" | "resume" | "retire",
  name: string,
): Copy {
  const t = useTranslations("agents.actions");
  return {
    open: t(`${key}.open`),
    title: t(`${key}.title`, { name }),
    body: t(`${key}.body`),
    confirm: t(`${key}.confirm`),
    pending: t(`${key}.pending`),
  };
}

/** Deregister, from the identities table or the agent's header. */
export function RetireAgent({
  org,
  ws,
  agentId,
  name,
  after,
  danger = false,
}: Target & {
  /** The identities list, reloaded once the agent is retired. */
  after: SafePath;
  /** The agent's header draws it in the danger ink; the list's row does not. */
  danger?: boolean;
}) {
  const navigate = useNavigate();
  const copy = useCopy("retire", name);
  return (
    <WriteDialog
      copy={copy}
      testId="retire-agent"
      danger={danger}
      write={() => retireAgent(org, ws, agentId)}
      onDone={() => {
        navigate.replace(after);
        return true;
      }}
    />
  );
}

export function AgentActions({
  org,
  ws,
  agentId,
  name,
  suspended,
  here,
  list,
}: Target & {
  suspended: boolean;
  /** This agent's page, reloaded after a suspend or resume. */
  here: SafePath;
  /** The identities list, where a deregistered agent's page goes. */
  list: SafePath;
}) {
  const t = useTranslations("agents.actions");
  const format = useFormatter();
  const navigate = useNavigate();
  const suspendKey = suspended ? "resume" : "suspend";
  const rotateCopy = useCopy("rotate", name);
  const suspendCopy = useCopy(suspendKey, name);
  return (
    <>
      <WriteDialog
        copy={rotateCopy}
        testId="rotate-credential"
        write={() => rotateAgentCredential(org, ws, agentId)}
        onDone={() => false}
        done={(credential) => (
          <div role="status" className="flex flex-col gap-2 text-sm">
            <p>{t("rotate.done")}</p>
            <code
              data-testid="credential-secret"
              className={`${mono} break-all rounded-md bg-muted px-2 py-1`}
            >
              {credential.secret}
            </code>
            <p className="text-xs text-muted-foreground">
              {t("rotate.expires", {
                at: format.dateTime(new Date(credential.expiresAt), {
                  dateStyle: "medium",
                }),
              })}
            </p>
          </div>
        )}
      />
      <WriteDialog
        key={suspendKey}
        copy={suspendCopy}
        testId={`${suspendKey}-agent`}
        danger={!suspended}
        write={() => setAgentSuspended(org, ws, agentId, !suspended)}
        onDone={() => {
          navigate.replace(here);
          return true;
        }}
      />
      <RetireAgent
        org={org}
        ws={ws}
        agentId={agentId}
        name={name}
        after={list}
        danger
      />
    </>
  );
}
