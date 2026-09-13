// The write path for the pre-workspace flows: one agent tool call through the
// kernel, with its output parsed against the contract instead of cast.
//
// Fixture mode refuses: instrumentation skips the IAM and billing bootstraps
// there, so the kernel would fall open.
//
// Promote: this is lane L4's `invokeTool` (src/server/invoke.ts) for callers
// that have no Viewer yet (the invitee is not a member of the org it joins).
// Replace it with invokeTool once L4 merges.
import "server-only";
import { isFixtureMode } from "@/server/fixture-session";

export class FixtureWriteRefused extends Error {
  readonly code = "fixture_write_refused";

  constructor(readonly tool: string) {
    super(`fixture mode refuses the write ${tool}`);
    this.name = "FixtureWriteRefused";
  }
}

/** Structural, so the app's zod 4 never has to agree with the contracts' zod 3. */
export type ToolContract<O> = {
  name: string;
  output: { parse(value: unknown): O };
};

export type KernelScope = { orgId: string; workspaceId: string };

/** The sentinel workspace for organization-level calls (matches apps/app_deprecated). */
export const ORG_ONLY_WORKSPACE = "00000000-0000-0000-0000-000000000000";

export async function invokeAsUser<O>(
  contract: ToolContract<O>,
  input: unknown,
  scope: KernelScope,
  userId: string,
): Promise<O> {
  if (isFixtureMode()) throw new FixtureWriteRefused(contract.name);
  await import("@oxagen/handlers/register");
  const [{ invoke }, { runInTenantScope }] = await Promise.all([
    import("@oxagen/oxagen"),
    import("@oxagen/tenancy"),
  ]);
  const raw = await runInTenantScope(scope, () =>
    invoke(contract.name, input, {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    }),
  );
  return contract.output.parse(raw);
}
