/**
 * Shared org + workspace picker logic used by both `oxagen login` and
 * `oxagen init`. Extracted here so neither command duplicates the interactive
 * selection flow or the API calls.
 *
 * Resolution strategy (same for both commands):
 *   1. If the caller passed an explicit --org / --workspace flag, look it up
 *      and validate it belongs to the user — never assume.
 *   2. If there is exactly one option, auto-select it and print a confirmation.
 *   3. If there are multiple options, prompt the user with a numbered list.
 *   4. If there are zero options, give a clear error pointing at the app.
 *
 * All network calls go through `userApiPostOrThrow` (user-scoped, token-only —
 * no org/workspace in the path).
 */
import * as readline from "node:readline/promises";
import { userApiPostOrThrow } from "./api.js";

// ── Types (mirrors the org.list + workspace.list contract output) ─────────────

export interface OrgListItem {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  role: string;
  avatarUrl: string | null;
}

export interface WorkspaceListItem {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  role: string | null;
}

export interface LinkedAccount {
  orgId: string;
  orgSlug: string;
  orgName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Print a numbered list of `items` and prompt the user to choose one.
 * `render` turns an item into a single display string.
 * Loops until the user enters a valid number in range.
 * Throws when not in a TTY (caller must guard).
 */
export async function promptChoice<T>(
  question: string,
  items: T[],
  render: (item: T, index: number) => string,
  isTTY: boolean,
): Promise<T> {
  if (!isTTY) {
    throw new Error(
      "Cannot prompt interactively in non-TTY mode. " +
        "Pass --org / --workspace flags or run in an interactive terminal.",
    );
  }
  process.stdout.write(`\n${question}\n`);
  items.forEach((item, i) => {
    process.stdout.write(
      `  ${String(i + 1).padStart(2)}. ${render(item, i)}\n`,
    );
  });
  let choiceIndex: number;
  for (;;) {
    const raw = await promptLine(`Select [1-${items.length.toString()}]: `);
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= items.length) {
      choiceIndex = n - 1;
      break;
    }
    process.stdout.write(
      `  Please enter a number between 1 and ${items.length.toString()}.\n`,
    );
  }
  return items[choiceIndex] as T;
}

// ── Org picker ────────────────────────────────────────────────────────────────

/**
 * Resolve an org for the authenticated user.
 *
 * - If `orgSlug` is supplied: look it up by slug and return it (error if absent).
 * - If one org:  auto-select and print confirmation.
 * - If many orgs: prompt the user to pick one.
 * - If zero orgs: throw with a helpful link.
 */
export async function resolveOrg(opts: {
  orgSlug?: string;
  isTTY: boolean;
}): Promise<OrgListItem> {
  const { organizations } = await userApiPostOrThrow<{
    organizations: OrgListItem[];
  }>("organizations", {});

  if (organizations.length === 0) {
    throw new Error(
      "You have no organizations. Create one at https://app.oxagen.sh, " +
        "then run `oxagen login` again.",
    );
  }

  if (opts.orgSlug) {
    const org = organizations.find((o) => o.slug === opts.orgSlug);
    if (!org) {
      const available = organizations.map((o) => o.slug).join(", ");
      throw new Error(
        `Organization "${opts.orgSlug}" not found. Available: ${available}`,
      );
    }
    return org;
  }

  if (organizations.length === 1) {
    const org = organizations[0]!;
    process.stdout.write(`  Organization: ${org.name} (${org.slug})\n`);
    return org;
  }

  return promptChoice(
    "Select an organization:",
    organizations,
    (o) => `${o.name}  (${o.slug})  — ${o.role}`,
    opts.isTTY,
  );
}

// ── Workspace picker ──────────────────────────────────────────────────────────

/**
 * Resolve a workspace within the given org.
 *
 * - If `workspaceSlug` is supplied: look it up and return it (error if absent).
 * - If one workspace: auto-select and print confirmation.
 * - If many: prompt the user to pick.
 * - If zero: throw with a helpful link.
 */
export async function resolveWorkspace(opts: {
  orgSlug: string;
  workspaceSlug?: string;
  isTTY: boolean;
}): Promise<{
  org: { id: string; publicId: string; slug: string; name: string };
  workspace: WorkspaceListItem;
}> {
  const result = await userApiPostOrThrow<{
    organization: { id: string; publicId: string; slug: string; name: string };
    workspaces: WorkspaceListItem[];
  }>("workspaces", { orgSlug: opts.orgSlug });

  const { organization, workspaces } = result;

  if (workspaces.length === 0) {
    throw new Error(
      `Organization "${opts.orgSlug}" has no workspaces. ` +
        `Create one at https://app.oxagen.sh.`,
    );
  }

  if (opts.workspaceSlug) {
    const ws = workspaces.find((w) => w.slug === opts.workspaceSlug);
    if (!ws) {
      const available = workspaces.map((w) => w.slug).join(", ");
      throw new Error(
        `Workspace "${opts.workspaceSlug}" not found in org "${opts.orgSlug}". ` +
          `Available: ${available}`,
      );
    }
    process.stdout.write(`  Workspace:    ${ws.name} (${ws.slug})\n`);
    return { org: organization, workspace: ws };
  }

  if (workspaces.length === 1) {
    const ws = workspaces[0]!;
    process.stdout.write(`  Workspace:    ${ws.name} (${ws.slug})\n`);
    return { org: organization, workspace: ws };
  }

  const ws = await promptChoice(
    `Select a workspace in ${opts.orgSlug}:`,
    workspaces,
    (w) => `${w.name}  (${w.slug})${w.role ? `  — ${w.role}` : ""}`,
    opts.isTTY,
  );
  return { org: organization, workspace: ws };
}

// ── Combined picker ───────────────────────────────────────────────────────────

/**
 * Run the full org → workspace selection flow and return a `LinkedAccount`.
 * Both `oxagen login` and `oxagen init` call this so the UX is identical.
 */
export async function resolveLinkedAccount(opts: {
  orgSlug?: string;
  workspaceSlug?: string;
  isTTY: boolean;
}): Promise<LinkedAccount> {
  const org = await resolveOrg({ orgSlug: opts.orgSlug, isTTY: opts.isTTY });
  const { org: orgDetails, workspace } = await resolveWorkspace({
    orgSlug: org.slug,
    workspaceSlug: opts.workspaceSlug,
    isTTY: opts.isTTY,
  });
  return {
    orgId: orgDetails.id,
    orgSlug: org.slug,
    orgName: org.name,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
  };
}
