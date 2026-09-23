// The Compiler: what one agent receives for one prompt (roadmap
// pages/steering.md; the tab body is pages/steering-compiler.md, which the
// steering-tabs lane builds). No read contract runs the assembler yet, so the
// tab names that and draws nothing it cannot back.
import { useTranslations } from "next-intl";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";

export function CompilerTab({ agent }: { agent: string | null }) {
  const t = useTranslations("steering.bodies.compiler");
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="tab-compiler"
      data-agent={agent ?? undefined}
    >
      <NotBacked
        testId="compiler-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.assembler}
      />
    </div>
  );
}
