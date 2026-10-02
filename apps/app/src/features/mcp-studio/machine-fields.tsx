"use client";
// Add server's Local command and registry package forms (#4678, items 2 and
// 3; ADR-233, #4756), which the Tools page's Add a provider dialog renders
// through client.ts. Both add a server that runs on machines, and both run
// the same four steps in the dialog:
//
//   1. Save. The form's server.toml (machine-server.ts) is saved as the new
//      server's draft at revision 0.
//   2. List. start_studio_listing asks a machine in source.machines to start
//      the pinned server and list its tools. The dialog reads
//      get_studio_listing until the listing finishes.
//   3. Classify. The dialog lists the tools the machine listed, each with the
//      classification Studio suggests. The person picks the tools to import
//      and confirms or changes each classification.
//   4. Review. The dialog saves the imports and classifications as the
//      draft's edits, at the revision the listing left, then opens Review.
//      Review opens the steering PR that creates tools/servers/<server>/,
//      with a tools.lock.json that pins what the machine checked.
//
// A listing that fails leaves the saved draft as it was. Submitting the form
// again saves over that draft at the revision the first save returned, then
// lists again. It never starts over at revision 0.
//
// The draft and its listing outlive the dialog. When a submit finds the
// folder's draft already saved, the dialog reads its listing and resumes it:
// the listing while a machine has yet to answer, the classify step once it
// has, or the form, ready to save over a draft with no tools listed. It never
// saves over a draft that holds a definition.
//
// A listing runs only on a machine the person who asked enrolled (ADR-233).
//
// No credential passes through either form. A registry package's secret
// argument takes its value from a variable set on each machine.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type RegistryServer,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import { DiscoveryProgress, Field, textOf } from "./add-server";
import type { DraftOp } from "./draft";
import {
  argumentKey,
  type MachineProblem,
  type MachineServer,
  newLocalServer,
  newPackageServer,
  PINNED_PACKAGE_TYPES,
  type PinnedPackageType,
  secretVariable,
  suggestedServerName,
} from "./machine-server";
import {
  type CreateStudioServer,
  newServerCalls,
  reviewCalls,
  type SavedStudioServer,
} from "./review-calls";
import { isReviewCode } from "./review-codes";
import type { StudioAt } from "./route";
import type {
  GetStudioDraft,
  OpenStudioReview,
  SaveStudioDraft,
  StudioReview,
} from "./seams";
import {
  type GetStudioListing,
  getStudioListing,
  type RegistryPackage,
  registryPackagesOf,
  type StartStudioListing,
  type StudioListedTool,
  type StudioListing,
  startStudioListing,
} from "./studio-calls";

/** Every call the two forms make. A test passes fakes. */
type MachineServerCalls = {
  create: CreateStudioServer;
  start: StartStudioListing;
  get: GetStudioListing;
  read: GetStudioDraft;
  save: SaveStudioDraft;
  review: OpenStudioReview;
};

function defaultCalls(at: StudioAt): MachineServerCalls {
  const review = reviewCalls(at);
  return {
    create: newServerCalls(at).create,
    start: startStudioListing,
    get: getStudioListing,
    read: review.get,
    save: review.save,
    review: review.open,
  };
}

/** How the last submit of the form went, shown under the form. */
type FormOutcome =
  | { kind: "problems"; problems: readonly MachineProblem[] }
  /** The first save found a draft of that name, or a retry found it saved again. */
  | { kind: "exists" | "moved"; name: string }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null }
  /** The machine did not list the tools, or the draft no longer holds them. */
  | { kind: "unlisted" }
  /** A draft of that name is saved with no tools listed; the next submit saves over it. */
  | { kind: "resumable"; name: string };

/** Where the dialog is. */
type Stage =
  | { kind: "form" }
  | { kind: "listing"; server: string }
  | { kind: "classify"; server: string; tools: readonly StudioListedTool[] }
  | { kind: "opened"; server: string; review: StudioReview };

