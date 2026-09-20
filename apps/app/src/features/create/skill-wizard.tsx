"use client";
// The skill wizard (roadmap creation-spec §4; mockup `wzSkill`). Three ways
// in, one way out: search a registry and pin a version, describe the skill
// and get a drafted SKILL.md, or upload a bundle built elsewhere. All three
// end at `.oxagen/skills/<name>/SKILL.md` in a pull request against the
// workspace's main repository, because a skill an agent can find is a skill
// somebody merged.
//
// The registry path is shown and closed: no skill registry store exists yet
// (propose_skill's `origin` takes `describe` and `upload` only), so the card
// says why rather than offering a search that could only come back empty.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { renameSkillSource, skillSourceName } from "@/shared/source-identity";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import { type ProposedSkill, proposeSkill } from "./actions";
import {
  type Bundle,
  type BundleError,
  BundleReadError,
  readBundle,
} from "./bundle";
import {
  DescriptionField,
  DraftNote,
  FileEditor,
  OptionCard,
  type PlannedFile,
  PullRequestPlan,
} from "./parts";
import {
  draftSkill,
  estimateTokens,
  frontmatterOf,
  isSemver,
  skillNameOf,
  slugFromDescription,
  slugFromFileName,
} from "./skill-file";
import type {
  CreateContext,
  StepId,
  StepProps,
  StepView,
  WizardKind,
} from "./wizard";

type SkillPath = "registry" | "describe" | "upload";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

type SkillDraft = {
  path: SkillPath | null;
  desc: string;
  bundle: Bundle | null;
  bundleError: BundleError | null;
  /**
   * The file as the operator edited it, keyed by where it came from, so
   * stepping back and forward keeps the edits (mockup `cedSeed`).
   */
  edits: Readonly<Record<string, string>>;
  submit:
    | { state: "idle" }
    | { state: "pending" }
    | { state: "failed"; failure: Failure }
    | { state: "opened"; skill: ProposedSkill };
};

function skillSteps(draft: SkillDraft): readonly StepId[] {
  const second: StepId =
    draft.path === "registry"
      ? "find"
      : draft.path === "upload"
        ? "upload"
        : "describeIt";
  return ["source", second, "review", "pullRequest"];
}

/** The key the operator's edits are kept under: one file per way in and per bundle. */
function editKey(draft: SkillDraft): string {
  return draft.path === "upload" && draft.bundle !== null
    ? `upload:${draft.bundle.digest}`
    : "describe";
}

/** The directory name the file falls back to when its frontmatter names none. */
function fallbackName(draft: SkillDraft): string {
  if (draft.path === "upload" && draft.bundle !== null) {
    return skillNameOf(
      draft.bundle.body,
      slugFromFileName(draft.bundle.fileName),
    );
  }
  return slugFromDescription(draft.desc);
}

const CHECKS = [
  "frontmatter",
  "version",
  "digest",
  "grants",
  "secrets",
  "loadCost",
] as const;

const FAILURES = {
  skill_check_frontmatter: "checkFrontmatter",
  skill_check_version: "checkVersion",
  skill_check_digest: "checkDigest",
  skill_check_grants: "checkGrants",
  skill_check_secrets: "checkSecrets",
  skill_check_load_cost: "checkLoadCost",
  skill_merged_unversioned: "mergedUnversioned",
  org_role_required: "orgRoleRequired",
  workspace_repository_missing: "noRepository",
  github_refused: "githubRefused",
  unanswered: "unanswered",
} as const;

function isKnownFailure(code: string): code is keyof typeof FAILURES {
  return Object.hasOwn(FAILURES, code);
}

function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("create.skill.failure");
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

function SourceStep({ api }: StepProps<SkillDraft>) {
  const t = useTranslations("create.skill.source");
  const d = api.draft;
  const choose = (path: SkillPath) => {
    api.update({ path, submit: { state: "idle" } });
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid gap-2.5 sm:grid-cols-3">
        <OptionCard
          title={t("registry.title")}
          body={t("registry.body")}
          note={t("registry.closed")}
          pressed={d.path === "registry"}
          disabled
          onPress={() => {
            choose("registry");
          }}
        />
        <OptionCard
          title={t("describe.title")}
          body={t("describe.body")}
          pressed={d.path === "describe"}
          onPress={() => {
            choose("describe");
          }}
        />
        <OptionCard
          title={t("upload.title")}
          body={t.rich("upload.body", {
            code: (chunks) => <span className={mono}>{chunks}</span>,
          })}
          pressed={d.path === "upload"}
          onPress={() => {
            choose("upload");
          }}
        />
      </div>
      <p className="text-muted-foreground">{t("note")}</p>
    </div>
  );
}

function DescribeStep({ api }: StepProps<SkillDraft>) {
  const t = useTranslations("create.skill.describe");
  return (
    <div className="flex flex-col gap-3 text-sm">
      <DescriptionField
        api={api}
        placeholder={t("placeholder")}
        hint={t("hint")}
        suggestions={[
          t("suggestions.releaseNotes"),
          t("suggestions.rollback"),
          t("suggestions.migration"),
          t("suggestions.flakyTest"),
        ]}
      />
      <p className="text-muted-foreground">{t("noAuthority")}</p>
    </div>
  );
}

