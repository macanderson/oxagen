"use client";
// The Workspace settings dialog's Repositories section (MC spec §10.1; the
// §17 M0 acceptance test "a second repo can be linked and unlinked").
//
// A workspace has one main repository, bound in the panel above this one, and
// any number of linked ones: the repositories its agents work on. This section
// lists every repository the workspace binds with its role, links another by
// `owner/name`, and unlinks a linked one after a confirmation drawn in place.
// The main row never offers an unlink: a workspace without a main repo cannot
// exist, `unlink_repository` refuses it with `main_repo_unlink_refused`, and a
// control that can only refuse is a control that lies.
//
// Every state is drawn from what `list_repositories` answered: reading, a
// refusal, nothing bound yet (the org's first workspace before its provisional
// window closes), only the main repository, and the populated list — with a
// row whose GitHub connection was retired saying so. The list is local facts
// only, so it draws while GitHub is down; the link is the one GitHub call, and
// it happens on submit.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useState } from "react";
import type { WorkspaceRepositories } from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonSecondary,
  eyebrow,
  inputBase,
  linkText,
  panel,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import {
  linkWorkspaceRepository,
  readWorkspaceRepositories,
  unlinkWorkspaceRepository,
} from "./workspace-settings-actions";
import {
  UNANSWERED,
  useWorkspaceSettingsFailure,
  type WorkspaceSettingsFailure,
} from "./workspace-settings-failure";
import { useFormatter } from "@/ui/formatter";

type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; failure: WorkspaceSettingsFailure }
  | { kind: "ready"; value: T };

type BoundRepositoryRow = WorkspaceRepositories["repositories"][number];

const sectionTitle = "text-sm font-semibold text-foreground";
const prose = "text-sm leading-relaxed text-muted-foreground";
const badge =
  "flex-none rounded-sm border border-border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

/**
 * `owner/name` as a person types it or pastes it from GitHub: surrounding
 * space and a trailing `.git` are dropped, and anything that is not exactly
 * two non-empty segments is not a repository. The segments' own spelling is
 * the contract's to judge, so this only splits.
 */
