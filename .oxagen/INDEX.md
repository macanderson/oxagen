# Oxagen Memory Index

**Purpose:** Central navigation hub for all documentation and procedural memories.

---

## Quick Start

**New to the codebase?** Start here:
1. Read [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md) - Complete system overview
2. Review [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md) - Architectural patterns
3. Scan [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) - Avoid common mistakes

**Building a feature?** Jump to:
- [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md) - Step-by-step procedures

---

## Documentation Structure

### Core Documentation

#### [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md)
**Complete reference documentation for the Oxagen platform**

Topics covered:
- Repository structure (apps, packages, tools)
- Tech stack breakdown
- Key concepts (capabilities, kernel, storage boundaries)
- Development workflow (setup, daily dev, testing)
- Adding features (capabilities, schemas, jobs, connectors)
- Testing standards (unit, integration, E2E)
- Coding standards (TypeScript, ESLint, imports)
- Database operations (migrations, seeding)
- Environment variables
- Common commands reference
- Troubleshooting guide

**When to use:** First stop for understanding the system or looking up commands.

---

#### [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md)
**Fast lookup for architectural decisions, patterns, and boundaries**

Topics covered:
- System architecture (kernel, surfaces, gates)
- Storage boundaries (PostgreSQL vs Neo4j vs ClickHouse)
- Package architecture (layers, dependencies)
- Tenancy architecture (multi-tenant hierarchy, scope enforcement)
- IAM architecture (policy resolution, role hierarchy)
- Capability system (contracts, surfaces, handler registration)
- Data flow patterns (sync, async, ingestion)
- Database schema organization (16 Postgres schemas)
- Agent architecture (execution flow, tool materialization)
- Billing architecture (credit-based metering, pricing)
- Testing architecture (test pyramid, file locations)
- Security patterns (auth, authz, encryption)
- Performance patterns (query optimization, caching, streaming)
- Deployment architecture (Vercel, env vars)
- Common patterns cheat sheet
- ADR quick reference
- Debugging checklist

**When to use:** Looking up architectural patterns, understanding system boundaries, finding the right place for new code.

---

#### [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
**Step-by-step procedures for common development tasks**

Procedures included:
1. **Adding a New Capability** - Complete walkthrough from contract to tests
2. **Creating Database Migrations** - Atlas-based migration workflow
3. **Building UI Components** - Re-export pattern, design tokens, testing
4. **Implementing Background Jobs** - Inngest functions, idempotency
5. **Adding Connectors** - Webhook verification, normalization, preview
6. **Writing Tests** - Unit, integration, E2E patterns
7. **Debugging Issues** - Systematic troubleshooting approach
8. **Performance Optimization** - Measuring, identifying bottlenecks, fixing

**When to use:** Building a specific type of feature. Follow the procedure step-by-step.

---

#### [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md)
**Catalog of common mistakes and their solutions**

Categories covered:
- **Database & Schema** - Tenant scoping, migrations, N+1 queries, target verification
- **Capability System** - Barrel exports, handler registration, defaultEffect, surface mismatches
- **UI & Components** - Import patterns, design tokens, client vs server components
- **Testing** - State clearing, skip/only, screenshots, coverage thresholds
- **Background Jobs** - Idempotency, non-retriable errors
- **Environment & Configuration** - Variable declaration, hardcoded config
- **Git & Version Control** - Gate requirement, secrets, large files
- **Performance** - Client fetching, indexes, overfetching
- **Security** - SQL injection, sensitive logs, input validation
- **TypeScript** - Using `any`, missing return types, non-null assertions
- **Debugging Tips** - Using debugger, checking logs, reproducing locally

**When to use:** Hit an error? Check here first. Reviewing before committing? Scan the checklists.

---

## External Documentation

### Primary Docs

