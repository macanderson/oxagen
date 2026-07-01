# Oxagen Agent Documentation & Memories

This directory contains comprehensive documentation and procedural memories for AI agents and developers working on the Oxagen platform.

---

## 📚 Core Documentation

**Start here for learning the codebase:**

### [INDEX.md](INDEX.md)

Central navigation hub - links to all documentation with task-based lookup and search strategies.

### [QUICK_CHEAT_SHEET.md](QUICK_CHEAT_SHEET.md)

1-page reference for the most common tasks, commands, and patterns. Print this!

### [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md)

Complete system reference (20KB):

- Repository structure and tech stack
- Development workflow and testing standards
- Adding features, migrations, and connectors
- Coding standards and common commands
- Troubleshooting guide

### [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md)

Architectural patterns and decisions (24KB):

- Storage boundaries and package architecture
- Tenancy, IAM, and capability system
- Data flows and schema organization
- Security patterns and performance optimization
- ADR quick reference

### [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)

Step-by-step procedures (44KB):

1. Adding a New Capability
2. Creating Database Migrations
3. Building UI Components
4. Implementing Background Jobs
5. Adding Connectors
6. Writing Tests
7. Debugging Issues
8. Performance Optimization

### [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md)

Catalog of common mistakes and solutions (21KB):

- Database & Schema antipatterns
- Capability system mistakes
- UI & Component issues
- Testing, jobs, environment, git
- Performance, security, TypeScript
- Pre-commit checklists

---

## 🧠 Incident Memories

The [memories/](memories/) subdirectory contains specific bug reports and observations recorded by evaluator agents and the break-fix agent.

**Format:** Each memory documents a specific incident with:

- Title and one-line summary
- Type (bug | observation)
- Timestamp
- Detailed description with code examples

**Index:** [memories/\_index.md](memories/_index.md)

---

## Quick Start Workflows

### For New Agent Coders

1. Read [INDEX.md](INDEX.md) for orientation
2. Scan [QUICK_CHEAT_SHEET.md](QUICK_CHEAT_SHEET.md)
3. Dive into [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md) for details
4. Reference [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md) while coding

### Building a Feature

1. Find relevant procedure in [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
2. Follow step-by-step
3. Check [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) for mistakes to avoid
4. Verify with [QUICK_CHEAT_SHEET.md](QUICK_CHEAT_SHEET.md) checklist

### Fixing a Bug

1. Search [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md) for known issues
2. Check [memories/](memories/) for similar incidents
3. Follow "Debugging Issues" in [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
4. Document new gotchas or memory entries

---

## Documentation Coverage

- **383 capabilities** documented
- **27 packages** explained
- **5 apps** detailed
- **16 database schemas** cataloged
- **40+ common commands** referenced
- **8 step-by-step procedures** for common tasks
- **50+ common gotchas** with solutions
- **9 incident memories** (in memories/ subdirectory)

---

## Contribution Guidelines

### Adding to Core Documentation

**Update [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md)** when you:

- Discover a non-obvious mistake
- Fix a confusing error
- Find a pattern that should be avoided

**Update [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)** when you:

- Discover a new procedure
- Improve an existing procedure
- Find better examples

**Update [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md)** when:

- Architecture changes
- New pattern is established
- System boundaries shift

### Adding Incident Memories

See [memories/\_index.md](memories/_index.md) for format and guidelines.

**When to add a memory:**

- Non-obvious bug that took >30 min to debug
- Failure mode that could recur
- Observation about system behavior
- Gotcha that wasn't in documentation

---

## Maintenance

**Monthly Review:**

- [ ] Update version numbers
- [ ] Remove outdated information
- [ ] Consolidate duplicate content
- [ ] Add new common gotchas discovered
- [ ] Update cheat sheet with new patterns

**After Major Changes:**

- [ ] Update ARCHITECTURE_QUICK_REF.md
- [ ] Add migration procedures
- [ ] Update package descriptions
- [ ] Refresh examples

---

## Version

**Platform Version:** 0.5.0
**Last Updated:** June 2024
**Maintained By:** Oxagen Platform Team

---

## Related Documentation

- **Main README:** [../README.md](../README.md)
- **Contributing:** [../CONTRIBUTING.md](../CONTRIBUTING.md)
- **Agent Guide:** [../AGENTS.md](../AGENTS.md)
- **ADRs:** [../docs/adr/](../docs/adr/)
- **Agent Summary:** [../.agents/summary/](../.agents/summary/)