function UploadStep({ api }: StepProps<SkillDraft>) {
  const t = useTranslations("create.skill.upload");
  const [reading, setReading] = useState(false);
  const d = api.draft;
  async function pick(file: File) {
    setReading(true);
    try {
      const bundle = await readBundle(file);
      api.update({ bundle, bundleError: null });
    } catch (err) {
      api.update({
        bundle: null,
        bundleError: err instanceof BundleReadError ? err.code : "not_a_zip",
      });
    } finally {
      setReading(false);
    }
  }
  const b = d.bundle;
  const fm = b === null ? null : frontmatterOf(b.body);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-2">
        <label htmlFor="wizard-bundle" className="font-medium">
          {t("label")}
        </label>
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-dashed border-border bg-muted/30 px-3.5 py-3">
          <input
            id="wizard-bundle"
            data-testid="wizard-bundle"
            type="file"
            accept=".skill,.zip,.md"
            aria-describedby="wizard-bundle-hint"
            className="min-w-44 flex-1 text-xs text-muted-foreground"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void pick(file);
            }}
          />
          <span
            id="wizard-bundle-hint"
            className="text-xs text-muted-foreground"
          >
            {t("types")}
          </span>
        </div>
      </div>
      <div aria-live="polite">
        {reading ? (
          <p className="text-muted-foreground">{t("reading")}</p>
        ) : d.bundleError !== null ? (
          <FormAlert testId="bundle-error">
            {t(`error.${d.bundleError}`)}
          </FormAlert>
        ) : b === null ? (
          <p className="text-muted-foreground">{t("nothing")}</p>
        ) : (
          <dl
            data-testid="bundle-summary"
            className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border border-border bg-muted/30 px-3.5 py-3"
          >
            <dt className="text-muted-foreground">{t("file")}</dt>
            <dd className={`${mono} break-all`}>
              {t("size", {
                name: b.fileName,
                kb: Math.max(1, Math.round(b.size / 1024)),
              })}
            </dd>
            <dt className="text-muted-foreground">{t("contents")}</dt>
            <dd className={`${mono} break-all`}>
              {["SKILL.md", ...b.files.map((f) => f.path)].join(" · ")}
            </dd>
            <dt className="text-muted-foreground">{t("version")}</dt>
            <dd className={mono}>{fm?.version ?? t("noVersion")}</dd>
            <dt className="text-muted-foreground">{t("digest")}</dt>
            <dd className={`${mono} break-all`}>{b.digest}</dd>
          </dl>
        )}
      </div>
      <p className="text-muted-foreground">{t("replaces")}</p>
    </div>
  );
}

function useFileOf(api: StepProps<SkillDraft>["api"], ctx: CreateContext) {
  const t = useTranslations("create.skill.draft");
  const d = api.draft;
  const seed =
    d.path === "upload" && d.bundle !== null
      ? d.bundle.body
      : draftSkill({
          desc: d.desc,
          name: slugFromDescription(d.desc),
          ws: ctx.ws,
          copy: {
            purpose: t("purpose"),
            precondition: t("precondition"),
            never: t("never"),
            grantsNothing: t("grantsNothing"),
          },
        });
  const key = editKey(d);
  const text = d.edits[key] ?? seed;
  return {
    seed,
    text,
    edited: text !== seed,
    name: skillNameOf(text, fallbackName(d)),
    set: (value: string) => {
      api.update({ edits: { ...d.edits, [key]: value } });
    },
  };
}

