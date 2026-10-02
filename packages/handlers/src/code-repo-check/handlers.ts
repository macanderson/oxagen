// code-repo-check/handlers.ts: list_code_repository_findings and
// promote_instruction_to_steering over the production deps (S7, #4518;
// ADR-263). register.ts loads this module lazily, so importing it opens no
// client until a call needs one.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { codeRepositoryFindingsList } from "@oxagen/oxagen/contracts/repository.findings.list";
import { instructionPromote } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { openSteeringPrHandler } from "../steering.pr.open";
import { postgresSteeringStore } from "../context.steering.store";
import { assertContractRole } from "../lib/capability-role-guard";
import { codeRepoCheckDeps } from "./deps";
import { createListCodeRepositoryFindingsHandler } from "./findings.list";
import { createPromoteInstructionHandler } from "./promote";
import { postgresCodeRepoFindingStore } from "./store";

export const listCodeRepositoryFindingsHandler: CapabilityHandler<
  typeof codeRepositoryFindingsList
> = createListCodeRepositoryFindingsHandler({
  store: postgresCodeRepoFindingStore,
  publishedRecords: codeRepoCheckDeps.publishedRecords,
  // The guard answers the role it found. The handler needs only the refusal.
  assertRole: async (ctx) => {
    await assertContractRole(codeRepositoryFindingsList, ctx);
  },
});

export const promoteInstructionHandler: CapabilityHandler<
  typeof instructionPromote
> = createPromoteInstructionHandler({
  findings: postgresCodeRepoFindingStore,
  publishedRecords: codeRepoCheckDeps.publishedRecords,
  steering: postgresSteeringStore,
  openPr: (input, ctx) => openSteeringPrHandler(input, ctx),
  assertRole: async (ctx) => {
    await assertContractRole(instructionPromote, ctx);
  },
});
