"use client";
// The agent wizard (roadmap creation-spec §1; mockup `wzAgent`;
// mockups/pages/agents.md). Five steps: describe, identity, definition,
// toolbelt, pull request. It ends at `.oxagen/agents/<slug>.toml` and the
// subagent file generated from it, in a pull request against the workspace's
// main repository, because an agent is a definition in a repository before it
// is a principal in a database (MC spec §6.2).
//
// New agent is not Register an agent. Register wraps an agent that already
// runs somewhere and mints its identity; this writes one that does not exist
// yet, and writes no row. The describe step says so.
import { HarnessIcon } from "@/ui/harness-icon";
import { SUBAGENT_FILE_HARNESSES } from "@oxagen/oxagen/contracts/agent.propose";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import type { ActionResult } from "@/server/kernel";
import { agentSourceSlug, renameAgentSource } from "@/shared/source-identity";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import {
  type ProposedAgent,
  proposeAgent,
  readToolbelt,
  type ToolbeltOffer,
} from "./actions";
import {
  AGENT_HARNESSES,
  type AgentHarness,
  agentSlugFromDescription,
  type BeltTool,
  beltPattern,
  draftAgentDefinition,
  isAgentSlug,
  MODEL_TIERS,
  type ModelTier,
  normalizeSlug,
  parks,
  readDefinition,
} from "./agent-file";
import {
  DescriptionField,
  DraftNote,
  FileEditor,
  type PlannedFile,
  PullRequestPlan,
} from "./parts";
import type {
  CreateContext,
  StepId,
  StepProps,
  StepView,
  WizardKind,
} from "./wizard";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

type AgentDraft = {
  desc: string;
  /** What the operator typed; null while the slug still follows the description. */
  slug: string | null;
  /** No harness is preselected (ADR-101): the operator names one. */
  harness: AgentHarness | null;
  tier: ModelTier;
  /** Belt patterns picked on the toolbelt step, in the registry's order. */
  belt: readonly string[];
  /**
   * The file as the operator edited it, keyed by slug (mockup
   * `"wz:agent:"+slug`), so stepping back and forward keeps the edits. A
   * file somebody changed by hand is theirs: a belt pick does not overwrite
   * it (mockup `wzAgentSync`).
   */
  edits: Readonly<Record<string, string>>;
  registry:
    | { state: "idle" }
    | { state: "loading" }
    | { state: "loaded"; offer: ToolbeltOffer }
    | { state: "failed"; failure: Failure };
  submit:
    | { state: "idle" }
    | { state: "pending" }
    | { state: "failed"; failure: Failure }
    | { state: "opened"; agent: ProposedAgent };
};

const STEPS: readonly StepId[] = [
  "describe",
  "identity",
  "definition",
  "toolbelt",
  "pullRequest",
];

const CHECKS = [
  "schema",
  "key",
  "belt",
  "authority",
  "budget",
  "secrets",
] as const;

const FAILURES = {
  agent_check_schema: "checkSchema",
  agent_check_key: "checkKey",
  agent_check_belt: "checkBelt",
  agent_check_authority: "checkAuthority",
  agent_check_budget: "checkBudget",
  agent_check_secrets: "checkSecrets",
  org_role_required: "orgRoleRequired",
  workspace_repository_missing: "noRepository",
  github_refused: "githubRefused",
  gitlab_refused: "gitlabRefused",
  gitlab_credential_rejected: "gitlabCredentialRejected",
  unanswered: "unanswered",
} as const;

function isKnownFailure(code: string): code is keyof typeof FAILURES {
  return Object.hasOwn(FAILURES, code);
}

function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("createAgent.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
      case "unavailable":
        return isKnownFailure(failure.code)
          ? t(FAILURES[failure.code])
          : t("refused", { code: failure.code });
      case "invalid":
        return t("invalid", { field: failure.field ?? "input" });
      case "pending_approval":
        return t("pendingApproval", { request: failure.accessRequestId });
      case "exhausted":
        return t("refused", { code: failure.code });
    }
  };
}

/** The slug on screen: what the operator typed, or what the description implies. */
function slugOf(d: AgentDraft): string {
  return d.slug ?? agentSlugFromDescription(d.desc);
}