/** The draft a save stored, which a second submit saves over. */
type Stored = { server: string; saved: SavedStudioServer };

/**
 * The four steps, shared by both forms. `fields` renders the form's own
 * fields. `build` reads them off the form at submit.
 */
function MachineServerFlow({
  at,
  calls,
  testId,
  intro,
  fields,
  build,
  pollMs,
}: {
  at: StudioAt;
  calls: MachineServerCalls;
  testId: string;
  intro: string;
  fields: (stored: Stored | null) => ReactNode;
  build: (form: HTMLFormElement, stored: Stored | null) =>
    | { ok: true; value: MachineServer }
    | { ok: false; problems: readonly MachineProblem[] };
  pollMs: number;
}) {
  const t = useTranslations("mcpStudio.addServer.machine");
  const tProblem = useTranslations("mcpStudio.addServer.machine.problems");
  const tPr = useTranslations("mcpStudio.changes.pr");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [stored, setStored] = useState<Stored | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<FormOutcome | null>(null);

  const problemText = (problem: MachineProblem): string => {
    switch (problem.kind) {
      case "machine":
        return tProblem("machine", { group: problem.group });
      case "variable":
        return tProblem("variable", { name: problem.name });
      case "argumentRequired":
      case "argumentInvalid":
        return tProblem(problem.kind, { argument: problem.argument });
      default:
        return tProblem(problem.kind);
    }
  };

  const failureText = (code: string | null): string => {
    if (code === null) return tPr("thrown");
    if (code === "needs_digest") return t("needsDigest");
    if (code === "registry_unreachable") return t("registryUnreachable");
    if (code === "machines_required") return tProblem("machines");
    if (code === "machine_not_yours") return t("notYours");
    if (code === "server_toml_invalid") return t("tomlInvalid");
    return isReviewCode(code) ? tPr(`codes.${code}`) : tPr("failed", { code });
  };

  /**
   * Pick up the saved draft of `name` where it stands: poll its listing,
   * classify what it listed, or hold its revision for the next submit.
   */
  const resume = async (name: string): Promise<FormOutcome | null> => {
    const [listed, read] = await Promise.all([
      calls.get.call(at, { server: name }),
      calls.read({ server: name }),
    ]);
    if (!read.ok) return { kind: "failed", code: read.code };
    const draft = read.draft;
    // A draft that holds a definition is someone's upload. Never save over it.
    if (draft === null || (draft.source !== null && draft.source.type !== "mcp")) {
      return { kind: "exists", name };
    }
    setStored({
      server: name,
      saved: { serverId: draft.serverId, revision: draft.revision },
    });
    const listing = listed.ok ? listed.listing : null;
    if (
      listing !== null &&
      (listing.status === "waiting_for_machine" || listing.status === "running")
    ) {
      setStage({ kind: "listing", server: name });
      return null;
    }
    if (listing?.status === "succeeded" && listing.tools !== null) {
      setStage({ kind: "classify", server: name, tools: listing.tools });
      return null;
    }
    return { kind: "resumable", name };
  };

  const run = async (form: HTMLFormElement): Promise<FormOutcome | null> => {
    const built = build(form, stored);
    if (!built.ok) return { kind: "problems", problems: built.problems };
    const { server, pin } = built.value;
    const saved = await calls.create(server, stored?.saved ?? null);
    if (!saved.ok) {
      if (saved.reason === "exists") return resume(server.server);
      return saved.reason === "failed"
        ? { kind: "failed", code: saved.code }
        : { kind: saved.reason, name: server.server };
    }
    const draft = { serverId: saved.serverId, revision: saved.revision };
    setStored({ server: server.server, saved: draft });
    const started = await calls.start.call(at, {
      server: server.server,
      revision: saved.revision,
      ...(pin === undefined ? {} : { pin }),
    });
    if (!started.ok) return { kind: "failed", code: started.code };
    setStage({ kind: "listing", server: server.server });
    return null;
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await run(form));
    } catch {
      setOutcome({ kind: "failed", code: null });
    } finally {
      setBusy(false);
    }
  };

  if (stage.kind === "classify") {
    return (
      <ClassifyTools
        server={stage.server}
        serverId={stored?.saved.serverId ?? null}
        tools={stage.tools}
        calls={calls}
        onOpened={(review) => {
          setStage({ kind: "opened", server: stage.server, review });
        }}
      />
    );
  }

  if (stage.kind === "opened") {
    const url = parsePullRequestUrl(stage.review.url);
    // A PR number is an identifier, not a quantity: #4678, never #4,678.
    const label = t("opened", { number: String(stage.review.number) });
    return (
      <div className="flex flex-col gap-3" data-testid={`${testId}-opened`}>
        <p role="status" className="text-sm">
          {url === null ? (
            label
          ) : (
            <PullRequestLink
              to={url}
              className="text-app-link-fg underline-offset-2 hover:underline"
            >
              {label}
            </PullRequestLink>
          )}
        </p>
        <DiscoveryProgress at={at} server={stage.server} canStart={false} />
      </div>
    );
  }

  const listing = stage.kind === "listing" ? stage.server : null;
  // The form stays mounted while a machine lists the tools, so a listing
  // that fails returns to the fields as the person left them.
  return (
    <div className="flex flex-col gap-3">
      <form
        data-testid={testId}
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3"
        noValidate
      >
        <p className="text-sm text-muted-foreground">{intro}</p>
        <fieldset
          disabled={listing !== null}
          className="flex min-w-0 flex-col gap-3"
        >
          {fields(stored)}
        </fieldset>
        {outcome === null ? null : outcome.kind === "problems" ? (
          <FormAlert testId={`${testId}-problems`}>
            <ul className="flex flex-col gap-1">
              {outcome.problems.map((problem) => (
                <li key={`${problem.kind}:${JSON.stringify(problem)}`}>
                  {problemText(problem)}
                </li>
              ))}
            </ul>
          </FormAlert>
        ) : outcome.kind === "failed" ? (
          <FormAlert testId={`${testId}-failed`}>
            {failureText(outcome.code)}
          </FormAlert>
        ) : outcome.kind === "unlisted" ? (
          <FormAlert testId={`${testId}-unlisted`}>{t("unlisted")}</FormAlert>
        ) : outcome.kind === "resumable" ? (
          <FormAlert testId={`${testId}-resumable`}>
            {t("resumable", { name: outcome.name })}
          </FormAlert>
        ) : (
          <FormAlert testId={`${testId}-${outcome.kind}`}>
            {t(outcome.kind, { name: outcome.name })}
          </FormAlert>
        )}
        {listing === null ? (
          <button
            type="submit"
            data-testid={`${testId}-submit`}
            data-capability={startStudioListing.name}
            data-retry={stored === null ? undefined : "true"}
            aria-disabled={busy || undefined}
            className={`${buttonPrimary} self-start`}
          >
            {busy ? t("saving") : stored === null ? t("submit") : t("retry")}
          </button>
        ) : null}
      </form>
      {listing === null ? null : (
        <ListingProgress
          at={at}
          server={listing}
          get={calls.get}
          pollMs={pollMs}
          onDone={(done) => {
            if (done.status === "succeeded" && done.tools !== null) {
              setStage({ kind: "classify", server: listing, tools: done.tools });
            } else {
              setOutcome({ kind: "unlisted" });
              setStage({ kind: "form" });
            }
          }}
        />
      )}
    </div>
  );
}

