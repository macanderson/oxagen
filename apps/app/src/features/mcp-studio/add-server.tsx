"use client";
// Add server's Studio sources (#4678, items 1 to 3), which the Tools page's
// Add a provider dialog renders through Studio's client entry (client.ts).
//
//   - From a definition saves the uploaded OpenAPI, GraphQL or gRPC
//     definition with the server.toml Studio writes (new-server.ts), at
//     revision 0, then opens Review in the same dialog. Review opens the
//     steering PR that creates tools/servers/<server>/ (ADR-224). When Review
//     refuses after the save, the dialog names the refusal, keeps the folder
//     name, and a retry saves again at the revision the save returned. It
//     never starts over at revision 0.
//   - Local command and a registry entry's package form live in
//     machine-fields.tsx: a machine lists the new server's tools before
//     Review (ADR-233, #4756).
//   - A registry entry shows whether it offers a remote, a package or both.
//   - Discovery progress follows the server's discovery until it finishes,
//     through get_studio_discovery and start_studio_discovery (lane M10,
//     #4682, bound in studio-calls.ts).
//
// Every value is read off the form at submit. The dialog holds only the
// uploaded files' names, which the root document picker lists. No credential
// passes through any of these forms.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import type { RegistryServer } from "@/data/contracts/tools";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import {
  DEFINITION_SCHEDULES,
  DEFINITION_TYPES,
  type DefinitionFile,
  type DefinitionProblem,
  type DefinitionType,
  definitionSchedule,
  definitionType,
  newDefinitionServer,
} from "./new-server";
import {
  getStudioDiscovery,
  registryOffer,
  type StudioDiscovery,
  startStudioDiscovery,
} from "./studio-calls";
import {
  type CreateStudioServer,
  type NewStudioServer,
  newServerCalls,
  type SavedStudioServer,
} from "./review-calls";
import { isReviewCode } from "./review-codes";
import type { StudioAt } from "./route";
import type { OpenStudioReview, StudioReview } from "./seams";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A label, a control and an optional hint the control names. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A field's value off the form at submit, or "" when the form has none. */
export function textOf(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement ||
    field instanceof HTMLSelectElement
    ? field.value
    : "";
}

/** The uploaded files, each read as UTF-8 text, or null when it is not. */
async function readFiles(form: HTMLFormElement): Promise<DefinitionFile[]> {
  const input = form.elements.namedItem("files");
  const files =
    input instanceof HTMLInputElement ? Array.from(input.files ?? []) : [];
  return Promise.all(
    files.map(async (file): Promise<DefinitionFile> => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { name: file.name, text: UTF8.decode(bytes) };
      } catch {
        return { name: file.name, text: null };
      }
    }),
  );
}

const FILE_TYPES: Readonly<Record<DefinitionType, string>> = {
  openapi: ".json,.yaml,.yml",
  graphql: ".graphql,.graphqls,.gql",
  grpc: ".proto",
};

/** How the last submit went, shown under the form. */
type DefinitionOutcome =
  | { kind: "problems"; problems: readonly DefinitionProblem[] }
  /** The first save found a draft of that name, or a retry found it saved again. */
  | { kind: "exists" | "moved"; name: string }
  | { kind: "opened"; review: StudioReview; server: string }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null };

type Phase = "idle" | "saving" | "reviewing";

/** The draft a refused Review left stored, which a retry saves over. */
type Stored = { server: string; draft: SavedStudioServer };

/**
 * From a definition: the form, then Save and Review in one submit, then the
 * steering PR and discovery progress. `calls` defaults to the server actions.
 */
