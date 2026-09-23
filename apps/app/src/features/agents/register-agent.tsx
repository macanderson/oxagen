"use client";
// Register an agent (mockups/pages/agents.md, the `register` dialog): a slug,
// the avatar the agent will show, a harness and a model tier, over the note
// that the dialog opens a Context PR and writes no Postgres row. The write is
// `registerAgent`, which opens that pull request through propose_agent.
//
// New agent is not this. New agent is the wizard, which drafts a definition
// from a description and lets the operator edit it first; this dialog writes
// the wizard's default definition for the three choices it asks for. Wrap
// Claude Code is not this either: it leaves the page for the Register Agent
// gate, which wraps an agent that already runs.
//
// The definition carries no avatar field, so the Avatar row shows the initials
// the agent will show and says so, rather than offering a designer whose
// choice nothing would store.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { Avatar } from "@/ui/avatar";
import {
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { PullRequestLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { registerAgent } from "./actions";

const TEST_ID = "register-agent";
/** The slug rule propose_agent applies (agent.propose.ts `agentSlugSchema`). */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX = 18;

type Opened = { number: number; url: string; path: string };

export function RegisterAgent({
  org,
  ws,
  harnesses,
  tiers,
}: {
  org: string;
  ws: string;
  /** The harnesses a definition can be written for, in the wizard's order; none is the default. */
  harnesses: readonly { value: string; label: string }[];
  /** The model tiers a definition can name. */
  tiers: readonly string[];
}) {
  const t = useTranslations("agents.list.register");
  const create = useTranslations("agents.list.create");
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  const slugOk = slug.length <= SLUG_MAX && SLUG.test(slug);
  const path = `.oxagen/agents/${slug === "" ? "<slug>" : slug}.toml`;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!slugOk) {
      setFailure(t("invalidSlug"));
      return;
    }
    const form = new FormData(event.currentTarget);
    const harness = form.get("harness");
    const tier = form.get("tier");
    setPending(true);
    setFailure(null);
    try {
      const result = await registerAgent(org, ws, {
        slug,
        harness: typeof harness === "string" ? harness : "",
        tier: typeof tier === "string" ? tier : "",
      });
      if (result.ok)
        setOpened({
          number: result.value.pullRequest.number,
          url: result.value.pullRequest.url,
          path: result.value.path,
        });
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const pullRequest = opened === null ? null : parsePullRequestUrl(opened.url);
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        data-testid="agents-register-open"
        onClick={() => {
          setOpen(true);
        }}
      >
        {create("register")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFailure(null);
            setOpened(null);
            setSlug("");
          }
        }}
        title={t("title")}
        closeLabel={opened === null ? t("cancel") : t("close")}
        testId={TEST_ID}
      >
        {opened !== null ? (
          <div data-state="opened" className="flex flex-col gap-2 text-sm">
            <p>{t("done", { number: opened.number })}</p>
            <p className={`${mono} text-xs text-muted-foreground`}>
              {opened.path}
            </p>
            {pullRequest === null ? null : (
              <PullRequestLink to={pullRequest} className={linkText}>
                {t("open")}
              </PullRequestLink>
            )}
          </div>
        ) : (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3 text-sm"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor={`${TEST_ID}-slug`}>{t("slug")}</label>
              <input
                id={`${TEST_ID}-slug`}
                name="slug"
                value={slug}
                required
                autoComplete="off"
                aria-invalid={slug !== "" && !slugOk}
                aria-describedby={`${TEST_ID}-slug-hint`}
                className={`${inputBase} ${mono}`}
                onChange={(event) => {
                  setSlug(event.target.value.toLowerCase());
                }}
              />
              <p
                id={`${TEST_ID}-slug-hint`}
                className="text-xs text-muted-foreground"
              >
                {slug !== "" && !slugOk ? t("invalidSlug") : t("slugHint")}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <span>{t("avatar")}</span>
              <span className="flex items-center gap-3">
                <Avatar
                  value={null}
                  initials={(slug.slice(0, 2) || "?").toUpperCase()}
                  size={44}
                  shape="agent"
                />
                <span className="text-xs text-muted-foreground">
                  {t("avatarHint")}
                </span>
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${TEST_ID}-harness`}>{t("harness")}</label>
              <select
                id={`${TEST_ID}-harness`}
                name="harness"
                required
                defaultValue=""
                className={inputBase}
              >
                <option value="" disabled>
                  {t("harness")}
                </option>
                {harnesses.map((harness) => (
                  <option key={harness.value} value={harness.value}>
                    {harness.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${TEST_ID}-tier`}>{t("tier")}</label>
              <select
                id={`${TEST_ID}-tier`}
                name="tier"
                defaultValue={tiers[0]}
                className={inputBase}
              >
                {tiers.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </div>
            <p className="border-l-2 border-gold pl-3 text-xs text-muted-foreground">
              {t.rich("note", {
                path,
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </p>
            {failure === null ? null : (
              <FormAlert testId={`${TEST_ID}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        )}
      </SheetDialog>
    </>
  );
}
