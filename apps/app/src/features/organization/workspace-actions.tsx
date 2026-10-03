"use client";
// The Workspaces section's three writes (#2964): create a workspace, rename
// one, and archive one. Creating a workspace in the app is what this lane adds
// to rev1: between the organization's first workspace, which `create_org`
// makes, and this form, a second one was made through the API, MCP or CLI.
// Each write reloads the page it changed.
//
// The create form asks for a Label, the name people see, and a Name, the
// workspace's slug, which fills in from the Label until the person types
// their own. It asks for the cost-center code the workspace is charged to,
// which is the Name unless the person unticks that and types another, and for
// where the workspace's private steering repo goes and what it is called
// (#5196). `create_workspace` makes that repository itself (lane S1, #4450),
// so the person picks no code repository. The Organization select loads when
// the dialog opens, and the Repository name follows the Name as
// `oxagen-<slug>` until the person edits it.
//
// Once the write answers, the dialog shows the steering repo's provisioning
// steps in place of the form and reads them every few seconds. When the repo
// is ready it says so, then sends the person to the new workspace's
// Repositories page with "Add Oxagen to a repository" open, since linking a
// repository waits for the steering repo (`main_repo_unbound`). Closing the
// dialog before then opens the new workspace's Fleet. The edit form shows the
// main repository and branch `list_repositories` reports, read-only, because
// which repository is main does not change from here (spec §10.1 makes that an
// org owner's decision).
import { GOVERNANCE_MODES } from "@oxagen/oxagen/contracts/context.steering.shared";
import { costCenterLabelSchema } from "@oxagen/oxagen/contracts/cost_center.shared";
import { CheckIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceFacts } from "@/data/contracts/org";
import {
  defaultRepoNameForSlug,
  SteeringRepoDestinationFields,
  SteeringRepoProvisioning,
  type SteeringRepoView,
  steeringRepoDraftOf,
} from "@/features/steering-repo/client";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { Button } from "@/ui/button";
import { inputBase } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { HelpTip } from "@/ui/help-tip";
import { PullRequestLink, useNavigate } from "@/ui/navigation";
import {
  archiveWorkspace,
  createWorkspace,
  editWorkspace,
  type GovernanceChanged,
  type NewWorkspaceDraft,
  readSteeringRepoDestinations,
  readWorkspaceSteeringRepo,
  type WorkspaceCreated,
} from "./actions";
import { textValue, WriteDialog } from "./dialog";
import { note, warn } from "./parts";
import { slugDraft, slugFromName, slugProblem } from "./workspace-slug";

/** The checkbox that charges the workspace to a cost center named for it. */
const COST_CENTER_FROM_NAME = "costCenterFromName";

/**
 * The create form's draft. The Label is the contract's `name` and the Name is
 * its `slug`. A Name left empty sends no slug, so the action makes it from the
 * Label. The cost-center code is the slug while the box is ticked.
 */
function newDraftOf(form: FormData): NewWorkspaceDraft {
  const steeringRepo = steeringRepoDraftOf(form);
  const name = textValue(form, "name");
  const slug = textValue(form, "slug").trim();
  const costCenter =
    textValue(form, COST_CENTER_FROM_NAME) === "yes"
      ? slug === ""
        ? slugFromName(name)
        : slug
      : textValue(form, "costCenter").trim();
  return {
    name,
    ...(slug === "" ? {} : { slug }),
    ...(costCenter === "" ? {} : { costCenter }),
    ...(steeringRepo === undefined ? {} : { steeringRepo }),
  };
}

/**
 * Marks an input invalid with the sentence shown under it, so the browser
 * stops the submit and points at the field, as the Repository name does.
 */
function useValidity(problem: string | undefined) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.setCustomValidity(problem ?? "");
  }, [problem]);
  return ref;
}

/** A field's "?" and its note. */
function FieldHelp({
  field,
  text,
  id,
}: {
  field: string;
  text: string;
  id: string;
}) {
  const t = useTranslations("organization.actions.createWorkspace.help");
  return (
    <HelpTip label={t("open", { field })} testId={`${id}-help`}>
      {text}
    </HelpTip>
  );
}

/**
 * The create form's fields. The Label and the Name are held here so the Name
 * can follow the Label, and the steering repo's name can follow the Name, as
 * the person types.
 */
