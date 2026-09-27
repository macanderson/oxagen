// The Repositories page's section for instruction files that drifted from the
// steering records (#4518). Each code repository with a drifted file lists it
// with Promote to steering (./instruction-drift). While no capability backs
// the read, the section names the capability and lists nothing. When the read
// answers and no file drifted, the section draws nothing.
import "server-only";
import { useTranslations } from "next-intl";
import type { WsCtx } from "@/server/viewer";
import { InstructionDriftWarning } from "./instruction-drift";
import {
  type CodeRepositoryFindingsRead,
  readCodeRepositoryFindings,
} from "./instruction-findings-read";
import { code, Panel, PanelBody, prose } from "./parts";

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
        {read.kind === "not_backed" ? (
          <p
            data-testid="instruction-findings-unavailable"
            data-not-backed=""
            data-capability={read.capability}
            className={prose}
          >
            {t.rich("notBacked", { capability: read.capability, code })}
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {drifted.map((repository) => (
              <li
                key={repository.repositoryId}
                data-testid="instruction-findings-repository"
                className="flex flex-col gap-2"
              >
                <p className="text-[13px] font-medium text-foreground">
                  {repository.fullName}
                </p>
                <InstructionDriftWarning
                  org={org}
                  ws={ws}
                  repositoryId={repository.repositoryId}
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
