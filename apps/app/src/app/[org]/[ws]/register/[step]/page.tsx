import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dataSource } from "@/data/source";
import { parseRegisterStep, RegisterAgent } from "@/features/onboarding";
import { PageRecord } from "@/features/shell";
import { requireViewer } from "@/server/viewer";
import { firstParam } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("register") };
}

// Register an agent, one step per segment (#2967, ADR-065 decision 1). A
// segment that names no step is a 404, so the flow has three addresses and no
// catch-all.
export default async function RegisterPage({
  params,
  searchParams,
}: PageProps<"/[org]/[ws]/register/[step]">) {
  const { org, ws, step } = await params;
  const ctx = await requireViewer(org, ws);
  const registerStep = parseRegisterStep(step);
  if (registerStep === null) notFound();
  const { agent } = await searchParams;
  const registerAgent = firstParam(agent) ?? null;
  const t = await getTranslations("pages");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-10"
    >
      {/* The record here is the agent being registered, not the step: the path
          segment after the route is `name`, `wrap` or `run`. */}
      <PageRecord route="register" id={registerAgent} />
      <PageHeader
        eyebrow={t("workspaceEyebrow", { workspace: ctx.wsName })}
        title={t("register")}
      />
      <RegisterAgent
        ctx={ctx}
        source={dataSource()}
        step={registerStep}
        agent={registerAgent}
      />
    </main>
  );
}
