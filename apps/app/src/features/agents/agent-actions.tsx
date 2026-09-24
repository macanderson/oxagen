"use client";
// The writes on an agent identity, each behind a confirming dialog: rotate the
// credential (the new secret shown once, in the dialog), suspend or resume,
// and deregister (retire_agent). A refusal is named in the dialog and changes
// nothing; a completed suspend or deregister reloads the page it leaves.
//
// Deregister is the design's `delagent` dialog: the agent key under the title,
// what ends (the roles held, read when it opens, the mandates and the host
// enrollment) and what is kept, and a checkbox the danger button in the footer
// waits on. A completed deregister leaves a receipt in the dialog, and the list
// reloads when the person closes it. It
// says plainly that it opens no pull request: `retire_agent` retires the
// principal and revokes what it holds, and archiving the definition file is
// #3855.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import { buttonDanger, buttonSecondary, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog, SheetFooterAction } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  readAgentRoleNames,
  retireAgent,
  rotateAgentCredential,
  setAgentSuspended,
} from "./actions";

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
  /** Draws the trigger as `.btn.danger`, for a write that ends something. */
  danger?: boolean;
  write: () => Promise<ActionResult<O>>;
  /** Runs after the write answered ok; returning true closes the dialog. */
  onDone: (value: O) => boolean;
  /** What the dialog shows once the write answered ok and stayed open. */
  done?: (value: O) => ReactNode;
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
function useCopy(key: "rotate" | "suspend" | "resume", name: string): Copy {
  const t = useTranslations("agents.actions");
  return {
    open: t(`${key}.open`),
    title: t(`${key}.title`, { name }),
    body: t(`${key}.body`),
    confirm: t(`${key}.confirm`),
    pending: t(`${key}.pending`),
  };
}

/** What deregistering ends, when the caller has the counts in hand. */
type Holds = { mandates: number; hosts: number };

/** Deregister, from the identities table or the agent's header. */
export function RetireAgent({
  org,
  ws,
  agentId,
  name,
  slug,
  holds,
  after,
  danger = false,
}: Target & {
  /** The definition file's name, which the pull-request line names. */
  slug: string;
  /** The mandates and host enrollments retirement ends; omitted where the page has no counts. */
  holds?: Holds;
  /** The agents list, reloaded once the agent is retired. */
  after: SafePath;
  /** The list's row action is `.btn.danger`; the agent page's header keeps the plain button. */
  danger?: boolean;
}) {
  const t = useTranslations("agents.actions.retire");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The roles the agent holds, read when the dialog opens; null until they
  // answer or when the read failed, and the Ends line then names them without
  // a count.
  const [roles, setRoles] = useState<number | null>(null);
  const [retired, setRetired] = useState(false);
  const testId = "retire-agent";
  const formId = `${testId}-${slug}-form`;

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await readAgentRoleNames(org, ws, agentId);
        setRoles(result.ok ? result.value.length : null);
      } catch {
        setRoles(null);
      }
    })();
  }, [open, org, ws, agentId]);

  function openChange(next: boolean) {
    setOpen(next);
    if (next) return;
    setFailure(null);
    setUnderstood(false);
    // The list reloads once the receipt is read: the retired row loses its
    // Deregister action, and with it this dialog.
    if (retired) navigate.replace(after);
    setRetired(false);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !understood) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await retireAgent(org, ws, agentId);
      if (result.ok) setRetired(true);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const ends =
    holds === undefined
      ? t("endsUnknown")
      : roles === null
        ? t("endsValueNoRoles", holds)
        : t("endsValue", { ...holds, roles });
  // In flight is the design's third row. No read counts an agent's live runs
  // and `retire_agent` cancels none, so the row says so and names the gap
  // (#3975) rather than printing a count or a promise.
  const facts: readonly [string, ReactNode][] = [
    [t("kept"), t("keptValue")],
    [t("ends"), ends],
    [
      t("inFlight"),
      <span
        key="in-flight"
        data-not-backed=""
        data-gap="#3975"
        className="text-muted-foreground"
      >
        {t("inFlightUnrecorded")}
      </span>,
    ],
  ];
  return (
    <>
      <button
        type="button"
        className={danger ? buttonDanger : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title")}
        subtitle={name}
        closeLabel={retired ? t("close") : t("cancel")}
        testId={testId}
      >
        {retired ? (
          <p
            role="status"
            data-testid={`${testId}-receipt`}
            className="text-sm text-foreground"
          >
            {t("done", { name })}
          </p>
        ) : (
          <form
            id={formId}
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3 text-sm"
          >
            <p>{t("body")}</p>
            <p
              data-not-backed=""
              data-gap="#3855"
              className="text-xs text-muted-foreground"
            >
              {t.rich("pullRequest", {
                slug,
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {facts.map(([term, value]) => (
                <div key={term} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={understood}
                data-touch-target=""
                className="mt-0.5"
                onChange={(event) => {
                  setUnderstood(event.target.checked);
                }}
              />
              <span className="flex flex-col">
                <span>{t("understand")}</span>
                <span className="text-xs text-muted-foreground">
                  {t("understandHint")}
                </span>
              </span>
            </label>
            {failure === null ? null : (
              <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
            )}
            <SheetFooterAction>
              <button
                type="submit"
                form={formId}
                disabled={!understood || pending}
                data-touch-target=""
                data-testid={`${testId}-confirm`}
                className={`${buttonDanger} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {pending ? t("pending") : t("confirm")}
              </button>
            </SheetFooterAction>
          </form>
        )}
      </SheetDialog>
    </>
  );
}

export function AgentActions({
  org,
  ws,
  agentId,
  name,
  slug,
  suspended,
  here,
  list,
}: Target & {
  /** The definition file's name, which Deregister's pull-request line names. */
  slug: string;
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
        slug={slug}
        after={list}
      />
    </>
  );
}
