"use client";
// The GitLab half of Connect a code host: a group's path and a group access
// token, posted as JSON to the API route that checks the token and stores the
// connection (`POST /api/v1/{org}/connections/steering/gitlab`). The browser
// reaches it same-origin with the session cookie. A 200 continues to the
// first workspace. A refusal keeps the form and says what GitLab or the API
// answered.
//
// The token field is a password input and is cleared after every answer, so
// it never sits in the page once the request is done.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { z } from "zod";
import type { SafePath } from "@/shared/safe-path";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";

type Refusal =
  | { key: "tokenInvalid" }
  | { key: "groupUnreachable" }
  | { key: "tokenNotGroup" }
  | { key: "tokenInsufficient" }
  | { key: "forbidden" }
  | { key: "badInput" }
  | { key: "failed"; code: string };

/** The API's error envelope: `{ error: { code, reason?, message }, requestId }`. */
const Envelope = z.object({
  error: z.object({
    code: z.string().optional(),
    reason: z.string().optional(),
  }),
});

async function namedCode(response: Response): Promise<string | null> {
  try {
    const parsed = Envelope.safeParse(await response.json());
    if (!parsed.success) return null;
    return parsed.data.error.reason ?? parsed.data.error.code ?? null;
  } catch {
    return null;
  }
}

/** The sentence a refused connection shows: GitLab's own reasons first, then the status. */
function refusalOf(status: number, code: string | null): Refusal {
  switch (code) {
    case "gitlab_token_invalid":
      return { key: "tokenInvalid" };
    case "gitlab_group_unreachable":
      return { key: "groupUnreachable" };
    case "gitlab_token_not_group":
      return { key: "tokenNotGroup" };
    case "gitlab_token_insufficient":
      return { key: "tokenInsufficient" };
  }
  if (status === 403) return { key: "forbidden" };
  if (status === 400) return { key: "badInput" };
  return { key: "failed", code: code ?? String(status) };
}

export function GitlabConnect({
  path,
  next,
}: {
  /** The API route the form posts to (`steeringGitlabPath(org)`). */
  path: string;
  /** Where a stored connection continues to. */
  next: SafePath;
}) {
  const t = useTranslations("onboarding.welcome.connect.gitlab");
  const navigate = useNavigate();
  const [group, setGroup] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setRefusal(null);
    try {
      let response: Response;
      try {
        response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ group: group.trim(), token }),
        });
      } catch {
        setRefusal({ key: "failed", code: "network" });
        return;
      }
      if (response.ok) {
        navigate.push(next);
        return;
      }
      setRefusal(refusalOf(response.status, await namedCode(response)));
    } finally {
      setToken("");
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      aria-label={t("heading")}
      data-testid="gitlab-connect"
      onSubmit={(e) => void onSubmit(e)}
      className="flex min-w-0 flex-col gap-4"
    >
      {refusal === null ? null : (
        <FormAlert testId="gitlab-connect-refused">
          {refusal.key === "failed"
            ? t("errors.failed", { code: refusal.code })
            : t(`errors.${refusal.key}`)}
        </FormAlert>
      )}
      <Field
        id="ob-gitlab-group"
        name="group"
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        required
        label={t("groupLabel")}
        value={group}
        onChange={(e) => {
          setGroup(e.target.value);
        }}
        className="font-mono"
      />
      <Field
        id="ob-gitlab-token"
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        label={t("tokenLabel")}
        hint={t("hint")}
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
        }}
        className="font-mono"
      />
      <div>
        <SubmitButton
          pending={pending}
          label={t("submit")}
          pendingLabel={t("pending")}
          fullWidth={false}
          secondary
          testId="gitlab-connect-submit"
        />
      </div>
    </form>
  );
}