export function DefinitionFields({
  at,
  calls: injected,
}: {
  at: StudioAt;
  calls?: { create: CreateStudioServer; review: OpenStudioReview };
}) {
  const t = useTranslations("mcpStudio.addServer.definition");
  const tFields = useTranslations("mcpStudio.addServer.fields");
  const tProblem = useTranslations(
    "mcpStudio.addServer.definition.problems",
  );
  const tPr = useTranslations("mcpStudio.changes.pr");
  const id = useId();
  const calls = useMemo(
    () => injected ?? newServerCalls(at),
    [injected, at],
  );
  const [type, setType] = useState<DefinitionType>("openapi");
  const [names, setNames] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stored, setStored] = useState<Stored | null>(null);
  const [outcome, setOutcome] = useState<DefinitionOutcome | null>(null);

  const problemText = (problem: DefinitionProblem): string => {
    switch (problem.kind) {
      case "empty":
      case "duplicate":
      case "unreadable":
        return tProblem(problem.kind, { file: problem.file });
      default:
        return tProblem(problem.kind);
    }
  };

  const failureText = (code: string | null): string => {
    if (code === null) return tPr("thrown");
    // This page's limit, which the Changes tab's too_large does not name.
    if (code === "too_large") return t("tooLarge");
    if (code === "server_toml_invalid") return t("tomlInvalid");
    if (code === "source_invalid") return t("sourceInvalid");
    return isReviewCode(code) ? tPr(`codes.${code}`) : tPr("failed", { code });
  };

  const run = async (form: HTMLFormElement): Promise<DefinitionOutcome> => {
    const built = newDefinitionServer({
      // A stored draft keeps its folder name, so the retry saves over it.
      name: stored === null ? textOf(form, "name") : stored.server,
      label: textOf(form, "label"),
      description: textOf(form, "description"),
      url: textOf(form, "url"),
      type,
      schedule: definitionSchedule(textOf(form, "schedule")),
      files: await readFiles(form),
      entry: textOf(form, "entry"),
    });
    if (!built.ok) return { kind: "problems", problems: built.problems };
    const draft: NewStudioServer = built.server;
    const saved = await calls.create(
      draft,
      stored === null ? null : stored.draft,
    );
    if (!saved.ok) {
      return saved.reason === "failed"
        ? { kind: "failed", code: saved.code }
        : { kind: saved.reason, name: draft.server };
    }
    setStored({
      server: draft.server,
      draft: { serverId: saved.serverId, revision: saved.revision },
    });
    setPhase("reviewing");
    const opened = await calls.review({
      server: draft.server,
      revision: saved.revision,
    });
    if (opened.ok) {
      return { kind: "opened", review: opened.review, server: draft.server };
    }
    // Someone saved the draft between this save and Review.
    return opened.reason === "conflict"
      ? { kind: "moved", name: draft.server }
      : { kind: "failed", code: opened.code };
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phase !== "idle") return;
    const form = event.currentTarget;
    setPhase("saving");
    setOutcome(null);
    try {
      setOutcome(await run(form));
    } catch {
      setOutcome({ kind: "failed", code: null });
    } finally {
      setPhase("idle");
    }
  };

  if (outcome?.kind === "opened") {
    const url = parsePullRequestUrl(outcome.review.url);
    // A PR number is an identifier, not a quantity: #4678, never #4,678.
    const label = t("opened", { number: String(outcome.review.number) });
    return (
      <div
        className="flex flex-col gap-3"
        data-testid="studio-add-definition-opened"
      >
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
        <DiscoveryProgress
          at={at}
          server={outcome.server}
          canStart={false}
        />
      </div>
    );
  }

  const busy = phase !== "idle";
  const submitLabel =
    phase === "saving"
      ? t("saving")
      : phase === "reviewing"
        ? t("reviewing")
        : stored === null
          ? t("submit")
          : t("retry");

  return (
    <form
      data-testid="studio-add-definition"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3"
      noValidate
    >
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <Field id={`${id}-name`} label={tFields("name")} hint={tFields("nameHint")}>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={24}
          readOnly={stored !== null}
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
          className={inputBase}
        />
      </Field>
      <Field id={`${id}-description`} label={tFields("description")}>
        <input
          id={`${id}-description`}
          name="description"
          required
          maxLength={200}
          className={inputBase}
        />
      </Field>
      <Field id={`${id}-url`} label={t("url")} hint={t("urlHint")}>
        <input
          id={`${id}-url`}
          name="url"
          type="url"
          required
          autoComplete="off"
          aria-describedby={`${id}-url-hint`}
          className={`${inputBase} ${mono}`}
        />
      </Field>
      <Field id={`${id}-type`} label={t("type")}>
        <select
          id={`${id}-type`}
          name="type"
          value={type}
          onChange={(event) => {
            setType(definitionType(event.currentTarget.value));
          }}
          className={inputBase}
        >
          {DEFINITION_TYPES.map((option) => (
            <option key={option} value={option}>
              {t(`types.${option}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id={`${id}-files`}
        label={t("files")}
        hint={t(`filesHint.${type}`)}
      >
        <input
          id={`${id}-files`}
          name="files"
          type="file"
          multiple={type !== "graphql"}
          accept={FILE_TYPES[type]}
          aria-describedby={`${id}-files-hint`}
          onChange={(event) => {
            setNames(
              Array.from(event.currentTarget.files ?? []).map(
                (file) => file.name,
              ),
            );
          }}
          className="min-w-44 flex-1 text-xs text-muted-foreground"
        />
      </Field>
      {type === "openapi" && names.length > 0 ? (
        <Field id={`${id}-entry`} label={t("entry")}>
          <select
            id={`${id}-entry`}
            name="entry"
            defaultValue={names[0]}
            className={`${inputBase} ${mono}`}
          >
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field id={`${id}-schedule`} label={t("schedule")}>
        <select
          id={`${id}-schedule`}
          name="schedule"
          defaultValue="manual"
          className={inputBase}
        >
          {DEFINITION_SCHEDULES.map((option) => (
            <option key={option} value={option}>
              {t(`schedules.${option}`)}
            </option>
          ))}
        </select>
      </Field>
      {outcome === null ? null : outcome.kind === "problems" ? (
        <FormAlert testId="studio-add-definition-problems">
          <ul className="flex flex-col gap-1">
            {outcome.problems.map((problem) => (
              <li
                key={`${problem.kind}:${"file" in problem ? problem.file : ""}`}
              >
                {problemText(problem)}
              </li>
            ))}
          </ul>
        </FormAlert>
      ) : outcome.kind === "failed" ? (
        <FormAlert testId="studio-add-definition-failed">
          {failureText(outcome.code)}
        </FormAlert>
      ) : (
        <FormAlert testId={`studio-add-definition-${outcome.kind}`}>
          {t(outcome.kind, { name: outcome.name })}
        </FormAlert>
      )}
      <button
        type="submit"
        data-testid="studio-add-definition-submit"
        data-retry={stored === null ? undefined : "true"}
        aria-disabled={busy || undefined}
        className={`${buttonPrimary} self-start`}
      >
        {submitLabel}
      </button>
    </form>
  );
}

/** Whether a registry entry offers a remote, a package, or both. */
export function RegistryOfferChip({ server }: { server: RegistryServer }) {
  const t = useTranslations("mcpStudio.addServer.offer");
  const offer = registryOffer(server);
  if (offer === "none") return null;
  return (
    <span
      data-offer={offer}
      className="rounded border border-border px-1.5 py-0.5 text-sm text-foreground"
    >
      {t(offer)}
    </span>
  );
}

const STATUS_TONE: Readonly<Record<StudioDiscovery["status"], BadgeTone>> = {
  queued: "quiet",
  running: "approval",
  waiting_for_machine: "quiet",
  succeeded: "allowed",
  failed: "failed",
};

/** What the section last read. */
type DiscoveryView =
  | { kind: "loading" }
  | { kind: "read"; discovery: StudioDiscovery | null }
  /** A refusal's code, or null when the call threw before Oxagen answered. */
  | { kind: "failed"; code: string | null };

function pending(discovery: StudioDiscovery | null): boolean {
  return (
    discovery !== null &&
    (discovery.status === "queued" || discovery.status === "running")
  );
}

/**
 * One server's discovery: its status, what it found and the sync steering PR
 * it opened, read again every `pollMs` while it is queued or running. A
 * person who may edit the server can start one. `server` is null when the
 * dialog added a provider with no folder yet. The error text a failed
 * discovery carries is the handler's, so the section never shows it.
 */
export function DiscoveryProgress({
  at,
  server,
  canStart,
  start = startStudioDiscovery,
  get = getStudioDiscovery,
  pollMs = 5000,
}: {
  /** The workspace the server belongs to. */
  at: StudioAt;
  server: string | null;
  canStart: boolean;
  start?: typeof startStudioDiscovery;
  get?: typeof getStudioDiscovery;
  pollMs?: number;
}) {
  const t = useTranslations("mcpStudio.addServer.discovery");
  const id = useId();
  const [view, setView] = useState<DiscoveryView>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  // Bumped after a start, so the read runs again and follows the new run.
  const [round, setRound] = useState(0);
  // The poll depends on the workspace's slugs, not on the object that carries
  // them, so a parent that builds a new object does not restart it.
  const { org, ws } = at;

  useEffect(() => {
    if (server === null) return;
    const name = server;
    const where: StudioAt = { org, ws };
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      get
        .call(where, { server: name })
        .then((answer) => {
          if (!live) return;
          if (!answer.ok) {
            setView({ kind: "failed", code: answer.code });
            return;
          }
          setView({ kind: "read", discovery: answer.discovery });
          if (pending(answer.discovery)) timer = setTimeout(read, pollMs);
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

  const run = async () => {
    if (server === null || starting) return;
    setStarting(true);
    try {
      const answer = await start.call({ org, ws }, { server });
      if (answer.ok) {
        setView({ kind: "read", discovery: answer.discovery });
        setRound((n) => n + 1);
      } else {
        setView({ kind: "failed", code: answer.code });
      }
    } catch {
      setView({ kind: "failed", code: null });
    } finally {
      setStarting(false);
    }
  };

  const startButton =
    canStart && server !== null ? (
      <button
        type="button"
        data-testid="studio-discovery-start"
        data-capability={start.name}
        aria-disabled={starting || undefined}
        className={`${buttonSecondary} self-start`}
        onClick={() => void run()}
      >
        {starting ? t("starting") : t("start")}
      </button>
    ) : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="studio-discovery"
      data-status={view.kind === "read" ? view.discovery?.status : undefined}
      className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5"
    >
      <p id={`${id}-title`} className="text-sm font-medium text-foreground">
        {t("title")}
      </p>
      {server === null ? (
        <p
          data-testid="studio-discovery-unnamed"
          className="text-sm text-muted-foreground"
        >
          {t("unnamed")}
        </p>
      ) : view.kind === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : view.kind === "failed" ? (
        <FormAlert testId="studio-discovery-failed">
          {view.code === null ? t("thrown") : t("failed", { code: view.code })}
        </FormAlert>
      ) : view.discovery === null ? (
        <p
          data-testid="studio-discovery-none"
          className="text-sm text-muted-foreground"
        >
          {t("none")}
        </p>
      ) : (
        <DiscoveryState discovery={view.discovery} />
      )}
      {startButton}
    </section>
  );
}

function DiscoveryState({ discovery }: { discovery: StudioDiscovery }) {
  const t = useTranslations("mcpStudio.addServer.discovery");
  const url =
    discovery.pr === null ? null : parsePullRequestUrl(discovery.pr.url);
  const prLabel =
    discovery.pr === null
      ? null
      : t("pr", { number: String(discovery.pr.number) });
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p role="status" className="flex flex-wrap items-center gap-2">
        <Badge
          tone={STATUS_TONE[discovery.status]}
          dot={discovery.status === "running" ? "pulse" : true}
          data-testid="studio-discovery-status"
        >
          {t(`statuses.${discovery.status}`)}
        </Badge>
        {discovery.toolCount === null ? null : (
          <span data-testid="studio-discovery-tools">
            {t("toolCount", { count: discovery.toolCount })}
          </span>
        )}
      </p>
      {discovery.stalled ? (
        <p data-testid="studio-discovery-stalled">{t("stalled")}</p>
      ) : null}
      {discovery.outcome === null ? null : (
        <p data-testid="studio-discovery-outcome">
          {t(`outcomes.${discovery.outcome}`)}
        </p>
      )}
      {prLabel === null ? null : (
        <p data-testid="studio-discovery-pr">
          {url === null ? (
            prLabel
          ) : (
            <PullRequestLink
              to={url}
              className="text-app-link-fg underline-offset-2 hover:underline"
            >
              {prLabel}
            </PullRequestLink>
          )}
        </p>
      )}
    </div>
  );
}
