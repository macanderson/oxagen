import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { dataSource } from "@/data/source";
import {
  parseRegisterStep,
  RegisterAgent,
  RegisterGate,
  RegisterSkeleton,
} from "@/features/onboarding";
import { PageRecord } from "@/features/shell";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";

// The tab names the step the operator is on, the way the step's h1 does; a
// segment that names no step keeps the flow's own name until the page 404s.
export async function generateMetadata({
  params,
}: PageProps<"/[org]/[ws]/register/[step]">): Promise<Metadata> {
  const { step } = await params;
  const registerStep = parseRegisterStep(step);
  if (registerStep === null) {
    const t = await getTranslations("pages");
    return { title: t("register") };
  }
  const t = await getTranslations("onboarding.register");
  return { title: t(`${registerStep}.title`) };
}

// Register an agent, one step per segment (#2967, ADR-065 decision 1). A
// segment that names no step is a 404, so the flow has three addresses and no
// catch-all. The gate (top bar, rail, caption) renders before the step reads,
// and the step streams in behind the loading skeleton.
export default async function RegisterPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/register/[step]">) {
  const { org, ws, step } = await params;
  const ctx = await requireViewer(org, ws);
  const registerStep = parseRegisterStep(step);
  if (registerStep === null) notFound();
  const { agent, runtime } = await searchParams;
  const registerAgent = firstParam(agent) ?? null;
  // The runtime Add a runtime named, chosen on the name step (ADR-198).
  const registerRuntime = firstParam(runtime) ?? null;
  return (
    <RegisterGate ctx={ctx} step={registerStep} agent={registerAgent}>
      {/* The record here is the agent being registered, not the step: the path
          segment after the route is `name`, `wrap` or `run`. */}
      <PageRecord route="register" id={registerAgent} />
      <Suspense fallback={<RegisterSkeleton />}>
        <RegisterAgent
          ctx={ctx}
          source={dataSource()}
          step={registerStep}
          agent={registerAgent}
          runtime={registerRuntime}
        />
      </Suspense>
    </RegisterGate>
  );
}