/** The file as the operator last saw it, and whether they changed it by hand. */
function useFile(api: StepProps<AgentDraft>["api"]) {
  const t = useTranslations("createAgent.definition.file");
  const d = api.draft;
  const slug = slugOf(d);
  const seed = draftAgentDefinition({
    slug,
    desc: d.desc,
    tier: d.tier,
    harness: d.harness,
    belt: d.belt,
    copy: {
      header: t("header"),
      placeholder: t("placeholder"),
      stayInside: t("stayInside"),
    },
  });
  const edited = d.edits[slug];
  const text = edited ?? seed;
  const sourceSlug = agentSourceSlug(text);
  return {
    slug: sourceSlug ?? slug,
    valid: sourceSlug !== null,
    seed,
    text,
    edited: edited !== undefined && edited !== seed,
    set: (value: string) => {
      const nextSlug = agentSourceSlug(value) ?? slug;
      const edits = Object.fromEntries(
        Object.entries(d.edits).filter(([key]) => key !== slug),
      );
      edits[nextSlug] = value;
      api.update({ slug: nextSlug, edits });
    },
    revert: () => {
      api.update({
        edits: Object.fromEntries(
          Object.entries(d.edits).filter(([key]) => key !== slug),
        ),
      });
    },
  };
}

function DescribeStep({ api }: StepProps<AgentDraft>) {
  const t = useTranslations("createAgent.describe");
  return (
    <div className="flex flex-col gap-3 text-sm">
      <DescriptionField
        api={api}
        placeholder={t("placeholder")}
        hint={t("hint")}
        suggestions={[
          t("suggestions.perfBudget"),
          t("suggestions.changelog"),
          t("suggestions.invoices"),
          t("suggestions.triage"),
        ]}
      />
      <p data-testid="not-register" className="text-muted-foreground">
        {t("notRegister")}
      </p>
    </div>
  );
}

