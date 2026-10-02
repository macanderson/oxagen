// The Repositories page's section for the statements in linked code
// repositories' instruction files that repeat or contradict a steering record
// (#4518, ADR-263). Each repository with a finding lists it, and a
// contradiction offers Promote to steering (./instruction-drift). A read that
// fails says why in the section's place. When the read answers and nothing
// differs, the section draws nothing.
import "server-only";
import { useTranslations } from "next-intl";
import type { WsCtx } from "@/server/viewer";
import { useRepositoriesFailure } from "./failure";
import { InstructionDriftWarning } from "./instruction-drift";
import {
  type CodeRepositoryFindingsRead,
  readCodeRepositoryFindings,
} from "./instruction-findings-read";
import { Panel, PanelBody, prose } from "./parts";

const FINDINGS_CAPABILITY = "list_code_repository_findings";

export async function InstructionFindings({ ctx }: { ctx: WsCtx }) {
  const read = await readCodeRepositoryFindings(ctx);
  return <FindingsPanel org={ctx.orgSlug} ws={ctx.wsSlug} read={read} />;
}

function FindingsPanel({
  org,
  ws,
  read,
}: {
  org: string;
  ws: string;
  read: CodeRepositoryFindingsRead;
}) {
  const t = useTranslations("repositories.drift");
  const failureText = useRepositoriesFailure();
  const drifted =
    read.kind === "ok"
      ? read.repositories.filter((r) => r.findings.length > 0)
      : [];
  if (read.kind === "ok" && drifted.length === 0) return null;
  return (
    <Panel
      id="instruction-findings"
      title={t("heading")}
      testId="instruction-findings"
    >
      <PanelBody>
        {read.kind === "failed" ? (
          <p
            role="alert"
            data-testid="instruction-findings-failure"
            className={prose}
          >
            {failureText(read.failure, FINDINGS_CAPABILITY)}
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {drifted.map((repository) => (
              <li
                key={repository.repositoryId}
                data-testid="instruction-findings-repository"
                data-repository={repository.repositoryId}
                className="flex flex-col gap-2"
              >
                <p className="text-[13px] font-medium text-foreground">
                  {repository.fullName}
                </p>
                <InstructionDriftWarning
                  org={org}
                  ws={ws}
                  findings={repository.findings}
                />
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}
