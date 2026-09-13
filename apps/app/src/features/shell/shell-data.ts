// What the server hands the client shell: the port's reads, still as `Read<T>`
// so every client piece renders its own honest state.
import type { Read } from "@/data/not-backed";
import type {
  AccountView,
  AssistantEngine,
  CommandRun,
  NavCounts,
  NotificationFeed,
  ShellContext,
} from "./contracts";

export type ShellData = {
  /** The organization slug from the URL; the fallback name when the context read failed. */
  org: string;
  context: Read<ShellContext>;
  counts: Read<Record<string, NavCounts>>;
  notifications: Read<NotificationFeed>;
  engine: Read<AssistantEngine>;
  runs: CommandRun[];
  account: Read<AccountView>;
};

/**
 * The workspace the sidebar's workspace section points at: the one in the URL
 * when it is known, otherwise the first workspace of the organization. On a
 * failed context read the URL's workspace is used as-is (the page's own guard
 * decides whether it exists); with neither, the section is omitted.
 */
export function activeWorkspace(
  data: Pick<ShellData, "context">,
  urlWs: string | null,
): string | null {
  if (!data.context.ok) return urlWs;
  const { workspaces } = data.context.value;
  if (urlWs !== null && workspaces.some((w) => w.slug === urlWs)) return urlWs;
  return workspaces[0]?.slug ?? null;
}