function NewWorkspaceFields({ org }: { org: string }) {
  const t = useTranslations("organization.actions.createWorkspace.fields");
  const th = useTranslations("organization.actions.createWorkspace.help");
  const [label, setLabel] = useState("");
  // Null while the Name follows the Label. Once the person types in it, it
  // keeps what they typed, and an emptied Name shows the Label's slug as its
  // placeholder and sends none.
  const [typed, setTyped] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [fromName, setFromName] = useState(true);
  const [code, setCode] = useState("");
  const derived = slugFromName(label);
  const slug = typed === null || typed === "" ? derived : typed;
  const problem = slug === "" ? null : slugProblem(slug);
  const slugError =
    checked && problem !== null ? t(`slugProblems.${problem}`) : undefined;
  const codeError =
    !fromName &&
    code.trim() !== "" &&
    !costCenterLabelSchema.safeParse(code.trim()).success
      ? t("costCenterInvalid")
      : undefined;
  const slugRef = useValidity(
    problem === null ? undefined : t(`slugProblems.${problem}`),
  );
  const codeRef = useValidity(codeError);
  return (
    <>
      <Field
        id="create-workspace-label"
        name="name"
        label={t("label")}
        help={
          <FieldHelp
            field={t("label")}
            text={th("label")}
            id="create-workspace-label"
          />
        }
        required
        autoComplete="off"
        value={label}
        onChange={(event) => {
          setLabel(event.target.value);
        }}
        onBlur={() => {
          setChecked(true);
        }}
      />
      <Field
        ref={slugRef}
        id="create-workspace-slug"
        name="slug"
        label={t("name")}
        help={
          <FieldHelp
            field={t("name")}
            text={th("name")}
            id="create-workspace-slug"
          />
        }
        error={slugError}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        value={typed ?? derived}
        placeholder={derived}
        onChange={(event) => {
          setTyped(slugDraft(event.target.value));
        }}
        onBlur={() => {
          setChecked(true);
        }}
      />
      <label
        data-touch-target=""
        className="flex min-h-11 items-start gap-2.5 text-base"
      >
        <input
          type="checkbox"
          className="mt-1"
          name={COST_CENTER_FROM_NAME}
          value="yes"
          checked={fromName}
          data-testid="create-workspace-cost-center-from-name"
          onChange={(event) => {
            setFromName(event.target.checked);
          }}
        />
        <span>{t("costCenterFromName")}</span>
      </label>
      {fromName ? null : (
        <Field
          ref={codeRef}
          id="create-workspace-cost-center"
          name="costCenter"
          label={t("costCenter")}
          help={
            <FieldHelp
              field={t("costCenter")}
              text={th("costCenter")}
              id="create-workspace-cost-center"
            />
          }
          error={codeError}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      )}
      <SteeringRepoDestinationFields
        org={org}
        load={readSteeringRepoDestinations}
        defaultName={defaultRepoNameForSlug(problem === null ? slug : "")}
        idPrefix="create-workspace"
      />
    </>
  );
}

/**
 * The steering governance mode, as the design's `wsGov` select, whose first
 * choice is "leave unchanged".
 *
 * It defaults that way on purpose. The mode lives in a file on GitHub
 * (ADR-061), and this section runs in an org-only scope that cannot read it for
 * another workspace, so pre-selecting a mode would either need a GitHub round
 * trip per row or state a mode the page had guessed. Unchanged is the one
 * honest default, and it keeps a plain rename free of any governance call.
 *
 * The override is offered to everyone who sees this, because everyone who sees
 * this already holds it: the dialog opens for an org Owner or Admin, which is
 * inside the set `set_governance_mode` admits. It is disabled until a mode is
 * picked, so it never sits live over a form that is going to change nothing.
 */
