// What the server hands the client shell: the organization and the person the
// organization layout's viewer resolved (ARCHITECTURE.md §3.1), and the
// `shell.context` read the org and workspace switchers list (WL-32 renders
// its lists and its denied and error states).
import type { ShellContext } from "@/data/contracts/shell";
import type { Read } from "@/data/read";

export type ShellData = {
  org: { slug: string; name: string };
  viewer: { name: string | null; email: string };
  context: Read<ShellContext>;
};