| Document | Location | Purpose |
|----------|----------|---------|
| **README.md** | [../README.md](../README.md) | Product overview, vision, getting started |
| **CONTRIBUTING.md** | [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution guidelines, standards |
| **AGENTS.md** | [../AGENTS.md](../AGENTS.md) | Agent coder quick reference |
| **CONTEXT_ENGINE_SPEC.md** | [../CONTEXT_ENGINE_SPEC.md](../CONTEXT_ENGINE_SPEC.md) | CLI context engine design |
| **CLAUDE.md** | [../CLAUDE.md](../CLAUDE.md) | Engineering operating rules (optional read) |

### Architecture Decision Records

**Location:** [../docs/adr/](../docs/adr/)

Key ADRs:
- [ADR-001](../docs/adr/ADR-001-drizzle-as-postgres-orm.md) - Drizzle ORM
- [ADR-002](../docs/adr/ADR-002-inngest-as-job-orchestration.md) - Inngest for jobs
- [ADR-003](../docs/adr/ADR-003-neo4j-as-vector-store.md) - Neo4j for graph
- [ADR-009](../docs/adr/ADR-009-unified-capability-tool-model.md) - Unified capability model
- [ADR-012](../docs/adr/ADR-012-connector-dual-write-pattern.md) - Dual-write pattern
- [ADR-015](../docs/adr/ADR-015-graph-edge-driven-git-hooks-and-biome.md) - Import-graph hooks

Full list: [../docs/adr/README.md](../docs/adr/README.md)

### Detailed Component Documentation

**Location:** [../.agents/summary/](../.agents/summary/)

- `index.md` - Full documentation index with routing guide
- `architecture.md` - Kernel, surfaces, gates
- `components.md` - Every package/app explained
- `interfaces.md` - Type signatures, routes, protocols
- `data_models.md` - All 16 Postgres schemas, Neo4j model
- `workflows.md` - Chat turn, ingestion, IAM, billing

### Capability Documentation

**Location:** [../docs/capabilities/](../docs/capabilities/)

Documentation for all 383 capabilities (contracts, inputs, outputs, IAM defaults).

---

## Common Workflows

### Starting a New Feature

1. Understand requirements
2. Check if capability or schema changes needed
3. Read relevant procedure in [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
4. Follow step-by-step
5. Verify with checklists
6. Run `pnpm gate`
7. Commit (don't push)

### Fixing a Bug

1. Reproduce locally
2. Check [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) for known issues
3. Follow "Debugging Issues" procedure in [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
4. Isolate root cause
5. Fix and add regression test
6. Run `pnpm gate`
7. Commit (don't push)

### Learning the Codebase

**Day 1:**
1. Read [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md) - Get the big picture
2. Run `pnpm dev` and explore running apps
3. Browse `packages/oxagen/src/contracts/` - See all capabilities

**Day 2:**
1. Read [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md) - Understand patterns
2. Explore database schema: `packages/database/src/schema/`
3. Read a few handlers: `packages/handlers/src/`

**Day 3:**
1. Pick a simple capability to understand end-to-end
2. Trace from contract → handler → tests
3. Try adding a small feature following procedures

**Ongoing:**
- Reference [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) when you hit issues
- Build muscle memory for common patterns
- Contribute back gotchas you discover

---

## Quick Reference by Task

### I need to...

| Task | Document | Section |
|------|----------|---------|
| **Understand the system** | MONOREPO_OVERVIEW.md | Executive Summary, Key Concepts |
| **Add a capability** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §1: Adding a New Capability |
| **Create a migration** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §2: Creating Database Migrations |
| **Build a UI component** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §3: Building UI Components |
| **Add a background job** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §4: Implementing Background Jobs |
| **Add a connector** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §5: Adding Connectors |
| **Write tests** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §6: Writing Tests |
| **Debug an issue** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §7: Debugging Issues |
| **Optimize performance** | PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md | §8: Performance Optimization |
| **Understand storage boundaries** | ARCHITECTURE_QUICK_REF.md | Storage Boundaries |
| **Understand tenancy** | ARCHITECTURE_QUICK_REF.md | Tenancy Architecture |
| **Understand IAM** | ARCHITECTURE_QUICK_REF.md | IAM Architecture |
| **Find a code pattern** | ARCHITECTURE_QUICK_REF.md | Common Patterns Cheat Sheet |
| **Fix an error I've seen before** | COMMON_GOTCHAS.md | (Search by error or category) |
| **Avoid common mistakes** | COMMON_GOTCHAS.md | (Read relevant category) |
| **Look up a command** | MONOREPO_OVERVIEW.md | Common Commands Reference |
| **Set up my environment** | MONOREPO_OVERVIEW.md | Development Workflow > Initial Setup |
| **Run the gate** | MONOREPO_OVERVIEW.md | Development Workflow > Before Every Push |
| **Understand a package** | ARCHITECTURE_QUICK_REF.md | Package Architecture |
| **Find database schema** | ARCHITECTURE_QUICK_REF.md | Database Schema Organization |

---

## Search Strategies

### By Error Message

1. Search [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) for error text
2. Check logs: `docker logs <container>`
3. Follow "Debugging Issues" procedure
4. If novel, document the solution

### By Technology

| Tech | Where to Look |
|------|---------------|
| **Drizzle** | [ADR-001](../docs/adr/ADR-001-drizzle-as-postgres-orm.md), ARCHITECTURE_QUICK_REF.md (Database) |
| **Inngest** | [ADR-002](../docs/adr/ADR-002-inngest-as-job-orchestration.md), PROCEDURAL_MEMORY §4 |
| **Neo4j** | [ADR-003](../docs/adr/ADR-003-neo4j-as-vector-store.md), ARCHITECTURE_QUICK_REF.md (Storage) |
| **Next.js** | PROCEDURAL_MEMORY §3, COMMON_GOTCHAS.md (UI) |
| **Testing** | MONOREPO_OVERVIEW.md (Testing Standards), PROCEDURAL_MEMORY §6 |

### By Feature Area

| Area | Where to Look |
|------|---------------|
| **Capabilities** | ARCHITECTURE_QUICK_REF.md (Capability System) |
| **Tenancy** | ARCHITECTURE_QUICK_REF.md (Tenancy Architecture) |
| **IAM** | ARCHITECTURE_QUICK_REF.md (IAM Architecture) |
| **Billing** | ARCHITECTURE_QUICK_REF.md (Billing Architecture) |
| **Agents** | ARCHITECTURE_QUICK_REF.md (Agent Architecture) |
| **Connectors** | PROCEDURAL_MEMORY §5 |

---

## Contribution Guidelines

### Adding to Memory

When you discover something new or fix a non-obvious issue:

1. **Gotchas:** Add to [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md)
   - Error message
   - Bad example
   - Good example
   - Rule/explanation

2. **Procedures:** Enhance [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
   - New procedure section
   - Additional steps to existing procedure
   - Better examples

3. **Architecture:** Update [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md)
   - New pattern discovered
   - Architectural decision changed
   - New system boundary

4. **Overview:** Update [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md)
   - New package added
   - Major system change
   - New workflow

### Memory Maintenance

- Review memory files monthly
- Remove outdated information
- Update version numbers
- Consolidate duplicate content
- Keep examples current

---

## Version History

### 0.5.0 (Current) - June 2024
- Initial memory system created
- Four core documents established
- Comprehensive procedural memories
- Architecture quick reference
- Common gotchas catalog

---

## Meta: About This Memory System

### Purpose

This memory system serves as:
- **Onboarding accelerator** for new developers and AI agents
- **Reference manual** during daily development
- **Decision log** preserving architectural choices
- **Troubleshooting guide** for common issues
- **Quality gate** preventing repeated mistakes

### Principles

1. **Fast lookup** - Find answers in < 30 seconds
2. **Actionable** - Every item includes what to do
3. **Examples** - Show, don't just tell
4. **Maintained** - Keep current or delete
5. **Discoverable** - Clear index and cross-links

### Using AI with This Memory

**For AI agents (Claude, etc.):**
1. Start with INDEX.md (this file)
2. Identify relevant document
3. Jump to specific section
4. Use examples as templates
5. Verify with checklists

**For humans using AI:**
1. Point AI to relevant doc
2. Ask specific questions
3. Request code examples
4. Verify against gates

### Future Enhancements

Planned additions:
- [ ] Deployment runbooks
- [ ] Incident response procedures
- [ ] Performance benchmarking guide
- [ ] Security audit checklist
- [ ] Migration guides for major versions

---

## Contact & Support

**Found an issue in the docs?** Update it directly and commit.

**Have a question not covered?** Ask in team chat, then document the answer.

**Discovered a new gotcha?** Add it to COMMON_GOTCHAS.md immediately.

---

**Last Updated:** June 2024  
**Maintained By:** Oxagen Platform Team  
**Version:** 0.5.0