function parseRepository(text: string): { owner: string; name: string } | null {
  const trimmed = text.trim().replace(/\.git$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (owner === undefined || name === undefined) return null;
  if (owner === "" || name === "") return null;
  return { owner, name };
}

export function RepositoriesPanel({
  org,
  ws,
  open,
  version,
}: {
  org: string;
  ws: string;
  open: boolean;
  /**
   * Bumped by the panel above when it binds or re-binds the main repository,
   * so the list here re-reads rather than going on showing a row that moved.
   */
  version: number;
}) {
  const t = useTranslations("workspaceSettings.repositories");
  const failureText = useWorkspaceSettingsFailure();
  const [reloads, setReloads] = useState(0);
  const [list, setList] = useState<Load<WorkspaceRepositories>>({
    kind: "loading",
  });

  useEffect(() => {
    if (!open) return;
    // A cell read through a call, for the reason the panel above gives: the
    // cleanup writes it, and a call carries no narrowing across the await.
    const live = { current: true };
    const cancelled = () => !live.current;
    const load = async () => {
      // A list already in hand stays on screen while it re-reads after a
      // link or an unlink: the row that changed is what the person is
      // looking at, and a flash of "reading" would take it away.
      setList((current) =>
        current.kind === "ready" ? current : { kind: "loading" },
      );
      let record;
      try {
        record = await readWorkspaceRepositories(org, ws);
      } catch {
        record = UNANSWERED;
      }
      if (cancelled()) return;
      setList(
        record.ok
          ? { kind: "ready", value: record.value }
          : { kind: "failed", failure: record },
      );
    };
    void load();
    return () => {
      live.current = false;
    };
  }, [open, org, ws, reloads, version]);

  const changed = () => {
    setReloads((n) => n + 1);
  };

  return (
    <section
      aria-labelledby="workspace-repositories"
      data-testid="workspace-repositories"
      className="mt-6 border-t border-border pt-5"
    >
      <h3 id="workspace-repositories" className={sectionTitle}>
        {t("heading")}
      </h3>
      <p className={`mt-1.5 ${prose}`}>{t("about")}</p>
      <div className="mt-4">
        {list.kind === "loading" ? (
          <p
            role="status"
            data-testid="workspace-repository-list-loading"
            className={prose}
          >
            {t("loading")}
          </p>
        ) : list.kind === "failed" ? (
          <FormAlert testId="workspace-repository-list-failure">
            {failureText(list.failure)}
          </FormAlert>
        ) : (
          <>
            <RepositoryList
              org={org}
              ws={ws}
              repositories={list.value.repositories}
              onChanged={changed}
            />
            <LinkRepository org={org} ws={ws} onLinked={changed} />
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The rows, main first as the read sorts them. Two empty states, because they
 * are two different facts: a workspace that binds nothing yet is told the main
 * repository comes first, and one that binds only its main repository is told
 * a second one can be linked below.
 */
function RepositoryList({
  org,
  ws,
  repositories,
  onChanged,
}: {
  org: string;
  ws: string;
  repositories: BoundRepositoryRow[];
  onChanged: () => void;
}) {
  const t = useTranslations("workspaceSettings.repositories");
  if (repositories.length === 0) {
    return (
      <p data-testid="workspace-repository-list-none" className={prose}>
        {t("none")}
      </p>
    );
  }
  return (
    <>
      <ul
        aria-label={t("listLabel")}
        data-testid="workspace-repository-list"
        className="flex flex-col gap-2"
      >
        {repositories.map((repository) => (
          <RepositoryRow
            key={repository.bindingId}
            org={org}
            ws={ws}
            repository={repository}
            onUnlinked={onChanged}
          />
        ))}
      </ul>
      {repositories.every((repository) => repository.role === "main") ? (
        <p
          data-testid="workspace-repository-list-only-main"
          className={`mt-2 ${prose}`}
        >
          {t("onlyMain")}
        </p>
      ) : null}
    </>
  );
}

function RepositoryRow({
  org,
  ws,
  repository,
  onUnlinked,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  onUnlinked: () => void;
}) {
  const t = useTranslations("workspaceSettings.repositories");
  const format = useFormatter();
  const href = parseGitHubUrl(repository.htmlUrl);
  const name = (
    <span className="min-w-0 truncate font-mono text-[13px] font-semibold text-foreground">
      {repository.fullName}
    </span>
  );
  return (
    <li
      data-testid={`workspace-repository-row-${repository.bindingId}`}
      data-role={repository.role}
      className={`${panel} flex flex-col gap-1.5 px-3 py-2.5`}
    >
      <div className="flex items-center gap-2.5">
        <span className={badge}>
          {repository.role === "main" ? t("roleMain") : t("roleLinked")}
        </span>
        {href === null ? (
          name
        ) : (
          <GitHubLink
            to={href}
            data-testid={`workspace-repository-open-${repository.bindingId}`}
            title={t("open")}
            className={`min-w-0 ${linkText}`}
          >
            {name}
          </GitHubLink>
        )}
      </div>
      <p className={`text-xs ${prose}`}>
        {t("defaultRef", { ref: repository.defaultRef })}
        {" · "}
        <time dateTime={repository.boundAt}>
          {t("boundAt", {
            date: format.dateTime(new Date(repository.boundAt), {
              dateStyle: "medium",
            }),
          })}
        </time>
      </p>
      {repository.connectionLive ? null : (
        <p
          data-testid={`workspace-repository-retired-${repository.bindingId}`}
          className="text-xs leading-relaxed text-destructive"
        >
          {t("retired")}
        </p>
      )}
      {repository.role === "linked" ? (
        <UnlinkRepository
          org={org}
          ws={ws}
          repository={repository}
          onUnlinked={onUnlinked}
        />
      ) : null}
    </li>
  );
}

/**
 * The unlink, confirmed in place. A second dialog over the settings sheet
 * would stack two modals; a question drawn on the row keeps the repository
 * it is about in view and the way back one click away.
 */
function UnlinkRepository({
  org,
  ws,
  repository,
  onUnlinked,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  onUnlinked: () => void;
}) {
  const t = useTranslations("workspaceSettings.repositories");
  const failureText = useWorkspaceSettingsFailure();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = repository.bindingId;

  async function unlink(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await unlinkWorkspaceRepository(org, ws, id);
      if (result.ok) onUnlinked();
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="mt-1 flex">
        <button
          type="button"
          data-testid={`workspace-repository-unlink-${id}`}
          data-touch-target=""
          className={buttonSecondary}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t("unlink")}
        </button>
      </div>
    );
  }
  return (
    <form
      noValidate
      data-testid={`workspace-repository-unlink-confirm-${id}`}
      className="mt-1 flex flex-col gap-2"
      onSubmit={(e) => void unlink(e)}
    >
      <p className={prose}>
        {t("unlinkConfirm", { repository: repository.fullName })}
      </p>
      {failure === null ? null : (
        <FormAlert testId={`workspace-repository-unlink-failure-${id}`}>
          {failure}
        </FormAlert>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("unlinkYes")}
          pendingLabel={t("unlinking")}
        />
        <button
          type="button"
          data-testid={`workspace-repository-unlink-keep-${id}`}
          data-touch-target=""
          className={buttonSecondary}
          onClick={() => {
            setConfirming(false);
            setFailure(null);
          }}
        >
          {t("unlinkNo")}
        </button>
      </div>
    </form>
  );
}

/**
 * One field and one submit. The repository is named, never picked out of a
 * list: `list_installation_repositories` is a live GitHub call that walks the
 * whole installation, which this section — drawn on every open — should not
 * pay for, and the link refuses a repository the installation cannot see
 * with a sentence of its own.
 */
function LinkRepository({
  org,
  ws,
  onLinked,
}: {
  org: string;
  ws: string;
  onLinked: () => void;
}) {
  const t = useTranslations("workspaceSettings.repositories.link");
  const failureText = useWorkspaceSettingsFailure();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function link(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const repository = parseRepository(text);
    if (repository === null) {
      setFailure(t("unparsable"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await linkWorkspaceRepository(org, ws, repository);
      if (result.ok) {
        setText("");
        onLinked();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      data-testid="workspace-repository-link"
      className="mt-4"
      onSubmit={(e) => void link(e)}
    >
      <h4 className={sectionTitle}>{t("heading")}</h4>
      <label htmlFor={fieldId} className={`mt-3 block ${eyebrow}`}>
        {t("label")}
      </label>
      <input
        id={fieldId}
        type="text"
        data-testid="workspace-repository-link-input"
        className={`mt-1 font-mono ${inputBase}`}
        placeholder={t("placeholder")}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={`${fieldId}-hint`}
        aria-invalid={failure === null ? undefined : true}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <p id={`${fieldId}-hint`} className={`mt-1 text-xs ${prose}`}>
        {t("hint")}
      </p>
      {failure === null ? null : (
        <div className="mt-3">
          <FormAlert testId="workspace-repository-link-failure">
            {failure}
          </FormAlert>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("submit")}
          pendingLabel={t("pending")}
        />
      </div>
    </form>
  );
}
