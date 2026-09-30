"use server";
// The Studio draft writes and read the Changes tab makes (#4678, item 6),
// each through the kernel seam for the workspace viewer the URL names. They
// are lane M11's capabilities (#4686, shipped in #4688): save_studio_draft
// stores the tab's edits, get_studio_draft reads the stored draft after a
// save conflict, and open_studio_review opens one steering PR from it.
//
// Each handler checks the role itself (an org Owner or Admin, or a workspace
// Owner), and each is `noBillingGate`, so there is no second gate here. A
// refusal comes back with the handler's reason as its code, and the tab
// names it where the person acted.
//
// The Changes tab's save sends neither `serverToml` nor `source`. The
// definition comes from the server's steering folder, which the page reads
// once the Studio record is bound (#4678). Until then a draft that imports a
// tool reads as "definition not recorded" (sourceRequired).
//
// The rest are Studio's other capabilities (#4678 part 3), which replaced the
// typed stubs part 2 drew against: discovery (lane M10, #4682), and Try it,
// Draft, findings and named credentials (#4742). studio-calls.ts binds each to
// the page's workspace. Each handler gates the role itself. try_studio_tool is
// metered as a governed action and draft_studio_description as in-app agent
// spend, so both go through kernelWrite, whose result names an exhausted
// budget.
//
// Add server's From a definition sends both (saveNewStudioServerAction): the
// server.toml Studio wrote and the definition the person uploaded, with no
// edits. The first save is at revision 0. Review then opens the steering PR
// that creates the server's folder (ADR-224). When Review refuses, the
// dialog saves again at the revision the first save returned, so a retry
// replaces that draft instead of starting a new one.
import {
  type ToolStudioCredentialSetInput,
  type ToolStudioCredentialSetOutput,
  toolStudioCredentialSet,
} from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import {
  type ToolStudioDescriptionDraftOutput,
  toolStudioDescriptionDraft,
} from "@oxagen/oxagen/contracts/tool.studio.description.draft";
import {
  type ToolStudioDiscoveryGetOutput,
  toolStudioDiscoveryGet,
} from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import {
  type ToolStudioDiscoveryStartOutput,
  toolStudioDiscoveryStart,
} from "@oxagen/oxagen/contracts/tool.studio.discovery.start";
import {
  type ToolStudioDraftGetOutput,
  toolStudioDraftGet,
} from "@oxagen/oxagen/contracts/tool.studio.draft.get";
import {
  type StudioDraftOp,
  type StudioSource,
  type ToolStudioDraftSaveOutput,
  toolStudioDraftSave,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import {
  type ToolStudioFindingsListOutput,
  toolStudioFindingsList,
} from "@oxagen/oxagen/contracts/tool.studio.findings.list";
import {
  type ToolStudioReviewOpenOutput,
  toolStudioReviewOpen,
} from "@oxagen/oxagen/contracts/tool.studio.review.open";
import {
  type ToolStudioServerGetOutput,
  toolStudioServerGet,
} from "@oxagen/oxagen/contracts/tool.studio.server.get";
import {
  type ToolStudioToolsListOutput,
  toolStudioToolsList,
} from "@oxagen/oxagen/contracts/tool.studio.tools.list";
import {
  type ToolStudioTryInput,
  type ToolStudioTryOutput,
  toolStudioTry,
} from "@oxagen/oxagen/contracts/tool.studio.try";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/**
 * Save the tab's edits as the server's draft. `revision` is the stored
 * revision the edits build on, 0 for a draft never saved, so a save over a
 * newer draft is refused with `draft_revision_stale` instead of overwriting it.
 */
export async function saveStudioDraftAction(
  org: string,
  ws: string,
  draft: {
    server: string;
    serverId?: string;
    ops: readonly StudioDraftOp[];
    revision: number;
  },
): Promise<ActionResult<ToolStudioDraftSaveOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioDraftSave, {
    server: draft.server,
    ...(draft.serverId === undefined ? {} : { serverId: draft.serverId }),
    ops: [...draft.ops],
    revision: draft.revision,
  });
}

/**
 * Save the draft of a server that has no folder yet: its server.toml and its
 * definition, with no edits. The first save sends revision 0, which refuses
 * with `draft_revision_stale` when a draft of that name is already stored,
 * so a new server never overwrites someone's draft. A retry after a refused
 * Review sends the revision and server id that save returned.
 */
export async function saveNewStudioServerAction(
  org: string,
  ws: string,
  draft: {
    server: string;
    serverId?: string;
    serverToml: string;
    source: StudioSource;
    revision: number;
  },
): Promise<ActionResult<ToolStudioDraftSaveOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioDraftSave, {
    server: draft.server,
    ...(draft.serverId === undefined ? {} : { serverId: draft.serverId }),
    ops: [],
    serverToml: draft.serverToml,
    source: draft.source,
    revision: draft.revision,
  });
}

/** The server's stored draft, or null when none is stored. */
export async function getStudioDraftAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioDraftGetOutput>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolStudioDraftGet,
    input: { server },
    page: "tools",
  });
  return readToActionResult(read);
}

/**
 * Review: open one steering PR from the stored draft at `revision`, or add a
 * commit to the one an earlier Review opened. A newer stored draft is
 * refused with `draft_revision_stale`.
 */
export async function openStudioReviewAction(
  org: string,
  ws: string,
  review: { server: string; revision: number },
): Promise<ActionResult<ToolStudioReviewOpenOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioReviewOpen, {
    server: review.server,
    revision: review.revision,
  });
}

/** Ask for a discovery of one server now. */
export async function startStudioDiscoveryAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioDiscoveryStartOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioDiscoveryStart, { server });
}

/** One server's latest discovery, or null before the first one. */
export async function getStudioDiscoveryAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioDiscoveryGetOutput>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolStudioDiscoveryGet,
    input: { server },
    page: "tools",
  });
  return readToActionResult(read);
}

/** One server's tools: its tools.toml keys, then the tools no key imports. */
export async function listStudioToolsAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioToolsListOutput>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolStudioToolsList,
    input: { server },
    page: "tools",
  });
  return readToActionResult(read);
}

/** Call one imported tool from the Test tab. */
export async function tryStudioToolAction(
  org: string,
  ws: string,
  input: ToolStudioTryInput,
): Promise<ActionResult<ToolStudioTryOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioTry, input);
}

/** Draft one tool's description with the in-app agent. It saves nothing. */
export async function draftStudioDescriptionAction(
  org: string,
  ws: string,
  input: { server: string; tool: string },
): Promise<ActionResult<ToolStudioDescriptionDraftOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioDescriptionDraft, input);
}

/** The tool checks' findings on one server's draft, or on its folder. */
export async function listStudioFindingsAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioFindingsListOutput>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolStudioFindingsList,
    input: { server },
    page: "tools",
  });
  return readToActionResult(read);
}

/**
 * Store a named credential. The secret crosses this call once and never
 * comes back: the output names the credential and its reference only.
 */
export async function setMcpCredentialAction(
  org: string,
  ws: string,
  input: ToolStudioCredentialSetInput,
): Promise<ActionResult<ToolStudioCredentialSetOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, toolStudioCredentialSet, input);
}

/**
 * One server folder as the server page draws it: server.toml, each key's
 * shaping, and the tool catalog, from one read of the production branch.
 */
export async function getStudioServerAction(
  org: string,
  ws: string,
  server: string,
): Promise<ActionResult<ToolStudioServerGetOutput>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolStudioServerGet,
    input: { server },
    page: "tools",
  });
  return readToActionResult(read);
}