function IdentityStep({ api }: StepProps<AgentDraft>) {
  const t = useTranslations("createAgent.identity");
  const d = api.draft;
  const slug = slugOf(d);
  const valid = isAgentSlug(slug);
  const file = useFile(api);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="wizard-slug" className="font-medium">
          {t("slug")}
        </label>
        <input
          id="wizard-slug"
          data-testid="wizard-slug"
          value={slug}
          maxLength={40}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={!valid}
          aria-describedby="wizard-slug-hint"
          onChange={(event) => {
            const next = normalizeSlug(event.target.value);
            const source = renameAgentSource(file.text, next);
            const edits = Object.fromEntries(
              Object.entries(d.edits).filter(
                ([key]) => key !== slug && key !== next,
              ),
            );
            if (file.edited) edits[next] = source ?? file.text;
            api.update({ slug: next, edits });
          }}
          className={`${inputBase} ${mono}`}
        />
        <p id="wizard-slug-hint" className="text-xs text-muted-foreground">
          {valid
            ? t.rich("slugHint", {
                slug,
                code: (chunks) => <span className={mono}>{chunks}</span>,
              })
            : t("slugInvalid")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wizard-harness" className="font-medium">
            {t("harness")}
          </label>
          <div className="flex items-center gap-2">
            <HarnessIcon harness={d.harness} />
            <select
              id="wizard-harness"
              data-testid="wizard-harness"
              value={d.harness ?? ""}
              aria-describedby="wizard-harness-hint"
              onChange={(event) => {
                const value = event.target.value;
                api.update({
                  harness: AGENT_HARNESSES.find((h) => h === value) ?? null,
                });
              }}
              className={inputBase}
            >
              <option value="" disabled>
                {t("harnessChoose")}
              </option>
              {AGENT_HARNESSES.map((h) => (
                <option key={h} value={h}>
                  {t(`harnesses.${h}`)}
                </option>
              ))}
            </select>
          </div>
          <p id="wizard-harness-hint" className="text-xs text-muted-foreground">
            {t("harnessHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="wizard-tier" className="font-medium">
            {t("tier")}
          </label>
          <select
            id="wizard-tier"
            data-testid="wizard-tier"
            value={d.tier}
            aria-describedby="wizard-tier-hint"
            onChange={(event) => {
              const tier = MODEL_TIERS.find((m) => m === event.target.value);
              if (tier !== undefined) api.update({ tier });
            }}
            className={`${inputBase} ${mono}`}
          >
            {MODEL_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
          <p id="wizard-tier-hint" className="text-xs text-muted-foreground">
            {t("tierHint")}
          </p>
        </div>
      </div>
    </div>
  );
}

function DefinitionStep({ api }: StepProps<AgentDraft>) {
  const t = useTranslations("createAgent.definition");
  const file = useFile(api);
  const reading = readDefinition(file.text);
  const chip = "rounded-md border border-border px-2 py-0.5 text-xs";
  const bad = `${chip} border-destructive/50 text-foreground`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <DraftNote title={t("drafted.title")} body={t("drafted.body")} />
      <p data-testid="derived" className="flex flex-wrap items-center gap-1.5">
        {reading.ok ? (
          <>
            {reading.slug === null ? (
              <span className={bad}>{t("noSlug")}</span>
            ) : reading.slug === file.slug ? (
              <span className={`${chip} ${mono}`}>{reading.slug}</span>
            ) : (
              <span className={bad}>
                {t("otherSlug", {
                  slug: reading.slug,
                  expected: file.slug,
                })}
              </span>
            )}
            {reading.tier === null ? null : (
              <span className={chip}>{reading.tier}</span>
            )}
            <span className={chip}>{t("tools", { count: reading.tools })}</span>
            <span className={chip}>
              {t("denied", { count: reading.denied })}
            </span>
          </>
        ) : (
          <span className={bad}>
            {t("unparsed", { line: reading.line, code: reading.code })}
          </span>
        )}
      </p>
      {reading.ok && !file.valid ? (
        <FormAlert>{t("invalidSlug")}</FormAlert>
      ) : null}
      <FileEditor
        path={`.oxagen/agents/${file.slug}.toml`}
        value={file.text}
        onChange={file.set}
        rename={{
          name: file.slug,
          onRename: (name) => {
            const source = renameAgentSource(file.text, name);
            if (source === null) return false;
            file.set(source);
            return true;
          },
        }}
        bar={
          <button
            type="button"
            className={`${buttonSecondary} min-h-8 px-3 py-1 text-xs`}
            disabled={!file.edited}
            onClick={file.revert}
          >
            {t("revert")}
          </button>
        }
      />
      <p className="text-muted-foreground">
        {t.rich("request", {
          code: (chunks) => <span className={mono}>{chunks}</span>,
        })}
      </p>
    </div>
  );
}

function ToolRow({
  tool,
  picked,
  onToggle,
}: {
  tool: BeltTool;
  picked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("createAgent.toolbelt");
  const pattern = beltPattern(tool);
  const tag = "rounded-md border border-border px-1.5 py-0.5 text-[11px]";
  return (
    <li>
      <label className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 has-[:checked]:border-brand">
        <input
          type="checkbox"
          checked={picked}
          onChange={onToggle}
          className="size-4 flex-none"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium text-foreground">{tool.name}</span>
          <span className={`${mono} break-all text-xs text-muted-foreground`}>
            {pattern}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <span className={tag}>{t("risk", { grade: tool.riskGrade })}</span>
          <span className={tag}>
            {tool.sideEffect === null
              ? t("unclassified")
              : t(`effects.${tool.sideEffect}`)}
          </span>
          {tool.financial ? (
            <span className={tag}>{t("financial")}</span>
          ) : null}
          {tool.killed ? <span className={tag}>{t("killed")}</span> : null}
          {parks(tool) ? (
            <span className={`${tag} font-medium text-foreground`}>
              {t("parks")}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function ToolbeltStep({ api, ctx }: StepProps<AgentDraft>) {
  const t = useTranslations("createAgent.toolbelt");
  const file = useFile(api);
  const d = api.draft;
  const registry = d.registry;

  useEffect(() => {
    if (api.draft.registry.state !== "idle") return;
    api.update({ registry: { state: "loading" } });
    void (async () => {
      let next: AgentDraft["registry"];
      try {
        const result = await readToolbelt(ctx.org, ctx.ws);
        next = result.ok
          ? { state: "loaded", offer: result.value }
          : { state: "failed", failure: result };
      } catch {
        next = {
          state: "failed",
          failure: { ok: false, reason: "unavailable", code: "unanswered" },
        };
      }
      api.update({ registry: next });
    })();
  }, [api, ctx.org, ctx.ws]);

  const tools = registry.state === "loaded" ? registry.offer.tools : [];
  const picked = tools.filter((tool) => d.belt.includes(beltPattern(tool)));
  const parking = picked.filter(parks);
  const toggle = (pattern: string) => {
    api.update({
      belt: d.belt.includes(pattern)
        ? d.belt.filter((p) => p !== pattern)
        : [...d.belt, pattern],
    });
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div aria-live="polite">
        {registry.state === "idle" || registry.state === "loading" ? (
          <p className="text-muted-foreground">{t("loading")}</p>
        ) : registry.state === "failed" ? (
          <FormAlert testId="belt-state">
            {registry.failure.reason === "denied"
              ? t("denied")
              : t("unavailable", {
                  code:
                    "code" in registry.failure
                      ? registry.failure.code
                      : registry.failure.reason,
                })}
          </FormAlert>
        ) : tools.length === 0 ? (
          <p data-testid="belt-empty" className="text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <ul
            aria-label={t("label")}
            data-testid="belt"
            className="flex flex-col gap-2"
          >
            {tools.map((tool) => {
              const pattern = beltPattern(tool);
              return (
                <ToolRow
                  key={pattern}
                  tool={tool}
                  picked={d.belt.includes(pattern)}
                  onToggle={() => {
                    toggle(pattern);
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>
      {registry.state === "loaded" && registry.offer.more ? (
        <p className="text-xs text-muted-foreground">{t("more")}</p>
      ) : null}
      <p data-testid="belt-note" className="text-muted-foreground">
        {picked.length === 0
          ? t.rich("nothing", {
              code: (chunks) => <span className={mono}>{chunks}</span>,
            })
          : parking.length === 0
            ? t("noneParks")
            : t("someParks", { count: parking.length })}
      </p>
      {file.edited ? (
        <p data-testid="belt-hand-edited" className="text-muted-foreground">
          {t("handEdited")}
        </p>
      ) : null}
    </div>
  );
}

function repoLine(ctx: CreateContext): string | null {
  return ctx.repo.state === "bound"
    ? `${ctx.repo.fullName}:${ctx.repo.defaultRef}`
    : null;
}

function PullRequestStep({ api, ctx }: StepProps<AgentDraft>) {
  const t = useTranslations("createAgent.pr");
  const failureText = useFailureText();
  const file = useFile(api);
  const d = api.draft;
  const files: PlannedFile[] = [
    {
      change: "add",
      path: `.oxagen/agents/${file.slug}.toml`,
      note: t("fileDefinition"),
    },
  ];
  if (d.harness !== null && SUBAGENT_FILE_HARNESSES.includes(d.harness)) {
    files.push({
      change: "add",
      path: `.claude/agents/${file.slug}.md`,
      note: t("fileGenerated"),
    });
  }
  const repo = ctx.repo;
  return (
    <div className="flex flex-col gap-3">
      <PullRequestPlan
        lead={t.rich("lead", {
          slug: file.slug,
          workspace: ctx.wsName,
          code: (chunks) => <span className={mono}>{chunks}</span>,
        })}
        base={repoLine(ctx)}
        branch={`agents/${file.slug}`}
        files={files}
        checks={CHECKS.map((c) => ({
          name: t(`checks.${c}.name`),
          detail: t(`checks.${c}.detail`),
        }))}
      />
      <p className="text-sm text-muted-foreground">{t("codex")}</p>
      <div aria-live="polite" className="flex flex-col gap-2">
        {repo.state === "loading" ? (
          <p className="text-sm text-muted-foreground">{t("repo.loading")}</p>
        ) : repo.state === "unbound" ? (
          <FormAlert testId="repo-state">{t("repo.unbound")}</FormAlert>
        ) : repo.state === "denied" ? (
          <FormAlert testId="repo-state">{t("repo.denied")}</FormAlert>
        ) : repo.state === "unavailable" ? (
          <FormAlert testId="repo-state">
            {t("repo.unavailable", { code: repo.code })}
          </FormAlert>
        ) : null}
        {d.submit.state === "failed" ? (
          <FormAlert testId="pr-failure">
            {failureText(d.submit.failure)}
          </FormAlert>
        ) : null}
      </div>
    </div>
  );
}

function Opened({ agent }: { agent: ProposedAgent }) {
  const t = useTranslations("createAgent.opened");
  const url = parsePullRequestUrl(agent.pullRequest.url);
  const label = t("link", {
    repository: agent.repository,
    number: agent.pullRequest.number,
  });
  return (
    <div
      role="status"
      data-testid="pr-opened"
      className="flex flex-col gap-2 text-sm"
    >
      <p>{t("proposed", { slug: agent.slug })}</p>
      {agent.agentKey === null ? null : (
        <p className={`${mono} break-all`}>
          {t("key", { key: agent.agentKey })}
        </p>
      )}
      <p>
        {url === null ? (
          <span className={mono}>{label}</span>
        ) : (
          <PullRequestLink to={url} className="font-medium text-link underline">
            {label}
          </PullRequestLink>
        )}
      </p>
      <p className={`${mono} break-all text-xs text-muted-foreground`}>
        {t("digest", { digest: agent.digest })}
      </p>
      <p className="text-muted-foreground">{t("register")}</p>
    </div>
  );
}

function useAgentStep(props: StepProps<AgentDraft>): StepView {
  const t = useTranslations("createAgent");
  const { api, ctx, step } = props;
  const d = api.draft;
  const file = useFile(api);
  if (step === 1)
    return {
      title: t("describe.title"),
      subtitle: t("describe.subtitle"),
      body: <DescribeStep {...props} />,
      primary: { label: t("draftIt"), enabled: d.desc.trim() !== "" },
    };
  if (step === 2)
    return {
      title: t("identity.title"),
      subtitle: t("identity.subtitle"),
      body: <IdentityStep {...props} />,
      primary: {
        label: t("writeDefinition"),
        enabled: isAgentSlug(slugOf(d)) && d.harness !== null,
      },
    };
  if (step === 3)
    return {
      title: t("definition.title"),
      subtitle: t("definition.subtitle", { slug: file.slug }),
      body: <DefinitionStep {...props} />,
      primary: {
        label: t("pickBelt"),
        enabled: file.valid,
      },
    };
  if (step === 4)
    return {
      title: t("toolbelt.title"),
      subtitle: t("toolbelt.subtitle"),
      body: <ToolbeltStep {...props} />,
      primary: { label: t("toPullRequest"), enabled: true },
    };
  if (d.submit.state === "opened")
    return {
      title: t("opened.title"),
      subtitle: t("opened.subtitle"),
      body: <Opened agent={d.submit.agent} />,
    };
  const submit = async () => {
    if (d.harness === null || !file.valid) return;
    api.update({ submit: { state: "pending" } });
    try {
      const result = await proposeAgent(ctx.org, ctx.ws, {
        slug: file.slug,
        harness: d.harness,
        source: file.text,
        rationale: d.desc,
      });
      api.update({
        submit: result.ok
          ? { state: "opened", agent: result.value }
          : { state: "failed", failure: result },
      });
    } catch {
      api.update({
        submit: {
          state: "failed",
          failure: { ok: false, reason: "unavailable", code: "unanswered" },
        },
      });
    }
  };
  return {
    title: t("pr.title"),
    subtitle: t("pr.subtitle"),
    body: <PullRequestStep {...props} />,
    primary: {
      label: t("pr.open"),
      pendingLabel: t("pr.opening"),
      pending: d.submit.state === "pending",
      enabled:
        ctx.repo.state === "bound" &&
        d.harness !== null &&
        file.valid &&
        d.submit.state !== "pending",
      run: submit,
    },
  };
}

export const agentWizard: WizardKind<AgentDraft> = {
  kind: "agent",
  need: "agent.write",
  init: () => ({
    desc: "",
    slug: null,
    harness: null,
    tier: "complex",
    belt: [],
    edits: {},
    registry: { state: "idle" },
    submit: { state: "idle" },
  }),
  steps: () => STEPS,
  useStep: useAgentStep,
};
