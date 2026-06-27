import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { readMemoryPolicyAction } from "./actions";
import { MemoryPolicyForm } from "./memory-policy-form";

export default async function MemorySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const org = await resolveOrg(orgSlug);
  await resolveWorkspace(org.id, workspaceSlug);

  const policy = await readMemoryPolicyAction({ orgSlug, workspaceSlug });

  return (
    <MemoryPolicyForm
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initialHalfLifeLow={policy.halfLifeLowDays}
      initialHalfLifeHigh={policy.halfLifeHighDays}
      initialRecallThreshold={policy.recallThreshold}
    />
  );
}
