// The two flows as Server Components: read the session, the step, the scope and
// each port read, then hand the interactive pieces their data. Route files wrap
// these in <Suspense fallback={<GateSkeleton />}> so every dynamic read streams.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { denied as deniedRead } from "@/data/not-backed";
import { requireViewer } from "@/server/scope";
import { PageState } from "@/ui/page-state";
import { withNext } from "../auth/safe-next";
import { getAuthUser } from "../auth/session";
import { OutcomePanel } from "@/ui/form-feedback";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { agentKey } from "./agent-key";
import {
  type AgentChoice,
  gateAgentChoice,
  gateHref,
  readAgentChoice,
  readGateQuery,
  registerHref,
} from "./flow-links";
import type { FlowScope } from "./model";
import {
  fixturePageState,
  loadDetectedRepository,
  loadFirstFrameScript,
  loadFlowScope,
  loadInstallerOffer,
  loadViewerFlowScope,
} from "./reads";
import {
  type FlowMode,
  parseGateStep,
  parseRegisterStep,
  wrapMethodFor,
} from "./steps";
import { FirstFramePanel } from "./ui/first-frame-panel";
import { GateShell, GateSkeleton, StepHeading } from "./ui/gate-shell";
import { NameAgentForm } from "./ui/name-agent-form";
import { OrganizationForm } from "./ui/organization-form";
import { RepoPanel } from "./ui/repo-panel";
import { WrapPanel } from "./ui/wrap-panel";

type SearchParams = Record<string, string | string[] | undefined>;

export type WelcomeScreenProps = {
  params: Promise<{ step?: string[] }>;
  searchParams: Promise<SearchParams>;
};

async function ScopeProblem({
  kind,
  startHref,
}: {
  kind: "missing" | "not-found";
  startHref: string;
}) {
  const t = await getTranslations("onboarding.states");
  return (
    <OutcomePanel
      tone="neutral"
      testId={
        kind === "missing"
          ? "onboarding-scope-missing"
          : "onboarding-scope-not-found"
      }
      title={
        kind === "missing" ? t("scopeMissingTitle") : t("scopeNotFoundTitle")
      }
      actions={
        <Link href={startHref} className={buttonSecondary}>
          {kind === "missing"
            ? t("scopeMissingTitle")
            : t("scopeNotFoundTitle")}
        </Link>
      }
    >
      {kind === "missing" ? t("scopeMissingBody") : t("scopeNotFoundBody")}
    </OutcomePanel>
  );
}

async function RunStep({
  mode,
  scope,
  choice,
}: {
  mode: FlowMode;
  scope: FlowScope;
  choice: AgentChoice;
}) {
  const t = await getTranslations("onboarding");
  const key = agentKey(scope.org.namespace, scope.ws.namespace, choice.agent);
  const fleetHref = `/${scope.org.slug}/${scope.ws.slug}`;
  const state = await fixturePageState();
  const heading = (
    <StepHeading
      index={2}
      total={3}
      title={mode === "gate" ? t("run.gateTitle") : t("run.registerTitle")}
      lead={
        mode === "gate"
          ? t("run.gateLead", { key })
          : t("run.registerLead", { key })
      }
    />
  );

  if (state === "error") {
    const script = loadFirstFrameScript(scope, key, choice.harness);
    return (
      <>
        {heading}
        <OutcomePanel
          tone="deny"
          testId="first-frame-error"
          title={t("run.errorTitle")}
          actions={
            <Link
              href={
                mode === "gate"
                  ? gateHref("run", { org: scope.org.slug, ws: scope.ws.slug })
                  : registerHref(scope.org.slug, scope.ws.slug, "run", choice)
              }
              className={buttonSecondary}
            >
              {t("run.checkAgain")}
            </Link>
          }
        >
          <p>
            {t("run.errorBody", { host: script.ok ? script.value.host : "—" })}
          </p>
          <p className="mt-2">{t("run.errorHint")}</p>
        </OutcomePanel>
      </>
    );
  }

  const script = loadFirstFrameScript(scope, key, choice.harness);
  const repo = mode === "gate" ? loadDetectedRepository() : null;
  return (
    <>
      {heading}
      {script.ok ? (
        <FirstFramePanel
          mode={mode}
          script={script.value}
          agentKey={key}
          harnessLabel={t(`name.harnesses.${choice.harness}`)}
          openHref={fleetHref}
        />
      ) : (
        <div
          className="mt-5 flex flex-col gap-3"
          data-testid="first-frame-not-backed"
        >
          <PageState
            page={mode === "gate" ? "welcome" : "register"}
            result={script}
          />
          <p className="text-sm text-muted-foreground">{t("run.notBacked")}</p>
          <Link href={fleetHref} className={`${buttonPrimary} w-fit`}>
            {t("run.continueToFleet")}
          </Link>
        </div>
      )}
      {repo ? (
        repo.ok ? (
          <RepoPanel repo={repo.value} />
        ) : (
          <p
            className="mt-4 text-sm text-muted-foreground"
            data-testid="repo-not-backed"
          >
            {t("repo.notBacked")}
          </p>
        )
      ) : null}
    </>
  );
}

