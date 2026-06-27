# How to Use This Documentation System

Quick guide for AI agents and developers on effectively using the Oxagen documentation.

---

## For AI Agents (Claude, etc.)

### First Request in a Session
```
I'm working on [describe task]. Please read .oxagen/INDEX.md and 
point me to the relevant documentation.
```

### When Adding a Feature
```
I need to add a [capability/migration/component/job/connector].
Please reference .oxagen/PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md 
section [number] and guide me through it.
```

### When Debugging
```
I'm getting error [error message]. Please check:
1. .oxagen/COMMON_GOTCHAS.md for known issues
2. .oxagen/memories/ for similar incidents
3. Guide me through debugging procedure if needed
```

### When Learning Architecture
```
I need to understand [system/pattern/boundary].
Please reference .oxagen/ARCHITECTURE_QUICK_REF.md and explain.
```

### Quick Reference
```
Show me the quick reference for [task] from 
.oxagen/QUICK_CHEAT_SHEET.md
```

---

## For Developers

### First Day
1. **Read:** `.oxagen/README.md` (this directory overview)
2. **Skim:** `.oxagen/QUICK_CHEAT_SHEET.md` (1 page)
3. **Browse:** `.oxagen/INDEX.md` (table of contents)
4. **Dive in:** `.oxagen/MONOREPO_OVERVIEW.md` (comprehensive)

### Daily Development
- Keep `.oxagen/QUICK_CHEAT_SHEET.md` open in a tab
- Search `.oxagen/COMMON_GOTCHAS.md` when you hit errors
- Reference `.oxagen/PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md` for step-by-steps
- Check `.oxagen/ARCHITECTURE_QUICK_REF.md` for patterns

### Before Committing
1. Run through checklist in `.oxagen/QUICK_CHEAT_SHEET.md`
2. Scan `.oxagen/COMMON_GOTCHAS.md` for mistakes you might have made
3. Verify patterns match `.oxagen/ARCHITECTURE_QUICK_REF.md`

---

## Directory Structure

```
.oxagen/
├── README.md                                    # This directory overview
├── USAGE_GUIDE.md                              # This file (how to use docs)
├── INDEX.md                                    # Central navigation hub
├── QUICK_CHEAT_SHEET.md                       # 1-page reference
├── MONOREPO_OVERVIEW.md                       # Complete system reference
├── ARCHITECTURE_QUICK_REF.md                  # Architectural patterns
├── PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md   # Step-by-step procedures
├── COMMON_GOTCHAS.md                          # Mistakes & solutions
└── memories/                                   # Incident-specific memories
    ├── _index.md
    └── [incident-name].md
```

---

## Search Strategies

### By Error Message
```bash
# Search gotchas
grep -i "error text" .oxagen/COMMON_GOTCHAS.md

# Search memories
grep -r "error text" .oxagen/memories/
```

### By Task
```bash
# Find in index
grep -i "add capability" .oxagen/INDEX.md

# Or open INDEX.md and use the "I need to..." table
```

### By Code Pattern
```bash
# Search architecture reference
grep -i "runInTenantScope" .oxagen/ARCHITECTURE_QUICK_REF.md

# Or search procedures
grep -i "pattern name" .oxagen/PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md
```

---

## Documentation Size Reference

| File | Size | Read Time | When to Use |
|------|------|-----------|-------------|
| QUICK_CHEAT_SHEET.md | 7KB | 2 min | Quick lookup, daily reference |
| INDEX.md | 13KB | 5 min | Finding right document |
| MONOREPO_OVERVIEW.md | 21KB | 15 min | Learning system |
| COMMON_GOTCHAS.md | 21KB | 15 min | Debugging, pre-commit |
| ARCHITECTURE_QUICK_REF.md | 27KB | 20 min | Understanding architecture |
| PROCEDURAL_MEMORY.md | 44KB | 30 min | Following procedures |

**Total: ~133KB of documentation**

---

## AI Agent Prompting Tips

### Effective
✅ "Reference .oxagen/PROCEDURAL_MEMORY section 1 and walk me through adding a capability"
✅ "Check .oxagen/COMMON_GOTCHAS.md for TenantScopeError solutions"
✅ "Show me the storage decision matrix from .oxagen/ARCHITECTURE_QUICK_REF.md"

### Less Effective
❌ "How do I add a capability?" (too vague, will hallucinate instead of reading docs)
❌ "What's the architecture?" (too broad, point to specific doc section)
❌ "Is this code correct?" (ask to verify against patterns in docs)

### Best Practice
Always reference the specific document and section when asking AI agents 
to help with Oxagen code. The docs are comprehensive and accurate.

---

## Contributing Back

**Found something missing?** Add it:
- New gotcha → `.oxagen/COMMON_GOTCHAS.md`
- Better procedure → `.oxagen/PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md`
- Architecture change → `.oxagen/ARCHITECTURE_QUICK_REF.md`
- New incident → `.oxagen/memories/[name].md`

**Format:** Match existing style, include examples, keep it actionable.

---

## Quick Command Reference

```bash
# View docs in terminal
cat .oxagen/QUICK_CHEAT_SHEET.md
less .oxagen/MONOREPO_OVERVIEW.md

# Search all docs
grep -r "search term" .oxagen/

# Open in editor
code .oxagen/

# Generate docs index
ls -lh .oxagen/*.md
```

---

## Integration with Other Docs

| This System | Official Docs | Relationship |
|-------------|---------------|-------------|
| `.oxagen/` | `README.md` | Quick ref → Product overview |
| `.oxagen/` | `CONTRIBUTING.md` | Procedures → Contribution rules |
| `.oxagen/` | `AGENTS.md` | Quick ref → Agent coder guide |
| `.oxagen/` | `docs/adr/` | Architecture → Decision records |
| `.oxagen/` | `.agents/summary/` | Overview → Detailed component docs |

**Think of it as:**
- Official docs = What and Why
- `.oxagen/` = How (step-by-step) and What Not To Do (gotchas)

---

## Version & Maintenance

**Current Version:** 0.5.0 (June 2024)

**Update Frequency:**
- After each major feature
- Monthly review
- When patterns change
- As gotchas are discovered

**Maintained By:** Oxagen Platform Team

---

## Support

**Questions?** 
1. Check INDEX.md for navigation
2. Search relevant doc for your question
3. Check memories/ for similar incidents
4. Ask in team chat with doc reference

**Found an error in docs?**
Fix it directly and commit. Documentation is code.

---

**Last Updated:** June 2024
