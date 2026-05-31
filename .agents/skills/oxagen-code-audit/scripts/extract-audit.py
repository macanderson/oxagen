#!/usr/bin/env python3
"""Reconstruct the merged audit dataset from workflow agent transcripts.

Each unit ran 3 agents: audit (FINDINGS_SCHEMA), verify (VERIFY_SCHEMA),
fix (FIX_SCHEMA). Each agent's validated result is the input to its
StructuredOutput tool call, recorded in agent-*.jsonl. We pull those out,
key them by unit, and merge into the same shape the workflow synthesis
produced — EXCEPT we do NOT trust fix.applied (those edits did not persist;
they will be re-applied to the worktree and applied[] re-derived from git).
"""
import sys, json, glob, os, re

RUN = sys.argv[1]
OUT = sys.argv[2]

def iter_objs(o):
    """yield every dict nested anywhere in o"""
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from iter_objs(v)
    elif isinstance(o, list):
        for v in o:
            yield from iter_objs(v)

def load_agent(path):
    """return (unit, kind, payload) for one agent transcript"""
    unit = None
    payload = None
    full_text_for_unit = []
    for line in open(path, errors="ignore"):
        line = line.strip()
        if not line:
            continue
        try:
            j = json.loads(line)
        except Exception:
            continue
        for obj in iter_objs(j):
            # find the StructuredOutput tool_use input (the validated result)
            if obj.get("type") == "tool_use" and obj.get("name") == "StructuredOutput":
                inp = obj.get("input")
                if isinstance(inp, dict):
                    payload = inp
            # capture the unit from the prompt text
            if unit is None:
                t = obj.get("text")
                if isinstance(t, str) and "UNIT:" in t:
                    m = re.search(r"UNIT:\s*([a-z0-9-]+)", t)
                    if m:
                        unit = m.group(1)
        # also scan raw line for UNIT if still unknown
        if unit is None and "UNIT:" in line:
            m = re.search(r"UNIT:\s*([a-z0-9-]+)", line)
            if m:
                unit = m.group(1)
    if payload is None:
        return (unit, None, None)
    # classify by shape
    if "findings" in payload:
        kind = "audit"
    elif "verdicts" in payload:
        kind = "verify"
    elif "applied" in payload or "skipped" in payload:
        kind = "fix"
    else:
        kind = "unknown"
    # prefer the unit recorded inside the payload if present
    if payload.get("unit"):
        unit = payload["unit"]
    return (unit, kind, payload)

agents = {}  # unit -> {audit, verify, fix}
unknowns = 0
for path in sorted(glob.glob(os.path.join(RUN, "agent-*.jsonl"))):
    unit, kind, payload = load_agent(path)
    if not unit or not kind or kind == "unknown":
        unknowns += 1
        continue
    agents.setdefault(unit, {})
    # if duplicate kind for a unit (shouldn't happen), keep the one with more content
    if kind in agents[unit]:
        prev = agents[unit][kind]
        if kind == "audit" and len(payload.get("findings", [])) < len(prev.get("findings", [])):
            continue
    agents[unit][kind] = payload

# ---- merge exactly like the workflow synthesis ----
all_findings = []
unit_summaries = []
fixes_applied = []   # from workflow (bogus persistence) — kept for reference only
fixes_skipped = []

for unit, parts in sorted(agents.items()):
    audit = parts.get("audit") or {"findings": [], "healthScore": None, "summary": ""}
    verify = parts.get("verify") or {"verdicts": []}
    fix = parts.get("fix") or {"applied": [], "skipped": []}
    vmap = {v["id"]: v for v in verify.get("verdicts", []) if "id" in v}
    applied_ids = {a["id"] for a in fix.get("applied", []) if "id" in a}
    for f in audit.get("findings", []):
        v = vmap.get(f.get("id"), {})
        all_findings.append({
            **f,
            "unit": unit,
            "verdict": v.get("verdict", "unverified"),
            "verifiedFixClass": v.get("fixClass", f.get("fixClass")),
            "verifiedSeverity": v.get("severity", f.get("severity")),
            "verifyReasoning": v.get("reasoning", ""),
            "applied": False,  # re-derived later from real git diff
            "wfClaimedApplied": f.get("id") in applied_ids,
        })
    unit_summaries.append({
        "unit": unit,
        "healthScore": audit.get("healthScore"),
        "summary": audit.get("summary", ""),
        "findingCount": len(audit.get("findings", [])),
        "confirmedCount": sum(1 for v in verify.get("verdicts", []) if v.get("verdict") == "confirmed"),
        "applied": 0,
    })
    for a in fix.get("applied", []):
        fixes_applied.append({**a, "unit": unit})
    for s in fix.get("skipped", []):
        fixes_skipped.append({**s, "unit": unit})

def count_by(arr, key):
    m = {}
    for x in arr:
        k = x.get(key)
        if k is not None:
            m[k] = m.get(k, 0) + 1
    return m

confirmed = [f for f in all_findings if f["verdict"] == "confirmed"]
tickets = [f for f in confirmed if f["verifiedFixClass"] == "needs-approval"]
auto_safe = [f for f in confirmed if f["verifiedFixClass"] == "auto-fix-safe"]

rollup = {
    "units": len(unit_summaries),
    "totalFindings": len(all_findings),
    "confirmed": len(confirmed),
    "falsePositive": sum(1 for f in all_findings if f["verdict"] == "false-positive"),
    "uncertain": sum(1 for f in all_findings if f["verdict"] == "uncertain"),
    "bySeverityConfirmed": count_by(confirmed, "verifiedSeverity"),
    "byCategoryConfirmed": count_by(confirmed, "category"),
    "fixesApplied": 0,             # re-derived after real application
    "fixesSkipped": 0,
    "ticketsNeeded": len(tickets),
    "autoFixSafeConfirmed": len(auto_safe),
}

out = {
    "meta": {"base": "631f28c", "worktree": "/Users/macanderson/oxagen-monorepo-audit",
             "branch": "audit/codebase-2026-05-31", "generatedFor": "oxagen-monorepo"},
    "unitSummaries": unit_summaries,
    "rollup": rollup,
    "findings": all_findings,
    "fixesApplied": [],            # will be filled with REAL applied fixes
    "fixesSkipped": [],
    "tickets": tickets,
    "_wfFixesApplied": fixes_applied,   # workflow's (non-persisted) claims, for reference
    "_autoFixSafe": auto_safe,          # the work list to actually apply
}

with open(OUT, "w") as fh:
    json.dump(out, fh, indent=1)

print("units parsed:", len(agents))
print("unknown/skipped agents:", unknowns)
print("total findings:", len(all_findings))
print("confirmed:", len(confirmed))
print("  - auto-fix-safe (to apply):", len(auto_safe))
print("  - needs-approval (tickets):", len(tickets))
print("false-positive:", rollup["falsePositive"], " uncertain:", rollup["uncertain"])
print("severity(confirmed):", rollup["bySeverityConfirmed"])
print("units with no audit payload:", [u for u,p in agents.items() if "audit" not in p])