async function WrapStep({
  mode,
  scope,
  choice,
  runPath,
  runQuery,
  backHref,
}: {
  mode: FlowMode;
  scope: FlowScope;
  choice: AgentChoice;
  runPath: string;
  runQuery: Record<string, string>;
  backHref: string;
}) {
  const t = await getTranslations("onboarding.wrap");
  const key = agentKey(scope.org.namespace, scope.ws.namespace, choice.agent);
  const installer = loadInstallerOffer();
  return (
    <>
      <StepHeading
        index={1}
        total={3}
        title={mode === "gate" ? t("gateTitle") : t("registerTitle")}
        lead={t("lead", { key })}
      />
      <WrapPanel
        agentKey={key}
        initialMethod={wrapMethodFor(choice.harness)}
        initialHarness={choice.harness}
        installer={installer.ok ? installer.value : null}
        installerNotice={
          installer.ok ? null : (
            <div
              className="flex flex-col gap-2"
              data-testid="installer-not-backed"
            >
              <PageState
                page={mode === "gate" ? "welcome" : "register"}
                result={installer}
              />
              <p className="text-xs text-muted-foreground">
                {t("installerNotBacked")}
              </p>
            </div>
          )
        }
        runPath={runPath}
        runQuery={runQuery}
        backHref={backHref}
      />
    </>
  );
}

/** `/welcome/[[...step]]` and `/new-organization`: the onboarding gate. */
export async function WelcomeScreen({
  params,
  searchParams,
}: WelcomeScreenProps) {
  const [{ step: segments }, query] = await Promise.all([params, searchParams]);
  const step = parseGateStep(segments);
  if (!step) notFound();
  const user = await getAuthUser();
  if (!user) redirect(withNext("/login", gateHref("organization", null)));

  const state = await fixturePageState();
  if (state === "loading") return <GateSkeleton />;

  const gate = readGateQuery(query);
  const links = gate ? { org: gate.org, ws: gate.ws, choice: null } : null;
  const shell = (children: ReactNode, hiddenTitle = false) => (
    <GateShell
      mode="gate"
      step={step}
      email={user.email}
      links={links}
      hiddenTitle={hiddenTitle}
    >
      {children}
    </GateShell>
  );

  if (state === "denied") {
    const t = await getTranslations("onboarding.states");
    return shell(
      <PageState page="welcome" result={deniedRead(t("gateDenied"))} />,
      true,
    );
  }

  if (step === "organization") {
    const t = await getTranslations("onboarding.organization");
    return shell(
      <>
        <StepHeading index={0} total={3} title={t("title")} lead={t("lead")} />
        <OrganizationForm />
      </>,
    );
  }

  if (!gate)
    return shell(
      <ScopeProblem
        kind="missing"
        startHref={gateHref("organization", null)}
      />,
      true,
    );
  const scope = await loadFlowScope(gate.org, gate.ws);
  if (!scope.ok)
    return shell(
      <ScopeProblem
        kind="not-found"
        startHref={gateHref("organization", null)}
      />,
      true,
    );
  const choice = gateAgentChoice(query);

  if (step === "wrap") {
    return shell(
      <WrapStep
        mode="gate"
        scope={scope.value}
        choice={choice}
        runPath="/welcome/run"
        runQuery={{ org: gate.org, ws: gate.ws }}
        backHref={gateHref("organization", null)}
      />,
    );
  }
  return shell(<RunStep mode="gate" scope={scope.value} choice={choice} />);
}

export type RegisterScreenProps = {
  params: Promise<{ org: string; ws: string; step?: string[] }>;
  searchParams: Promise<SearchParams>;
};

/** `/[org]/[ws]/register/[[...step]]`: Register an agent, reusing the gate's wrap and first-frame screens. */
export async function RegisterScreen({
  params,
  searchParams,
}: RegisterScreenProps) {
  const [{ org, ws, step: segments }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const step = parseRegisterStep(segments);
  if (!step) notFound();
  const user = await getAuthUser();
  if (!user) redirect(withNext("/login", registerHref(org, ws, "name", null)));
  // The same gate every [org]/[ws] page runs: a non-member of the workspace is
  // not found, MFA and historical slugs are enforced before anything renders.
  const viewer = await requireViewer(org, ws);
  const scope = await loadViewerFlowScope(viewer);
  if (!scope.ok) notFound();

  const state = await fixturePageState();
  if (state === "loading") return <GateSkeleton />;

  const fleetHref = `/${org}/${ws}`;
  const choice = readAgentChoice(query);
  const shell = (children: ReactNode, hiddenTitle = false) => (
    <GateShell
      mode="register"
      step={step}
      email={user.email}
      cancelHref={fleetHref}
      links={{ org, ws, choice }}
      hiddenTitle={hiddenTitle}
    >
      {children}
    </GateShell>
  );

  if (state === "denied") {
    const t = await getTranslations("onboarding.states");
    return shell(
      <PageState
        page="register"
        result={deniedRead(t("registerDenied", { ws }))}
      />,
      true,
    );
  }

  const t = await getTranslations("onboarding.name");
  if (step === "name") {
    return shell(
      <>
        <StepHeading index={0} total={3} title={t("title")} lead={t("lead")} />
        <NameAgentForm
          org={{
            slug: scope.value.org.slug,
            namespace: scope.value.org.namespace,
          }}
          ws={scope.value.ws}
          cancelHref={fleetHref}
          initial={choice}
        />
      </>,
    );
  }

  if (!choice) {
    return shell(
      <OutcomePanel
        tone="neutral"
        testId="register-choice-missing"
        title={t("missing")}
        actions={
          <Link
            href={registerHref(org, ws, "name", null)}
            className={buttonSecondary}
          >
            {t("startOver")}
          </Link>
        }
      />,
      true,
    );
  }

  if (step === "wrap") {
    return shell(
      <WrapStep
        mode="register"
        scope={scope.value}
        choice={choice}
        runPath={`/${org}/${ws}/register/run`}
        runQuery={{ agent: choice.agent, tier: choice.tier }}
        backHref={registerHref(org, ws, "name", choice)}
      />,
    );
  }
  return shell(<RunStep mode="register" scope={scope.value} choice={choice} />);
}
