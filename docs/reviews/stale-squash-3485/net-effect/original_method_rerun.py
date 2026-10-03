#!/usr/bin/env python3
"""Rerun the #3482 adjacent-pair audit exactly, to reconcile its 19-vs-21 count.

Run from the repository root:

    python3 docs/reviews/stale-squash-3485/net-effect/original_method_rerun.py > /tmp/original-87.json

The commit list is `git log --since=2026-09-17T14:30:00-07:00 79d393a334`.
79d393a334 is the merge base of #3482's branch, the main tip the audit read.
#3482 wrote `--since=2026-09-17`; git fills a date with no time with the
current time of day, so the cutoff fell on the afternoon of 2026-09-17. Any
cutoff from 14:25:36 to 14:59:15 PDT gives the same 87 commits.

For each adjacent pair (P, C) in that list where C's only parent is P, it
compares the files P changed (against its parent) with the files C changed
(against P), and runs fileMergeRisk from tools/scripts/check-stale-merge-base.mjs
as it stood at 23f5c708f: base = P^:f, main = P:f, branch = C:f.
"""
import json, subprocess

TIP = "79d393a33480b440779594534d7c0b1c47501a23"
SINCE = "2026-09-17T14:30:00-07:00"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout.decode("utf-8", "replace")


def content(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else ""


def lines(c):
    ls = c.replace("\r\n", "\n").split("\n")
    if ls and ls[-1] == "":
        ls.pop()
    return ls


def missing(base, main, branch):
    if main == branch:
        return []
    bl, added, seen = set(lines(base)), [], set()
    for l in lines(main):
        if l in bl or l.strip() == "" or l in seen:
            continue
        seen.add(l)
        added.append(l)
    br = set(lines(branch))
    return [l for l in added if l not in br]


def changed(a, b):
    out = git("diff", "--name-only", "--diff-filter=ACMR", f"{a}...{b}").strip()
    return set(out.split("\n")) if out else set()


rows = [l.split("|", 2) for l in git("log", f"--since={SINCE}", "--format=%H|%P|%s", TIP).strip().split("\n")]
pairs, hits = [], []
for i in range(len(rows) - 1):
    (c, cp, cs), (p, pp, ps) = rows[i], rows[i + 1]
    if cp.split() != [p]:
        pairs.append({"child": c, "parent": p, "skipped": "the child is not the one-parent child of the next commit"})
        continue
    found = []
    for f in sorted(changed(pp.split()[0], p) & changed(p, c)):
        m = missing(content(pp.split()[0], f), content(p, f), content(c, f))
        if m:
            found.append({"file": f, "missingLines": len(m)})
            hits.append({"child": c, "childSubject": cs, "parent": p, "parentSubject": ps, "file": f, "missingLines": len(m)})
    pairs.append({"child": c, "parent": p, "hits": found})
print(json.dumps({"tip": TIP, "since": SINCE, "commits": len(rows),
                  "pairsCompared": sum(1 for x in pairs if "hits" in x),
                  "pairsSkipped": sum(1 for x in pairs if "skipped" in x),
                  "rawHits": len(hits), "hits": hits}, indent=1))
