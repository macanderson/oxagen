"use client";
// The answer to a run's repository question (#3941, spec
// pages/run-interjection.md, the agent's pane): two pick cards, Send this
// answer, and the receipt once `answer_interjection` recorded it.
//
// Each card says what its path does, from the body the host sealed when it
// raised the question. A fact the host did not count (the link workspace's
// skills version, its pinned skills, its other repositories) is left out
// rather than guessed. The create path always ships skills off, which the
// body states and the contract holds.
//
// Send stays disabled until it can do something, and the line beside it says
// why: the viewer's role, the closed window, no pick yet, or an unnamed
// workspace. Only an organization Owner or Admin, or the workspace Owner, can
// answer with a path, so anyone else sees the question and the reason.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { InterjectionItem } from "@/data/contracts/interjections";
import {
  buttonPrimary,
  fieldHint,
  fieldLabel,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { type AnsweredInterjection, answerInterjection } from "./actions";
import { UNANSWERED, useAnswerFailure } from "./interjection-failure";

type Body = NonNullable<InterjectionItem["body"]>;
type Path = "link" | "create";
/** What a path does to the repository and the run: gains, loses, or leaves as it was. */
type Mark = "gain" | "loss" | "same";

const GLYPH: Record<Mark, string> = { gain: "+", loss: "−", same: "·" };

type Line = { mark: Mark; text: string };

function Consequences({ id, lines }: { id: string; lines: readonly Line[] }) {
  const t = useTranslations("run.interjection.consequence");
  return (
    <ul id={id} className="flex flex-col gap-1 px-3 pb-2.5 text-xs">
      {lines.map((line) => (
        <li
          key={line.text}
          data-mark={line.mark}
          className="flex items-start gap-2 text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={`${mono} w-3 flex-none text-center font-semibold text-foreground`}
          >
            {GLYPH[line.mark]}
          </span>
          <span>
            <span className="sr-only">{t(line.mark)} </span>
            {line.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PickCard({
  path,
  picked,
  locked,
  title,
  description,
  lines,
  onPick,
}: {
  path: Path;
  picked: boolean;
  /** The viewer cannot answer, so the card only shows what the path does. */
  locked: boolean;
  title: string;
  description: string;
  lines: readonly Line[];
  onPick: () => void;
}) {
  const linesId = useId();
  // The consequence list sits beside the button, not inside it: a list is
  // not phrasing content. The button points at it, so a screen reader reads
  // the consequences with the card.
  return (
    <div
      className={`flex flex-col rounded-lg border ${picked ? "border-gold bg-gold/10" : "border-border bg-app-panel-bg"}`}
    >
      <button
        type="button"
        aria-pressed={picked}
        aria-describedby={linesId}
        disabled={locked || undefined}
        data-testid={`interjection-pick-${path}`}
        data-touch-target=""
        onClick={onPick}
        className="flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-foreground enabled:hover:bg-gold/5 disabled:cursor-not-allowed"
      >
        <span
          aria-hidden="true"
          className={`mt-0.5 flex size-4 flex-none items-center justify-center rounded border text-[10px] leading-none ${picked ? "border-gold bg-gold text-button-primary-fg" : "border-border"}`}
        >
          {picked ? "✓" : null}
        </span>
        <span className="flex flex-col gap-0.5">
          {title}
          <span className="text-xs font-normal text-muted-foreground">
            {description}
          </span>
        </span>
      </button>
      <Consequences id={linesId} lines={lines} />
    </div>
  );
}

export function InterjectionAnswer({
  org,
  ws,
  interjectionId,
  body,
  repository,
  canAnswer,
  closedAt,
}: {
  org: string;
  ws: string;
  interjectionId: string;
  /** The body the host sealed with the question: its two paths. */
  body: Body;
  /** `owner/name` the control plane matched to the run's remote; null when unresolved. */
  repository: string | null;
  /** The viewer's roles admit a path answer. */
  canAnswer: boolean;
  /** The instant the window closed, as the page prints it; null while it is open. */
  closedAt: string | null;
}) {
  const t = useTranslations("run.interjection");
  const failureText = useAnswerFailure();
  const navigate = useNavigate();
  const hintId = useId();
  const nameId = useId();
  const slugId = useId();
  const slugHelpId = useId();
  const [link, create] = body.paths;
  const [picked, setPicked] = useState<Path | null>(null);
  const [name, setName] = useState(create.proposedName ?? "");
  const [slug, setSlug] = useState(create.proposedSlug ?? "");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [answered, setAnswered] = useState<AnsweredInterjection | null>(null);
  const target = link.workspaceSlug;

  const linkLines: Line[] = [
    ...(link.configVersion === null
      ? []
      : [
          {
            mark: "gain" as const,
            text: t("consequence.linkVersion", {
              version: link.configVersion,
            }),
          },
        ]),
    ...(link.skillsPinned === null
      ? []
      : [
          {
            mark: "gain" as const,
            text: t("consequence.linkPinned", {
              ws: target,
              count: link.skillsPinned,
            }),
          },
        ]),
    ...(link.linkedRepositories === null
      ? []
      : [
          {
            mark: "same" as const,
            text: t("consequence.linkRepositories", {
              ws: target,
              count: link.linkedRepositories,
            }),
          },
        ]),
    { mark: "loss", text: t("consequence.linkSpend", { ws: target }) },
  ];
  const createLines: Line[] = [
    { mark: "loss", text: t("consequence.createSkillsOff") },
    { mark: "gain", text: t("consequence.createOwn") },
    { mark: "same", text: t("consequence.createContinues") },
  ];

  const locked = !canAnswer || closedAt !== null;
  const unnamed =
    picked === "create" && (name.trim() === "" || slug.trim() === "");
  // Why Send is disabled, in the order a viewer can act on it; null when it
  // can send.
  const blocked = !canAnswer
    ? t("roleReason")
    : closedAt !== null
      ? t("closedReason", { at: closedAt })
      : picked === null
        ? t("pickOne")
        : unnamed
          ? t("nameFirst")
          : null;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || blocked !== null || picked === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await answerInterjection(
        org,
        ws,
        interjectionId,
        picked === "link" ? { path: "link" } : { path: "create", name, slug },
      );
      if (result.ok) {
        setAnswered(result.value);
        // The page re-reads the question, which now carries the answer.
        navigate.refresh();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (answered !== null) {
    const bound = answered.repository?.fullName ?? repository;
    const detail =
      answered.path === "create" && answered.workspace !== null
        ? t("receipt.created", { slug: answered.workspace.slug })
        : answered.path === "link" && bound !== null
          ? t("receipt.linked", { repository: bound, ws: target })
          : null;
    return (
      <div
        role="status"
        data-testid="interjection-receipt"
        className="flex flex-col gap-1 rounded-lg border border-border bg-app-panel-bg px-3 py-2.5 text-sm"
      >
        <p>{t("receipt.sent", { receipt: answered.receiptId })}</p>
        {detail === null ? null : (
          <p className="text-muted-foreground">{detail}</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t("pick.legend")}</legend>
        <PickCard
          path="link"
          picked={picked === "link"}
          locked={locked}
          title={t("pick.link", { ws: target })}
          description={t("pick.linkDescription", { ws: target })}
          lines={linkLines}
          onPick={() => {
            setPicked("link");
            setFailure(null);
          }}
        />
        <PickCard
          path="create"
          picked={picked === "create"}
          locked={locked}
          title={t("pick.create")}
          description={
            create.proposedName === null
              ? t("pick.createDescriptionUnnamed")
              : t("pick.createDescription", { name: create.proposedName })
          }
          lines={createLines}
          onPick={() => {
            setPicked("create");
            setFailure(null);
          }}
        />
      </fieldset>
      {picked === "create" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={nameId} className={fieldLabel}>
              {t("pick.name")}
            </label>
            <input
              id={nameId}
              name="name"
              data-testid="interjection-create-name"
              value={name}
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className={inputBase}
            />
          </div>
          <div>
            <label htmlFor={slugId} className={fieldLabel}>
              {t("pick.slug")}
            </label>
            <input
              id={slugId}
              name="slug"
              data-testid="interjection-create-slug"
              value={slug}
              maxLength={40}
              aria-describedby={slugHelpId}
              onChange={(event) => {
                setSlug(event.target.value);
              }}
              className={`${inputBase} font-mono`}
            />
            <p id={slugHelpId} className={fieldHint}>
              {t("pick.slugHelp")}
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          data-testid="interjection-send"
          data-touch-target=""
          disabled={blocked !== null || undefined}
          aria-disabled={pending || undefined}
          aria-describedby={hintId}
          title={canAnswer ? undefined : t("roleReason")}
          className={buttonPrimary}
        >
          {pending ? t("sending") : t("send")}
        </button>
        <span
          id={hintId}
          data-testid="interjection-send-hint"
          className={`${mono} text-[11px] text-muted-foreground`}
        >
          {blocked ?? t("answersAs")}
        </span>
      </div>
      {failure === null ? null : (
        <FormAlert testId="interjection-failure">{failure}</FormAlert>
      )}
    </form>
  );
}
