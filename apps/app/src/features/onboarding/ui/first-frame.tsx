"use client";
// Each completed server read schedules the next wait. A revision changes even
// when enrollment and heartbeat fields are unchanged.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useState } from "react";
import type {
  DetectedRepository,
  FirstFrame,
} from "@/data/contracts/onboarding";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { bindMainRepository } from "../actions";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { useFormatter } from "@/ui/formatter";

function HostFacts({ host }: { host: NonNullable<FirstFrame["host"]> }) {
  const t = useTranslations("onboarding.register.run.host");
  const format = useFormatter();
  const at = (instant: string) =>
    format.dateTime(new Date(instant), {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <ul
      data-testid="first-frame-host"
      className="flex flex-col gap-1 text-xs text-muted-foreground"
    >
      <li>{t("enrolled", { at: at(host.enrolledAt) })}</li>
      <li>
        {host.lastHeartbeatAt === null
          ? t("noHeartbeat")
          : t("heartbeat", { at: at(host.lastHeartbeatAt) })}
      </li>
      <li
        data-hooks={host.hooksOk === null ? "unreported" : String(host.hooksOk)}
      >
        {host.hooksOk === null
          ? t("hooksUnreported")
          : host.hooksOk
            ? t("hooksOk")
            : t("hooksMissing")}
      </li>
    </ul>
  );
}

function Repository({
  org,
  ws,
  workspace,
  repository,
  until,
  here,
}: {
  org: string;
  ws: string;
  workspace: string;
  repository: DetectedRepository;
  until: string;
  here: SafePath;
}) {
  const t = useTranslations("onboarding.register.run.repository");
  const format = useFormatter();
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fullName = `${repository.owner}/${repository.name}`;

  async function bind(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await bindMainRepository(org, ws, {
        owner: repository.owner,
        name: repository.name,
      });
      if (result.ok) navigate.replace(here);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-testid="detected-repository"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <code className={`${mono} block break-all rounded-md bg-muted px-2 py-1`}>
        {fullName}
      </code>
      <p className="max-w-prose text-sm text-muted-foreground">{t("body")}</p>
      {failure === null ? null : (
        <FormAlert testId="bind-failure">{failure}</FormAlert>
      )}
      <form onSubmit={(e) => void bind(e)} className="flex">
        <SubmitButton
          pending={pending}
          label={t("bind", { repository: fullName })}
          pendingLabel={t("binding")}
          fullWidth={false}
        />
      </form>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("skip", {
          workspace,
          until: format.dateTime(new Date(until), { dateStyle: "medium" }),
        })}
      </p>
    </section>
  );
}

export function FirstFrameStep({
  pollRevision,
  org,
  ws,
  workspace,
  agentKey,
  host,
  here,
  repository,
  provisionalUntil,
}: {
  /** A new opaque value after every completed server read. */
  pollRevision: string;
  org: string;
  ws: string;
  /** The workspace's name, for the provisional line. */
  workspace: string;
  agentKey: string | null;
  host: FirstFrame["host"];
  /** This step's own address, re-read while the wait continues. */
  here: SafePath;
  repository: DetectedRepository | null;
  /** When the provisional window closes; null once a main repository is bound. */
  provisionalUntil: string | null;
}) {
  const t = useTranslations("onboarding.register.run");
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState(false);

  // The server waits up to 20 seconds after enrollment. Before enrollment it
  // answers immediately, so a short delay keeps that path from a tight loop.
  useEffect(() => {
    const timer = setTimeout(() => {
      navigate.refresh();
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [pollRevision, navigate]);

  function again() {
    setWaiting(true);
    navigate.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        data-testid="first-frame-waiting"
        className={`${panel} flex flex-col gap-3 p-4`}
      >
        <h3 className="text-sm font-semibold">{t("waiting.title")}</h3>
        {agentKey === null ? null : (
          <code
            className={`${mono} self-start break-all rounded-md bg-muted px-2 py-1`}
          >
            {agentKey}
          </code>
        )}
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("waiting.body")}
        </p>
        {host === null ? (
          <p
            data-testid="first-frame-no-host"
            className="text-xs text-muted-foreground"
          >
            {t("host.none")}
          </p>
        ) : (
          <HostFacts host={host} />
        )}
        <button
          type="button"
          onClick={again}
          className={`${buttonSecondary} self-start`}
        >
          {waiting ? t("waiting.checking") : t("waiting.again")}
        </button>
      </section>
      {repository === null || provisionalUntil === null ? null : (
        <Repository
          org={org}
          ws={ws}
          workspace={workspace}
          repository={repository}
          until={provisionalUntil}
          here={here}
        />
      )}
    </div>
  );
}
