// What the server hands the client shell: the organization and the person the
// organization layout's viewer resolved (ARCHITECTURE.md §3.1). Until WL-11
// binds `shell.context`, this is everything the shell knows: no organization
// list, no workspace list, no plan or data plane.
export type ShellData = {
  org: { slug: string; name: string };
  viewer: { name: string | null; email: string };
};