function GovernanceField({ idPrefix }: { idPrefix: string }) {
  const t = useTranslations("organization.actions.governance");
  const [mode, setMode] = useState("");
  const option = (choice: string) =>
    choice === "solo"
      ? t("solo")
      : choice === "team"
        ? t("team")
        : t("regulated");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        htmlFor={`${idPrefix}-governance`}
        className="text-base font-medium text-foreground"
      >
        {t("heading")}
      </label>
      <select
        id={`${idPrefix}-governance`}
        name="mode"
        value={mode}
        aria-describedby={`${idPrefix}-governance-about`}
        data-testid={`${idPrefix}-governance`}
        onChange={(event) => {
          setMode(event.target.value);
        }}
        className={`${inputBase} max-md:text-input-touch`}
      >
        <option value="">{t("unchanged")}</option>
        {GOVERNANCE_MODES.map((choice) => (
          <option key={choice} value={choice}>
            {option(choice)}
          </option>
        ))}
      </select>
      <p
        id={`${idPrefix}-governance-about`}
        className="text-sm text-muted-foreground"
      >
        {t("about")}
      </p>
      <label
        data-touch-target=""
        className="flex min-h-11 items-start gap-2.5 text-base has-[:disabled]:opacity-50"
      >
        <input
          type="checkbox"
          className="mt-1"
          name="applyImmediately"
          value="yes"
          disabled={mode === ""}
          aria-describedby={`${idPrefix}-governance-override-hint`}
        />
        <span>
          <b className="block font-medium">{t("override")}</b>
          <span
            id={`${idPrefix}-governance-override-hint`}
            className="block text-sm text-muted-foreground"
          >
            {t("overrideHint")}
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * A field the design draws whose value no contract records or takes yet:
 * shown read-only with the words "not recorded" and a hint saying why, so the
 * form never implies it set something it did not.
 */
function UnrecordedField({
  id,
  label,
  hint,
  value,
}: {
  id: string;
  label: string;
  hint: string;
  /** A value the record does carry, such as the namespace; else "not recorded". */
  value?: string;
}) {
  const t = useTranslations("organization");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-base font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        readOnly
        disabled
        value={value ?? t("notRecorded")}
        aria-describedby={`${id}-hint`}
        className={`${inputBase} max-md:text-input-touch ${value === undefined ? "text-dim" : "font-mono"}`}
      />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/**
 * Production branch on the Edit form, the design's `wsBranch` select. It
 * offers the one branch `list_repositories` records for the main repository,
 * and it is disabled: `edit_workspace` takes no branch, and the binding moves
 * only by a re-approval on the Repositories page, which the hint says. A
 * select that offered main, release and production would promise a write the
 * form cannot make.
 */
function BranchSelect({ id, branch }: { id: string; branch: string | null }) {
  const t = useTranslations("organization");
  const tf = useTranslations("organization.actions.fields");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-base font-medium text-foreground">
        {tf("productionBranch")}
      </label>
      <select
        id={id}
        disabled
        aria-describedby={`${id}-hint`}
        data-testid="edit-workspace-branch"
        className={`${inputBase} max-md:text-input-touch ${branch === null ? "text-dim" : "font-mono"}`}
      >
        <option>{branch ?? t("notRecorded")}</option>
      </select>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {tf("productionBranchHint")}
      </p>
    </div>
  );
}

/**
 * The workspace facts the Edit dialog lists under its fields. The agent count
 * is `list_agents`', when the tab could read inside the workspace; nothing
 * records a toolbelt limit or a default budget per workspace yet (#3933).
 */
function WorkspaceFactList({ agents }: { agents: number | null }) {
  const t = useTranslations("organization.actions.editWorkspace.facts");
  const tOrg = useTranslations("organization");
  const term = "text-muted-foreground";
  return (
    <dl className="grid grid-cols-dl gap-x-4 gap-y-1.5 text-base">
      <dt className={term}>{t("toolbelt")}</dt>
      <dd className="text-dim">{tOrg("notRecorded")}</dd>
      <dt className={term}>{t("budget")}</dt>
      <dd className="text-dim">{tOrg("notRecorded")}</dd>
      <dt className={term}>{t("agents")}</dt>
      {agents === null ? (
        <dd className="text-dim">{tOrg("notRecorded")}</dd>
      ) : (
        <dd className="tabular-nums" data-testid="edit-workspace-agents">
          {t("agentsCount", { count: agents })}
        </dd>
      )}
    </dl>
  );
}

/**
 * Whether the governance half left anything worth holding the dialog open for.
 *
 * It is a predicate rather than a null return from the panel itself, because
 * `WriteDialog` asks before it renders: a component that renders nothing is
 * still a node, and the dialog would stay open on an empty panel. A rename
 * alone, or a mode the file already declared, has nothing to say and closes as
 * every other write does.
 */
function hasGovernanceNote(governance: GovernanceChanged | null): boolean {
  if (governance === null) return false;
  if (!governance.ok) return true;
  return governance.outcome !== "unchanged";
}

/**
 * The proposal's pull request, linked only when the URL parses as one
 * (INV-13): the value arrives from GitHub through the capability, so the app
 * checks it here rather than rendering whatever came back as an href. A URL
 * that does not parse still leaves the number on screen, which is enough to
 * find the pull request by hand.
 */
function GovernancePullRequest({
  pullRequest,
}: {
  pullRequest: { number: number; htmlUrl: string };
}) {
  const t = useTranslations("organization.actions.governance");
  const href = parsePullRequestUrl(pullRequest.htmlUrl);
  const label = t("done.openPr", { number: pullRequest.number });
  if (href === null) {
    return <p className="text-muted-foreground">{label}</p>;
  }
  return (
    <PullRequestLink
      to={href}
      data-testid="edit-workspace-governance-pr"
      className="font-medium underline"
    >
      {label}
    </PullRequestLink>
  );
}

/**
 * What the governance half of the edit left to read. A proposal has to stay on
 * screen: the pull request URL is not something the person can reconstruct, and
 * until someone merges it the mode has not moved.
 */
function GovernanceResult({
  governance,
}: {
  governance: GovernanceChanged | null;
}) {
  const t = useTranslations("organization.actions.governance");
  if (governance === null) return null;
  if (!governance.ok) {
    return (
      <p className="text-base text-error-ink">
        {t("done.refused", { reason: governance.code ?? governance.reason })}
      </p>
    );
  }
  if (governance.outcome === "unchanged") return null;
  return (
    <div className="flex flex-col gap-2 text-base">
      <p>
        {governance.outcome === "applied"
          ? t("done.applied", {
              mode: governance.mode,
              branch: governance.branch,
              repo: governance.repo,
            })
          : t("done.proposed", {
              mode: governance.mode,
              branch: governance.branch,
            })}
      </p>
      {governance.overrodeReview ? (
        <p className="text-muted-foreground">{t("done.overridden")}</p>
      ) : null}
      {governance.pullRequest === null ? null : (
        <>
          {governance.pullRequest.reused ? (
            <p className="text-muted-foreground">{t("done.reused")}</p>
          ) : null}
          <GovernancePullRequest pullRequest={governance.pullRequest} />
        </>
      )}
    </div>
  );
}

/** How often the panel reads the steering repo while the job runs. */
const SETUP_POLL_MS = 3_000;
/** How long the panel shows that setup finished before it moves on. */
const FORWARD_AFTER_MS = 1_500;

/**
 * The new workspace's steering repo, read every few seconds until it is ready
 * (`get_steering_repo` in the new workspace, where the creator is the Owner).
 * A read that fails keeps the last view and tries again. A retry inside the
 * steps takes effect on the next read.
 */
function useSteeringRepoWhileProvisioning(org: string, ws: string) {
  const [view, setView] = useState<SteeringRepoView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = view?.status === "ready";
  useEffect(() => {
    if (ready) return;
    let live = true;
    let timer: number | undefined;
    async function read() {
      try {
        const answer = await readWorkspaceSteeringRepo(org, ws);
        if (!live) return;
        if (answer.ok) {
          setView(answer.value);
          setFailed(null);
        } else {
          setFailed("code" in answer ? answer.code : answer.reason);
        }
      } catch {
        if (live) setFailed("unanswered");
      }
      if (live) timer = window.setTimeout(() => void read(), SETUP_POLL_MS);
    }
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [org, ws, ready]);
  return { view, failed };
}

/** The cost center the workspace was charged to, or why it was not. */
function CostCenterResult({
  charged,
}: {
  charged: NonNullable<WorkspaceCreated["costCenter"]>;
}) {
  const t = useTranslations("organization.actions.createWorkspace.done");
  return charged.ok ? (
    <dd className="font-mono" data-testid="create-workspace-cost-center">
      {charged.code}
    </dd>
  ) : (
    <dd data-testid="create-workspace-cost-center" className="text-error-ink">
      {t("costCenterFailed", { code: charged.code, reason: charged.reason })}
    </dd>
  );
}

/**
 * What the create dialog shows once `create_workspace` answered: the new
 * workspace, its cost center, and its steering repo's provisioning steps as
 * they happen. A durable job makes the repository, so the steps start on
 * `provisioning`. A step that stops shows its way on here, as it does on the
 * Repositories page. Once the repository is ready the panel says so, then
 * sends the person to pick the repositories the workspace steers.
 */
function WorkspaceSetupPanel({
  org,
  created,
  leave,
}: {
  org: string;
  created: WorkspaceCreated;
  leave: (then: () => void) => void;
}) {
  const t = useTranslations("organization.actions.createWorkspace.done");
  const tSetup = useTranslations("repositories.steeringRepo.setup");
  const navigate = useNavigate();
  const { view, failed } = useSteeringRepoWhileProvisioning(org, created.slug);
  const ready = view?.status === "ready";
  const forward = () => {
    leave(() => {
      navigate.replace(routes.addRepository(org, created.slug));
    });
  };
  // The dialog hands a new `leave` each time it renders. The countdown calls
  // the latest forward, so a render does not restart it.
  const forwardRef = useRef(forward);
  useEffect(() => {
    forwardRef.current = forward;
  });
  useEffect(() => {
    if (!ready) return;
    const id = window.setTimeout(() => {
      forwardRef.current();
    }, FORWARD_AFTER_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [ready]);
  const term = "text-muted-foreground";
  return (
    <div className="flex flex-col gap-4 text-base">
      <dl className="grid grid-cols-dl gap-x-4 gap-y-1.5">
        <dt className={term}>{t("workspace")}</dt>
        <dd className="font-medium" data-testid="create-workspace-done-name">
          {created.name}{" "}
          <span className="font-mono text-sm text-muted-foreground">
            {created.slug}
          </span>
        </dd>
        {created.costCenter === null ? null : (
          <>
            <dt className={term}>{t("costCenter")}</dt>
            <CostCenterResult charged={created.costCenter} />
          </>
        )}
      </dl>
      <p className="text-sm text-muted-foreground">{tSetup("intro.create")}</p>
      {view === null ? (
        <p
          role="status"
          data-testid="create-workspace-steering-reading"
          className="text-sm text-muted-foreground"
        >
          {failed === null ? t("reading") : t("readFailed", { code: failed })}
        </p>
      ) : (
        <SteeringRepoProvisioning
          org={org}
          ws={created.slug}
          view={view}
          canAct
          canChangeConnection
          returnTo={routes.steeringSetup(org, created.slug)}
        />
      )}
      {ready ? (
        <div
          role="status"
          data-testid="create-workspace-ready"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-success/45 bg-success/10 px-3.5 py-2.75 text-sm text-foreground"
        >
          <CheckIcon aria-hidden className="size-4 flex-none text-success" />
          <p className="min-w-0 flex-1">{t("ready")}</p>
          <Button
            type="button"
            variant="primary"
            data-testid="create-workspace-pick-repositories"
            data-touch-target=""
            onClick={forward}
          >
            {t("pickRepositories")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function CreateWorkspace({
  org,
  primary = false,
}: {
  org: string;
  /** The header's and the empty state's gold action; the panel's is plain. */
  primary?: boolean;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("createWorkspace.open"),
        title: t("createWorkspace.title"),
        confirm: t("createWorkspace.confirm"),
        pending: t("createWorkspace.pending"),
        receipt: tr("workspaceCreated"),
      }}
      testId="create-workspace"
      primary={primary}
      wide
      submit={(form) => createWorkspace(org, newDraftOf(form))}
      done={{
        close: t("createWorkspace.done.close"),
        render: (created, leave) => (
          <WorkspaceSetupPanel org={org} created={created} leave={leave} />
        ),
      }}
      onDone={(created) => {
        // WL-62: the workspace that was just made is where the operator wants to
        // be, so closing the panel before setup finishes opens it by the slug
        // the write returned. A finished setup moves on by itself instead.
        navigate.replace(routes.fleet(org, created.slug));
      }}
    >
      <NewWorkspaceFields org={org} />
    </WriteDialog>
  );
}

export function EditWorkspace({
  org,
  workspace,
  facts = null,
}: {
  org: string;
  workspace: Workspace;
  /** What the tab read inside this workspace; null when it could not. */
  facts?: WorkspaceFacts | null;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const tf = useTranslations("organization.actions.fields");
  const tg = useTranslations("organization.actions.governance");
  const navigate = useNavigate();
  const main = facts?.repositories.find((repo) => repo.role === "main");
  return (
    <WriteDialog
      copy={{
        open: t("editWorkspace.open"),
        title: t("editWorkspace.title"),
        subtitle: workspace.slug,
        confirm: t("editWorkspace.confirm"),
        pending: t("editWorkspace.pending"),
        receipt: tr("workspaceSaved", { name: workspace.name }),
      }}
      testId={`edit-workspace-${workspace.id}`}
      submit={(form) =>
        editWorkspace(org, workspace.id, {
          // The design's Edit form has no slug field: the slug the workspace
          // has is sent back, so a rename never moves its URLs.
          name: textValue(form, "name"),
          slug: workspace.slug,
          mode: textValue(form, "mode"),
          // The checkbox only reaches the form when it is ticked, and it is
          // disabled until a mode is picked, so anything else is false.
          applyImmediately: textValue(form, "applyImmediately") === "yes",
        })
      }
      done={{
        close: tg("done.close"),
        render: (edited) =>
          hasGovernanceNote(edited.governance) ? (
            <GovernanceResult governance={edited.governance} />
          ) : null,
      }}
      onDone={() => {
        navigate.replace(routes.organization(org, "workspaces"));
      }}
    >
      <Field
        id={`edit-workspace-${workspace.id}-name`}
        name="name"
        label={tf("name")}
        required
        defaultValue={workspace.name}
      />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-main`}
        label={tf("mainRepo")}
        hint={tf("mainRepoFixed")}
        {...(main === undefined ? {} : { value: main.fullName })}
      />
      <BranchSelect
        id={`edit-workspace-${workspace.id}-branch`}
        branch={main?.defaultRef ?? null}
      />
      <GovernanceField idPrefix={`edit-workspace-${workspace.id}`} />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-namespace`}
        label={tf("namespace")}
        hint={tf("namespaceHint")}
        value={workspace.namespace}
      />
      <UnrecordedField
        id={`edit-workspace-${workspace.id}-retention`}
        label={tf("retention")}
        hint={tf("retentionHint")}
      />
      <WorkspaceFactList agents={facts?.agents ?? null} />
    </WriteDialog>
  );
}

/**
 * What Archive says about the agents registered in the workspace, and whether
 * it can be sent. `archive_workspace` refuses while any live agent other than
 * the built-in one is registered (`workspace_has_agents`), so the dialog warns
 * and disables its confirm when the facts count one, as the design draws it.
 * A workspace the viewer cannot enter has no facts: the dialog says the count
 * is not readable and leaves the refusal to the handler.
 */
function ArchiveAgents({
  blockers,
}: {
  blockers: WorkspaceFacts["archiveBlockers"] | null;
}) {
  const t = useTranslations("organization.actions.archiveWorkspace");
  if (blockers === null) {
    return (
      <p data-testid="archive-workspace-agents" className={note}>
        {t("agentsUnread")}
      </p>
    );
  }
  if (blockers.count === 0) {
    return (
      <p data-testid="archive-workspace-agents" className={note}>
        {t("noAgents")}
      </p>
    );
  }
  return (
    <p role="alert" data-testid="archive-workspace-agents" className={warn}>
      {t("agents", {
        count: blockers.count,
        more: blockers.more ? "yes" : "no",
      })}
    </p>
  );
}

export function ArchiveWorkspace({
  org,
  workspace,
  facts = null,
}: {
  org: string;
  workspace: Workspace;
  /** What the tab read inside this workspace; null when it could not. */
  facts?: WorkspaceFacts | null;
}) {
  const t = useTranslations("organization.actions");
  const tr = useTranslations("organization.receipts");
  const navigate = useNavigate();
  const blockers = facts?.archiveBlockers ?? null;
  return (
    <WriteDialog
      copy={{
        open: t("archiveWorkspace.open"),
        title: t("archiveWorkspace.title"),
        subtitle: workspace.name,
        confirm: t("archiveWorkspace.confirm"),
        pending: t("archiveWorkspace.pending"),
        receipt: tr("workspaceArchived", { name: workspace.name }),
      }}
      testId={`archive-workspace-${workspace.id}`}
      danger
      blocked={blockers !== null && blockers.count > 0}
      submit={() => archiveWorkspace(org, workspace.id)}
      onDone={() => {
        navigate.replace(routes.organization(org, "workspaces"));
      }}
    >
      <p className="text-base">
        {t.rich("archiveWorkspace.body", {
          name: workspace.name,
          b: (chunks) => <b>{chunks}</b>,
        })}
      </p>
      <ArchiveAgents blockers={blockers} />
    </WriteDialog>
  );
}