const LISTING_TONE: Readonly<Record<StudioListing["status"], BadgeTone>> = {
  waiting_for_machine: "quiet",
  running: "approval",
  succeeded: "allowed",
  failed: "failed",
};

/** What the progress section last read. */
type ListingView =
  | { kind: "loading" }
  | { kind: "read"; listing: StudioListing | null }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null };

/**
 * One draft's listing, read again every `pollMs` while it waits for a machine
 * or runs. `onDone` fires once, with the listing that finished. The error
 * text a failed listing carries is the handler's, so the section never shows
 * it: the form names what to check.
 */
function ListingProgress({
  at,
  server,
  get = getStudioListing,
  pollMs = 5000,
  onDone,
}: {
  at: StudioAt;
  server: string;
  get?: GetStudioListing;
  pollMs?: number;
  onDone: (listing: StudioListing) => void;
}) {
  const t = useTranslations("mcpStudio.addServer.listing");
  const id = useId();
  const [view, setView] = useState<ListingView>({ kind: "loading" });
  // Bumped by Read again, so the read runs once more after a failed read.
  const [round, setRound] = useState(0);
  const { org, ws } = at;
  // The parent rebuilds onDone on every render. The poll reads the latest
  // one through this ref, so a new closure does not restart the poll.
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    const where: StudioAt = { org, ws };
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      get
        .call(where, { server })
        .then((answer) => {
          if (!live) return;
          if (!answer.ok) {
            setView({ kind: "failed", code: answer.code });
            return;
          }
          setView({ kind: "read", listing: answer.listing });
          const listing = answer.listing;
          if (
            listing !== null &&
            (listing.status === "succeeded" || listing.status === "failed")
          ) {
            doneRef.current(listing);
          } else {
            timer = setTimeout(read, pollMs);
          }
        })
        .catch(() => {
          if (live) setView({ kind: "failed", code: null });
        });
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [get, server, pollMs, round, org, ws]);

  const listing = view.kind === "read" ? view.listing : null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="studio-listing"
      data-capability={get.name}
      data-status={listing?.status}
      className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
    >
      <p id={`${id}-title`} className="text-sm font-medium text-foreground">
        {t("title")}
      </p>
      {view.kind === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : view.kind === "failed" ? (
        <>
          <FormAlert testId="studio-listing-failed">
            {view.code === null
              ? t("thrown")
              : t("readFailed", { code: view.code })}
          </FormAlert>
          <button
            type="button"
            data-testid="studio-listing-reread"
            className={`${buttonSecondary} self-start`}
            onClick={() => {
              setView({ kind: "loading" });
              setRound((n) => n + 1);
            }}
          >
            {t("reread")}
          </button>
        </>
      ) : listing === null ? (
        <p
          data-testid="studio-listing-none"
          className="text-sm text-muted-foreground"
        >
          {t("none")}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 text-sm">
          <p role="status" className="flex flex-wrap items-center gap-2">
            <Badge
              tone={LISTING_TONE[listing.status]}
              dot={listing.status === "running" ? "pulse" : true}
              data-testid="studio-listing-status"
            >
              {t(`statuses.${listing.status}`)}
            </Badge>
          </p>
          <p data-testid="studio-listing-pin" className={mono}>
            {t("pin", { name: listing.pin.name, version: listing.pin.version })}
          </p>
          {listing.status === "waiting_for_machine" ? (
            <p data-testid="studio-listing-waiting">
              {t("waiting", { groups: listing.machineGroups.join(" ") })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One tool's row in the classify step. */
type Choice = {
  imported: boolean;
  risk: ToolRiskGrade;
  sideEffect: ToolSideEffect;
  egress: ToolEgress;
};

/**
 * The classify step: the tools the machine listed, each imported by default
 * with the classification Studio suggests in its three selects. Submit saves
 * one import and one classify edit per picked tool, at the revision the
 * listing left, then opens Review. A refused Review keeps the choices, and a
 * second submit reads the draft again and saves over it.
 */
function ClassifyTools({
  server,
  serverId,
  tools,
  calls,
  onOpened,
}: {
  server: string;
  serverId: string | null;
  tools: readonly StudioListedTool[];
  calls: MachineServerCalls;
  onOpened: (review: StudioReview) => void;
}) {
  const t = useTranslations("mcpStudio.addServer.classify");
  const tPanel = useTranslations("mcpStudio.panel");
  const registry = useTranslations("tools.registry");
  const tPr = useTranslations("mcpStudio.changes.pr");
  const id = useId();
  const [choices, setChoices] = useState<readonly Choice[]>(() =>
    tools.map((tool) => ({
      imported: true,
      risk: tool.suggested.risk,
      sideEffect: tool.suggested.sideEffect,
      egress: tool.suggested.egress,
    })),
  );
  const [phase, setPhase] = useState<"idle" | "saving" | "reviewing">("idle");
  const [failure, setFailure] = useState<
    | { kind: "none" }
    | { kind: "moved" }
    | { kind: "failed"; code: string | null }
    | null
  >(null);

  const set = (index: number, change: Partial<Choice>) => {
    setChoices((all) =>
      all.map((choice, at) => (at === index ? { ...choice, ...change } : choice)),
    );
  };

  const ops = useMemo((): DraftOp[] => {
    return tools.flatMap((tool, index): DraftOp[] => {
      const choice = choices[index];
      if (choice === undefined || !choice.imported) return [];
      return [
        { kind: "import", tool: tool.name },
        {
          kind: "classify",
          tool: tool.name,
          risk: choice.risk,
          sideEffect: choice.sideEffect,
          egress: choice.egress,
          impacts: [...tool.suggested.impacts],
        },
      ];
    });
  }, [tools, choices]);

  const run = async (): Promise<typeof failure> => {
    // An empty lock would say the server offers nothing, which is false.
    if (ops.length === 0) return { kind: "none" };
    setPhase("saving");
    const read = await calls.read({ server });
    if (!read.ok) return { kind: "failed", code: read.code };
    if (read.draft === null) return { kind: "failed", code: "draft_not_found" };
    const saved = await calls.save({
      server,
      ...(serverId === null ? {} : { serverId }),
      ops,
      revision: read.draft.revision,
    });
    if (!saved.ok) {
      return saved.reason === "conflict"
        ? { kind: "moved" }
        : { kind: "failed", code: saved.code };
    }
    setPhase("reviewing");
    const opened = await calls.review({
      server,
      revision: saved.draft.revision,
    });
    if (opened.ok) {
      onOpened(opened.review);
      return null;
    }
    return opened.reason === "conflict"
      ? { kind: "moved" }
      : { kind: "failed", code: opened.code };
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phase !== "idle") return;
    setFailure(null);
    try {
      setFailure(await run());
    } catch {
      setFailure({ kind: "failed", code: null });
    } finally {
      setPhase("idle");
    }
  };

  const failureText = (code: string | null): string => {
    if (code === null) return tPr("thrown");
    return isReviewCode(code) ? tPr(`codes.${code}`) : tPr("failed", { code });
  };

  return (
    <form
      data-testid="studio-add-classify"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3"
      noValidate
    >
      <p id={`${id}-title`} className="text-sm font-medium text-foreground">
        {t("title")}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("intro", { count: tools.length })}
      </p>
      <ul aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
        {tools.map((tool, index) => {
          const choice = choices[index];
          if (choice === undefined) return null;
          const rowId = `${id}-tool-${String(index)}`;
          return (
            <li
              key={tool.name}
              data-testid="studio-add-classify-tool"
              data-tool={tool.name}
              className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
            >
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={choice.imported}
                  aria-describedby={
                    tool.description === null ? undefined : `${rowId}-about`
                  }
                  onChange={(event) => {
                    set(index, { imported: event.currentTarget.checked });
                  }}
                  className="mt-0.5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className={`${mono} text-foreground`}>
                    {t("import", { name: tool.name })}
                  </span>
                  {tool.description === null ? null : (
                    <span
                      id={`${rowId}-about`}
                      className="text-xs text-muted-foreground"
                    >
                      {tool.description}
                    </span>
                  )}
                </span>
              </label>
              {choice.imported ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {tPanel("risk")}
                    <select
                      value={choice.risk}
                      onChange={(event) => {
                        const parsed = ToolRiskGrade.safeParse(
                          event.currentTarget.value,
                        );
                        if (parsed.success) set(index, { risk: parsed.data });
                      }}
                      className={inputBase}
                    >
                      {ToolRiskGrade.options.map((value) => (
                        <option key={value} value={value}>
                          {registry(`risk.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {tPanel("sideEffect")}
                    <select
                      value={choice.sideEffect}
                      onChange={(event) => {
                        const parsed = ToolSideEffect.safeParse(
                          event.currentTarget.value,
                        );
                        if (parsed.success) {
                          set(index, { sideEffect: parsed.data });
                        }
                      }}
                      className={inputBase}
                    >
                      {ToolSideEffect.options.map((value) => (
                        <option key={value} value={value}>
                          {registry(`sideEffect.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {tPanel("egress")}
                    <select
                      value={choice.egress}
                      onChange={(event) => {
                        const parsed = ToolEgress.safeParse(
                          event.currentTarget.value,
                        );
                        if (parsed.success) set(index, { egress: parsed.data });
                      }}
                      className={inputBase}
                    >
                      {ToolEgress.options.map((value) => (
                        <option key={value} value={value}>
                          {registry(`egress.${value}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {failure === null ? null : failure.kind === "none" ? (
        <FormAlert testId="studio-add-classify-none">{t("none")}</FormAlert>
      ) : failure.kind === "moved" ? (
        <FormAlert testId="studio-add-classify-moved">
          {t("moved", { name: server })}
        </FormAlert>
      ) : (
        <FormAlert testId="studio-add-classify-failed">
          {failureText(failure.code)}
        </FormAlert>
      )}
      <button
        type="submit"
        data-testid="studio-add-classify-submit"
        aria-disabled={phase !== "idle" || undefined}
        className={`${buttonPrimary} self-start`}
      >
        {phase === "saving"
          ? t("saving")
          : phase === "reviewing"
            ? t("reviewing")
            : t("submit")}
      </button>
    </form>
  );
}

/** Machine groups, one per line: the field both forms carry. */
function MachinesField({ id }: { id: string }) {
  const t = useTranslations("mcpStudio.addServer.local");
  return (
    <Field id={`${id}-machines`} label={t("machines")} hint={t("machinesHint")}>
      <textarea
        id={`${id}-machines`}
        name="machines"
        rows={2}
        aria-describedby={`${id}-machines-hint`}
        className={`${textareaBase} ${mono}`}
      />
    </Field>
  );
}

/** The folder name, display name, and description every server carries. */
function HeadingFields({
  id,
  stored,
  defaults,
}: {
  id: string;
  stored: Stored | null;
  defaults?: { name: string; label: string; description: string };
}) {
  const tFields = useTranslations("mcpStudio.addServer.fields");
  return (
    <>
      <Field id={`${id}-name`} label={tFields("name")} hint={tFields("nameHint")}>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={24}
          // A saved draft keeps its folder name, so a retry saves over it.
          readOnly={stored !== null}
          defaultValue={defaults?.name}
          autoComplete="off"
          aria-describedby={`${id}-name-hint`}
          className={`${inputBase} ${mono}`}
        />
      </Field>
      <Field id={`${id}-label`} label={tFields("label")}>
        <input
          id={`${id}-label`}
          name="label"
          required
          maxLength={80}
          defaultValue={defaults?.label}
          className={inputBase}
        />
      </Field>
      <Field id={`${id}-description`} label={tFields("description")}>
        <input
          id={`${id}-description`}
          name="description"
          required
          maxLength={200}
          defaultValue={defaults?.description}
          className={inputBase}
        />
      </Field>
    </>
  );
}

/** The folder name the form submits: the stored one on a second submit. */
function nameOf(form: HTMLFormElement, stored: Stored | null): string {
  return stored === null ? textOf(form, "name") : stored.server;
}

/**
 * Local command: a program the local gateway starts on enrolled machines,
 * pinned by the version and SHA-256 the person names.
 */
export function LocalCommandFields({
  at,
  calls: injected,
  pollMs = 5000,
}: {
  at: StudioAt;
  calls?: MachineServerCalls;
  pollMs?: number;
}) {
  const t = useTranslations("mcpStudio.addServer.local");
  const id = useId();
  const calls = useMemo(() => injected ?? defaultCalls(at), [injected, at]);
  return (
    <MachineServerFlow
      at={at}
      calls={calls}
      testId="studio-add-local"
      intro={t("intro")}
      pollMs={pollMs}
      build={(form, stored) =>
        newLocalServer({
          name: nameOf(form, stored),
          label: textOf(form, "label"),
          description: textOf(form, "description"),
          command: textOf(form, "command"),
          arguments: textOf(form, "arguments"),
          variables: textOf(form, "variables"),
          machines: textOf(form, "machines"),
          version: textOf(form, "version"),
          digest: textOf(form, "digest"),
        })
      }
      fields={(stored) => (
        <>
          <HeadingFields id={id} stored={stored} />
          <Field id={`${id}-command`} label={t("command")} hint={t("commandHint")}>
            <input
              id={`${id}-command`}
              name="command"
              required
              autoComplete="off"
              aria-describedby={`${id}-command-hint`}
              className={`${inputBase} ${mono}`}
            />
          </Field>
          <Field
            id={`${id}-arguments`}
            label={t("arguments")}
            hint={t("argumentsHint")}
          >
            <textarea
              id={`${id}-arguments`}
              name="arguments"
              rows={3}
              aria-describedby={`${id}-arguments-hint`}
              className={`${textareaBase} ${mono}`}
            />
          </Field>
          <Field
            id={`${id}-variables`}
            label={t("variables")}
            hint={t("variablesHint")}
          >
            <textarea
              id={`${id}-variables`}
              name="variables"
              rows={2}
              aria-describedby={`${id}-variables-hint`}
              className={`${textareaBase} ${mono}`}
            />
          </Field>
          <MachinesField id={id} />
          <Field id={`${id}-version`} label={t("version")} hint={t("versionHint")}>
            <input
              id={`${id}-version`}
              name="version"
              required
              maxLength={64}
              autoComplete="off"
              aria-describedby={`${id}-version-hint`}
              className={`${inputBase} ${mono}`}
            />
          </Field>
          <Field id={`${id}-digest`} label={t("digest")} hint={t("digestHint")}>
            <input
              id={`${id}-digest`}
              name="digest"
              required
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-digest-hint`}
              className={`${inputBase} ${mono}`}
            />
          </Field>
        </>
      )}
    />
  );
}

/**
 * A package the form can pin and a machine can run: npm, PyPI, or NuGet,
 * served over stdio, the one transport the local gateway runs.
 */
function pinnable(pkg: RegistryPackage): pkg is RegistryPackage & {
  registryType: PinnedPackageType;
} {
  return (
    pkg.transport === "stdio" &&
    PINNED_PACKAGE_TYPES.some((type) => type === pkg.registryType)
  );
}

/**
 * The package path of a registry entry: the entry's package runs on enrolled
 * machines, pinned by the SHA-256 Oxagen reads from the public registry. The
 * form asks for the folder, the machine groups, the package type, and the
 * required arguments the registry gives no fixed value.
 */
export function RegistryPackageFields({
  at,
  server,
  packages = registryPackagesOf(server),
  calls: injected,
  pollMs = 5000,
}: {
  at: StudioAt;
  server: RegistryServer;
  /** The entry's packages, as search_mcp_registry lists them. */
  packages?: readonly RegistryPackage[];
  calls?: MachineServerCalls;
  pollMs?: number;
}) {
  const t = useTranslations("mcpStudio.addServer.package");
  const id = useId();
  const calls = useMemo(() => injected ?? defaultCalls(at), [injected, at]);
  const runnable = packages.filter(pinnable);
  const [type, setType] = useState<PinnedPackageType | null>(
    runnable[0]?.registryType ?? null,
  );
  const chosen = runnable.find((pkg) => pkg.registryType === type) ?? null;
  // A fixed value is the registry's to set, so the form asks for the rest.
  const required = (chosen?.packageArguments ?? []).flatMap((argument) => {
    const key = argumentKey(argument);
    return argument.isRequired && argument.value === null && key !== null
      ? [{ argument, key }]
      : [];
  });
  const variables = (chosen?.environmentVariables ?? [])
    .filter((variable) => variable.isRequired)
    .map((variable) => variable.name);

  if (chosen === null || type === null) {
    return (
      <p
        data-testid="studio-add-package-unpinned"
        className="text-sm text-muted-foreground"
      >
        {packages.length === 0
          ? t("noPackage")
          : t("unpinned", {
              types: packages.map((pkg) => pkg.registryType).join(" "),
            })}
      </p>
    );
  }

  return (
    <MachineServerFlow
      at={at}
      calls={calls}
      testId="studio-add-package"
      intro={t("intro")}
      pollMs={pollMs}
      build={(form, stored) =>
        newPackageServer({
          name: nameOf(form, stored),
          label: textOf(form, "label"),
          description: textOf(form, "description"),
          registryRef: server.registryRef,
          entryVersion: server.version,
          registryType: type,
          machines: textOf(form, "machines"),
          arguments: required.map(({ argument, key }) => ({
            key,
            value: argument.isSecret ? "" : textOf(form, `argument:${key}`),
            secret: argument.isSecret,
          })),
          variables,
        })
      }
      fields={(stored) => (
        <>
          <HeadingFields
            id={id}
            stored={stored}
            defaults={{
              name: suggestedServerName(server.registryRef),
              label: server.name.slice(0, 80),
              description: server.description.slice(0, 200),
            }}
          />
          <MachinesField id={id} />
          <Field id={`${id}-type`} label={t("type")}>
            <select
              id={`${id}-type`}
              name="type"
              value={type}
              disabled={stored !== null}
              onChange={(event) => {
                const next = runnable.find(
                  (pkg) => pkg.registryType === event.currentTarget.value,
                );
                if (next !== undefined) setType(next.registryType);
              }}
              className={`${inputBase} ${mono}`}
            >
              {runnable.map((pkg) => (
                <option key={pkg.registryType} value={pkg.registryType}>
                  {pkg.registryType}
                </option>
              ))}
            </select>
          </Field>
          {required.length === 0 ? null : (
            <div
              role="group"
              aria-labelledby={`${id}-arguments`}
              className="flex flex-col gap-2"
              data-testid="studio-add-package-arguments"
            >
              <p
                id={`${id}-arguments`}
                className="text-sm font-medium text-foreground"
              >
                {t("arguments")}
              </p>
              {required.map(({ argument, key }, index) => {
                const fieldId = `${id}-argument-${String(index)}`;
                return argument.isSecret ? (
                  <p
                    key={fieldId}
                    data-testid="studio-add-package-secret"
                    className="text-sm"
                  >
                    <span className={mono}>{key}</span>{" "}
                    <span className="text-muted-foreground">
                      {t("secretFrom", { name: secretVariable(key) })}
                    </span>
                  </p>
                ) : (
                  <Field key={fieldId} id={fieldId} label={key}>
                    <input
                      id={fieldId}
                      name={`argument:${key}`}
                      defaultValue={argument.default ?? ""}
                      className={`${inputBase} ${mono}`}
                    />
                  </Field>
                );
              })}
            </div>
          )}
          {variables.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <p
                id={`${id}-variables`}
                className="text-sm font-medium text-foreground"
              >
                {t("variables")}
              </p>
              <ul
                aria-labelledby={`${id}-variables`}
                className="flex flex-wrap gap-1.5"
              >
                {variables.map((name) => (
                  <li
                    key={name}
                    className={`${mono} rounded border border-border px-1.5 py-0.5 text-sm text-foreground`}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    />
  );
}