function ReviewStep({ api, ctx }: StepProps<SkillDraft>) {
  const t = useTranslations("create.skill.review");
  const file = useFileOf(api, ctx);
  const fm = frontmatterOf(file.text);
  const version = fm?.version;
  const tokens = estimateTokens(file.text);
  const chip = "rounded-md border border-border px-2 py-0.5 text-xs";
  const bad = `${chip} border-destructive/50 text-foreground`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {api.draft.path === "describe" ? (
        <DraftNote title={t("drafted.title")} body={t("drafted.body")} />
      ) : null}
      <p data-testid="derived" className="flex flex-wrap items-center gap-1.5">
        {fm?.name ? (
          <span className={`${chip} ${mono}`}>{fm.name}</span>
        ) : (
          <span className={bad}>{t("noName")}</span>
        )}
        {version === undefined ? (
          <span className={bad}>{t("noVersion")}</span>
        ) : isSemver(version) ? (
          <span className={`${chip} ${mono}`}>{t("version", { version })}</span>
        ) : (
          <span className={bad}>{t("badVersion", { version })}</span>
        )}
        {fm?.scope ? null : <span className={bad}>{t("noScope")}</span>}
        <span className={chip}>{t("tokens", { tokens })}</span>
      </p>
      {skillSourceName(file.text) === null ? (
        <FormAlert>{t("invalidName")}</FormAlert>
      ) : null}
      <FileEditor
        path={`.oxagen/skills/${file.name}/SKILL.md`}
        value={file.text}
        onChange={file.set}
        rename={{
          name: file.name,
          onRename: (name) => {
            const source = renameSkillSource(file.text, name);
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
            onClick={() => {
              file.set(file.seed);
            }}
          >
            {t("revert")}
          </button>
        }
      />
      <p className="text-muted-foreground">{t("cost")}</p>
    </div>
  );
}

function repoLine(ctx: CreateContext): string | null {
  return ctx.repo.state === "bound"
    ? `${ctx.repo.fullName}:${ctx.repo.defaultRef}`
    : null;
}

function PullRequestStep({ api, ctx }: StepProps<SkillDraft>) {
  const t = useTranslations("create.skill.pr");
  const failureText = useFailureText();
  const file = useFileOf(api, ctx);
  const d = api.draft;
  const files: PlannedFile[] = [
    {
      change: "add",
      path: `.oxagen/skills/${file.name}/SKILL.md`,
      note: t("fileSkill"),
    },
    ...(d.path === "upload" && d.bundle !== null
      ? d.bundle.files.map(
          (f): PlannedFile => ({
            change: "add",
            path: `.oxagen/skills/${file.name}/${f.path}`,
            note: t("fileBundle"),
          }),
        )
      : []),
  ];
  const repo = ctx.repo;
  return (
    <div className="flex flex-col gap-3">
      <PullRequestPlan
        lead={t.rich("lead", {
          name: file.name,
          workspace: ctx.wsName,
          code: (chunks) => <span className={mono}>{chunks}</span>,
        })}
        base={repoLine(ctx)}
        branch={`skills/${file.name}`}
        files={files}
        checks={CHECKS.map((c) => ({
          name: t(`checks.${c}.name`),
          detail: t(`checks.${c}.detail`),
        }))}
      />
      <p className="text-sm text-muted-foreground">{t("replaces")}</p>
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

function Opened({ skill }: { skill: ProposedSkill }) {
  const t = useTranslations("create.skill.opened");
  const url = parsePullRequestUrl(skill.pullRequest.url);
  const label = t("link", {
    repository: skill.repository,
    number: skill.pullRequest.number,
  });
  return (
    <div
      role="status"
      data-testid="pr-opened"
      className="flex flex-col gap-2 text-sm"
    >
      <p>
        {skill.replaces === null
          ? t("added", { name: skill.name, version: skill.version })
          : t("replaced", {
              name: skill.name,
              from: skill.replaces,
              version: skill.version,
            })}
      </p>
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
        {t("digest", { digest: skill.digest })}
      </p>
      <p className="text-muted-foreground">
        {t("tokens", { tokens: skill.tokens, budget: skill.budget })}
      </p>
    </div>
  );
}

function useSkillStep(props: StepProps<SkillDraft>): StepView {
  const t = useTranslations("create.skill");
  const { api, ctx, step } = props;
  const d = api.draft;
  const file = useFileOf(api, ctx);
  if (step === 1)
    return {
      title: t("source.title"),
      subtitle: t("source.subtitle"),
      body: <SourceStep {...props} />,
      primary: {
        label: t("next"),
        enabled: d.path === "describe" || d.path === "upload",
      },
    };
  if (step === 2 && d.path === "upload")
    return {
      title: t("upload.title"),
      subtitle: t("upload.subtitle"),
      body: <UploadStep {...props} />,
      primary: { label: t("readFile"), enabled: d.bundle !== null },
    };
  if (step === 2)
    return {
      title: t("describe.title"),
      subtitle: t("describe.subtitle"),
      body: <DescribeStep {...props} />,
      primary: { label: t("draftFile"), enabled: d.desc.trim() !== "" },
    };
  if (step === 3)
    return {
      title: t("review.title"),
      subtitle: t("review.subtitle"),
      body: <ReviewStep {...props} />,
      primary: {
        label: t("toPullRequest"),
        enabled: skillSourceName(file.text) !== null,
      },
    };
  if (d.submit.state === "opened")
    return {
      title: t("opened.title"),
      subtitle: t("opened.subtitle"),
      body: <Opened skill={d.submit.skill} />,
    };
  const submit = async () => {
    if (d.path !== "describe" && d.path !== "upload") return;
    if (skillSourceName(file.text) === null) return;
    api.update({ submit: { state: "pending" } });
    try {
      const result = await proposeSkill(ctx.org, ctx.ws, {
        origin: d.path,
        name: file.name,
        body: file.text,
        files: d.path === "upload" && d.bundle !== null ? d.bundle.files : [],
        rationale: d.path === "describe" ? d.desc : "",
      });
      api.update({
        submit: result.ok
          ? { state: "opened", skill: result.value }
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
        d.submit.state !== "pending" &&
        skillSourceName(file.text) !== null,
      run: submit,
    },
  };
}

export const skillWizard: WizardKind<SkillDraft> = {
  kind: "skill",
  need: "skills.admin",
  init: () => ({
    path: null,
    desc: "",
    bundle: null,
    bundleError: null,
    edits: {},
    submit: { state: "idle" },
  }),
  steps: skillSteps,
  useStep: useSkillStep,
};
