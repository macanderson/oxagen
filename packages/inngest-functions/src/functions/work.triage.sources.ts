// work.triage.sources.ts: where triage reads a workspace's setup.
//
// Triage reads four things other code owns: the [triage] model routes in
// work.toml, the priorities steering record work.toml names, the workflow
// files, and the file trees of the workspace's code repositories. The code
// that owns them registers one TriageSources when the worker boots. Until it
// does, work.triage.item stops each run with a NonRetriableError that says
// what is missing, and the item stays new.
import { NonRetriableError } from "@oxagen/functions";
import type { TenantScope } from "@oxagen/tenancy";
import type {
  TriageFileTree,
  TriagePriorities,
  TriageWorkflowFile,
} from "@oxagen/work";

/** What triage reads from one workspace's steering repository. */
export interface TriageSetup {
  /** The [triage] models of work.toml, in order. */
  routes: readonly string[];
  /** The priorities record work.toml names, at the version on main. */
  priorities: TriagePriorities;
  /** Every workflow file in work/workflows/. */
  workflows: readonly TriageWorkflowFile[];
  /** The file tree of each code repository the workspace links. */
  fileTrees: readonly TriageFileTree[];
}

/** Reads a workspace's triage setup. */
export interface TriageSources {
  /** The setup, or null when the workspace has no work.toml. */
  setup(scope: TenantScope): Promise<TriageSetup | null>;
}

let registered: TriageSources | null = null;

/** Registers the setup reader. Null clears it. */
export function setTriageSources(sources: TriageSources | null): void {
  registered = sources;
}

/** The registered setup reader. Throws a NonRetriableError when none is registered. */
export function triageSources(): TriageSources {
  if (registered === null) {
    throw new NonRetriableError(
      "No triage setup reader is registered, so triage cannot read work.toml, the priorities record, the workflow files, or the file trees. Call setTriageSources when the worker boots.",
    );
  }
  return registered;
}
