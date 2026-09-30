# ADR-233: A machine-run server is pinned before it first runs

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** mcp-studio
- **Amends:** ADR-224 (how a new folder gets its first tools)
- **Related:** issue #4756, issue #4772, issue #4678, issue #4682, PR #4844,
  `packages/handlers/src/mcp-studio/import/build.ts`,
  `packages/handlers/src/mcp-studio/import/source.ts`,
  `packages/handlers/src/mcp-studio/discovery/seams.ts`,
  `packages/tacho/src/collector/local-servers/digest.ts`.

## Context

A server that runs on an enrolled machine is a `local` server, or a
`registry` server whose `server.toml` names `source.machines`. The local
gateway starts one only when the digest of what it would run matches the
digest pinned in the lock (mcp-studio-spec, Local servers). The lock's
package is `{ name, version, digest }`, and `launchSpecFor` hands it to the
machine.

Studio cannot add either kind (#4756). Review builds a new folder from the
draft's source, the tools the server offers. A machine-run server's tools
come only from `tools/list` on a machine, and the machine runs nothing
without a pin.

Three facts from the code decide the shape:

- **A lock lists imported tools.** `lock()` iterates the compiled tools,
  which are `tools.toml`'s entries. Tools a server offers and nobody imported
  are not in the lock. They are in discovery's snapshots.
- **An import needs a classification.** `buildFolder` refuses an imported
  tool with no risk, side effect, and egress. A person classifies a tool
  after seeing it, so the tools must reach Studio before Review.
- **Review already takes a local source.** `importMcp` parses a draft's MCP
  source whose `lockSource` is `{ type: "local", command, package }`, and
  `sourceMismatch` accepts it for a `local` server. A draft that carries a
  real `tools/list` answer and a pinned lock source goes through Review's
  existing path and writes a lock with the imported tools.

Nothing in Oxagen resolves a digest today. `registryLockSource` throws
without one, and discovery answers `needs_digest` when a registry server on
machines has a newer catalog version. The machine resolves one: its digester
hashes npm's tarball, reads the SHA-256 the PyPI index publishes, hashes the
NuGet package, takes an OCI digest from the image reference, and hashes the
executable a local command resolves to.

A PyPI release is several files, one per platform and Python version, and the
launch runs `uvx name@version`, which installs whichever file fits the host.
The digester collects the SHA-256 of every file in the release and accepts a
pin that matches any of them. So a pin taken from one file passes on a host
that installs another.

Discovery does not reach a machine in production. It runs in the API's
durable functions, the broker that holds the machines' connections runs in
the MCP service, and discovery's seams install `noLocalReporter` until that
reach exists (#4772).

## Decision

**The machine only ever checks a digest. It never supplies one.** Oxagen or
a person names the digest before anything runs, and the machine refuses to
start anything else.

### 1. Where the pin comes from

- **A registry package** (npm, PyPI, NuGet): Oxagen reads the digest from the
  public registry with the same reader the machine uses. A published file
  never changes under its name, so the machine's own read agrees with
  Oxagen's. Discovery reads it at each run, so a new catalog version no longer
  stops at `needs_digest`.
- **A PyPI release pins one file, not the version.** Oxagen selects the
  release's file that runs on every host: its `py3-none-any` wheel, or its
  source distribution when it has no such wheel. A release with neither is
  refused, as an OCI entry that pins no digest is. The lock records that
  file's name and SHA-256. The launch installs that file by its URL
  (`uvx --from <url> <name>`) in place of `uvx name@version`, so the host
  cannot pick another. The machine hashes the file the launch names and
  compares it with the pin. It no longer accepts a pin because some file in
  the release carries it.
- **An OCI image**: the digest the catalog entry's reference pins. An entry
  that pins none is refused, as it is today.
- **A local command**: the person names the version and the SHA-256 of the
  executable the command resolves to on the machine. The Local command form
  says how to read it.

### 2. A draft lists its tools on a machine before Review

Studio asks one connected machine in the draft's `source.machines` to start
the server with the draft's pin and answer `tools/list`. The machine checks
the digest before it starts anything, as it does for every call. Studio saves
the answer as the draft's MCP source, with the pinned lock source, and the
person classifies and imports tools as for a remote server.

The listing reaches the machine through the same broker path discovery uses,
so it waits on #4772. It uses the same wait discovery uses, with no third
wait.

### 3. Review is unchanged

The draft's source is an MCP source with a local or registry lock source, so
`buildFolder` takes its existing path. The folder always has a lock, and the
steering PR shows the pin to the reviewer. `readServerFiles`, `compileServed`,
`propose`, `diff`, and `list_studio_tools` keep their rule that a folder has a
lock.

### 4. A new executable is a new draft

The sync cannot move a local server's pin, because the pin would have to come
from the machine. A person changes the executable with a new draft that names
the new version and digest. A registry package moves with its catalog
version, because Oxagen reads that digest itself.

## Consequences

- Studio's Local command and registry package forms submit through a listing
  step, then the usual import and Review.
- The work ships in three pieces: this decision; the server-side digest
  reader, which retires `needs_digest`; and the draft listing with the two app
  forms, after #4772 gives a request in the API a way to reach a machine.
- #4756's definition of done is amended to this path.
- The PyPI rule changes the machine's reader and the lock's launch with the
  server-side reader. Until they ship, a PyPI package stays at `needs_digest`,
  because a pin the machine checks against every file of a release does not
  hold.

## Alternatives considered

- **Trust the digest a machine reports on its first run.** A machine that runs
  a changed or hostile executable would pin it, and the pin would then approve
  it on every other machine in the group. The check exists to stop that.
- **Review writes the folder with no lock, and discovery writes the first
  one.** A lock lists imported tools, and a new folder's `tools.toml` imports
  none, so the first run compiles no tools and writes no lock. Discovery
  cannot import tools itself, because an import needs a person's
  classification. It also needed a no-lock state through every reader of the
  folder.
- **A lock with `tools: []` from a source that claims no tools.** It states
  that the server offers nothing, and every reader of the draft believes it.
