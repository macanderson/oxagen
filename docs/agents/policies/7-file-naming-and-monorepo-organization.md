# 7. File Naming and Monorepo Organization

### 7.1 Domain-Layer Organization

- **Organize by domain, never by technical layer.** This is a non-negotiable. There is no flat `models/` folder holding every model in a package, and no flat `routes/` folder holding every endpoint. Those are forbidden anti-patterns.
- Code for a capability lives together. A domain owns its schema, its logic, its endpoint, its tools, and its tests in one cohesive location. To understand a feature you open one folder, not five.
- Within a domain, separate concerns by file, not by scattering across the package: the persistence model, the business logic, the transport binding, and the types each get their own file inside the domain folder.
- Apps consume shared packages; packages never import from apps. Dependency direction is one-way, app to package. No circular dependencies; the build graph is a DAG.

### 7.2 Type Organization

- **Strict types everywhere, no exceptions** (Section 0). No `any`, no untyped boundaries, no silent `type: ignore`.
- A type used in exactly one place is colocated, but never inline-cluttering the logic file. Put it in a sibling types file next to the code that uses it (e.g. `widget.py` ↔ `widget_types.py`, or `Widget.tsx` ↔ `Widget.types.ts`).
- A type used by more than one module moves up to the nearest shared scope: the domain's own types file if it stays in one domain, or a shared package if it crosses domains.
- Never reach down into another domain's private types file. Cross-domain types are exported deliberately from the shared package.

### 7.3 Thin Wrappers, Shared Logic

- **API, CLI, and MCP services are thin wrappers. This is a non-negotiable.** They parse input, call into a shared package, and format output. Nothing more.
- Business logic lives in `packages/` exactly once and is never reproduced in a service. If the same capability is reachable via the API, the CLI, and the MCP server, all three call the identical shared function.
- A service file that contains real logic instead of delegating to a package is a defect, regardless of how small the logic is.

### 7.4 Auto-Discovery Over Wiring

- Services, tools, schemas, and skills are auto-discovered wherever the framework allows it. Adding a new endpoint, tool, schema, or skill means dropping a correctly-located, correctly-named file, not editing a central registry.
- Prefer convention-based discovery to hand-maintained manifests. A registry that a human must remember to update is a source of drift; eliminate it.
- Where a registry is genuinely unavoidable, generate it from the filesystem at build or startup, never maintain it by hand.

### 7.5 API Versioning

- **Every API endpoint is versioned** under a version prefix (`/v1`, `/v2`). This is a non-negotiable. No unversioned routes exist.
- Breaking changes ship as a new version. The prior version stays alive until consumers migrate and it is formally deprecated with a removal date.
- Versioning lives at the routing seam, not in the shared logic. The shared package exposes one current implementation; the thin version wrappers adapt it.

### 7.6 Layout and Naming

- Standard top-level shape:
  - `packages/` shared libraries, adapters, domain primitives, the single source of reusable logic.
  - `services/api` FastAPI backend, thin `/v1`-prefixed routes.
  - `services/worker` async and scheduled jobs.
  - `services/app` Next.js App Router frontend.
- Naming:
  - Python modules and files: `snake_case`.
  - TypeScript/React component files: `PascalCase` for components, `camelCase` for utilities, `kebab-case` for route segments per Next.js convention.
  - Sibling type files follow the conventions in Section 7.2.
  - Test files sit beside the code they test or in a parallel `tests/` tree, named to match the unit under test.
- One concept per file. No grab-bag `utils.py` or `helpers.ts` that accretes unrelated functions. Name files for what they contain.
- Tooling is fixed: pnpm and Turborepo for Node, uv for Python. Do not introduce a competing package manager or build orchestrator.
