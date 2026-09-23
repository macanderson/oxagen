// Assignments: which agent receives what (roadmap pages/steering.md; the tab
// body is pages/steering-assignments.md, which the steering-tabs lane builds).
// Today it carries the one read that answers part of the question, the
// per-run delivery report from the steering manifests, under the panel the
// assembler's registry has to back.
import { useTranslations } from "next-intl";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { Deliveries } from "../deliveries";
import { STEERING_GAPS } from "../gaps";
import { NotBacked } from "../not-backed";

export async function AssignmentsTab({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: DataSource;
}) {
  const read = await source.steering.deliveries(ctx);
  return <AssignmentsBody read={read} />;
}

function AssignmentsBody({
  read,
}: {
  read: Awaited<ReturnType<DataSource["steering"]["deliveries"]>>;
}) {
  const t = useTranslations("steering.bodies.assignments");
  return (
    <div className="flex flex-col gap-4" data-testid="tab-assignments">
      <NotBacked
        testId="assignments-not-backed"
        what={t("what")}
        issue={STEERING_GAPS.assembler}
      />
      <Deliveries read={read} />
    </div>
  );
}
