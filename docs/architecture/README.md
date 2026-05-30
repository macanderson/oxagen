# `docs/architecture/`

Long-lived architectural specifications and implementation plans.

## Convention

Each architectural topic lives in its own folder. Inside, two files:

| File | Purpose | Audience |
|---|---|---|
| `spec.md` | **What** we're building, **why**, and the constraints. Product + design + engineering align here. Changes rarely once shipped; updated when scope or requirements change. | Everyone |
| `plan.md` | **How** we'll build it. Sequenced work, dependencies, owners, milestones. Lives until implementation is complete, then archived or replaced by an ADR. | Engineering |

```
docs/architecture/
├── README.md                          ← this file
├── <topic>/
│   ├── spec.md                        ← required
│   └── plan.md                        ← created when implementation begins
```

### When to use which

- **Have an idea for a new system or surface?** Start with `spec.md`. Don't write a plan until product has signed off on the spec.
- **Spec is approved, ready to build?** Add `plan.md` next to it.
- **Plan is being executed?** Update task progress in `plan.md` until done. Link to PRs.
- **Decision made that overturns previous architecture?** Write an ADR in `docs/adr/`, link to it from the spec, and update the spec inline.

### Naming rules

- Folder names: `kebab-case`, matches the canonical product term (`information-architecture`, `application-shell`, `iam`, `agent-runtime`).
- Files always exactly `spec.md` and `plan.md`. No version suffixes; use git history.

### Difference vs. `docs/adr/` and `docs/epics/`

| Folder | Holds | Lifecycle |
|---|---|---|
| `docs/architecture/` | The system's design intent. "How is the platform structured?" | Long-lived. Updated as the design evolves. |
| `docs/adr/` | One-shot architectural decisions with context. "We considered X, Y, Z and picked Y because…" | Immutable once accepted. Superseded by new ADRs. |
| `docs/epics/` | Product epics — discrete chunks of work with acceptance criteria. "Ship X by Q3." | Lifespan = the epic. Archived when complete. |

Use the architecture folder for *durable* design docs. Use ADRs to record *decisions*. Use epics to track *delivery*.

## Current topics

| Topic | Status |
|---|---|
| [`information-architecture/`](./information-architecture/spec.md) | Spec'd |
| [`application-shell/`](./application-shell/spec.md) | Spec'd |
| [`command-menu/`](./command-menu/spec.md) | Spec'd |
| [`iam/`](./iam/plan.md) | Spec'd in IA · Wave 1 plan ready · OXA-1388/1389/1390 created |
