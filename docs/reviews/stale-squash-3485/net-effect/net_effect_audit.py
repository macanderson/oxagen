#!/usr/bin/env python3
"""Net-effect audit of lost main changes (#3485, ADR-110 addendum of 2026-10-03).

Run from the repository root, in a clean checkout of NOW, with every PR head
object present (fetch refs/pull/<n>/head when one is missing):

    python3 docs/reviews/stale-squash-3485/net-effect/net_effect_audit.py \
        583d7f87f89874ae7dcb0a162b19387c38733aa1 \
        11cc318c11b0db2bce87b907ece557cece01581f \
        f080863dac4493aae6bb329730f1343dfc2cc76b \
        docs/reviews/stale-squash-3485/net-effect/prs.json /tmp/net-effect

START is the last main commit before 2026-09-17T00:00Z, END is the #3556
merge, and NOW is the main tip the liveness passes read. The checkout must be
clean at NOW, and ripgrep (`rg`) must be on PATH.

The audit looks at every commit that END has and START lacks.

* A PR squash X with parent P: the fork point F0 is where the PR branch first
  split from main, the merge base of every main commit its history touches
  (the boundary of `head ^P`). Main's changes since the split are F0..P.
* A merge commit pushed to main: F0 is the merge base of its parents, and each
  parent supplies a side F0..parent.
* A direct one-parent push with no PR has no branch side and is skipped.

A candidate is one (commit, file, origin commit) where:

* removed: X's diff takes away lines that `git blame F0..P` gives to a main
  commit inside F0..P (a change that landed after the branch split);
* readded: X adds back a line the F0..P diff removed from the same file;
* binary: X changes a binary file that F0..P also changed.

The later passes check each candidate against NOW: whether the lost lines are
on main today (exactly, anywhere in the tree, or 80% similar in the same file),
how the branch lost them (a hint), whether a later commit deleted the file,
and whether the file is generated and checked by CI. What is left is the
review set. No pass proves that behaviour survived; the review does that.
"""
import csv, difflib, json, os, re, subprocess, sys
from collections import Counter, defaultdict

START, END, NOW, PRS, OUT = sys.argv[1:6]
REPO = os.getcwd()
TRIVIAL = re.compile(r"^[\s{}()\[\];,:.'\"`<>/*+=|&!?-]*$")
LIVE = ("absent-today", "partial", "file-gone")
# Each generated file, and the CI step that fails when main's copy differs from its sources.
GENERATED = {
    r"^packages/database/atlas/migrations/atlas\.sum$": "atlas migrate validate (pipeline.yml)",
    r"^packages/database/storage-manifest\.json$": "pnpm schema:manifest:check (pipeline.yml)",
    r"^docs/capabilities/schemas/(_index\.json|README\.md)$": "pnpm docs:schemas:check, inside check:contracts (pipeline.yml)",
    r"^apps/app/src/i18n/messages\.d\.ts$": "pnpm --filter @oxagen/app check:messages (pipeline.yml)",
    r"^packages/oxagen/capabilities\.manifest\.json$": "pnpm check:manifest (pipeline.yml)",
    r"(^|/)pnpm-lock\.yaml$": "pnpm install --frozen-lockfile (.github/actions/pnpm-install)",
}
SEARCH_EXCLUDES = ["docs/reviews/**", "docs/audits/**", ".agent/**", "CHANGELOG.md", "releases/**", ".design-sync/**", "apps/app_deprecated/**"]
DOC = re.compile(r"(\.(md|mdx|txt)$)|(^docs/)|(^\.claude/)|(^\.agent/)")


def run(*args, ok=(0,)):
    r = subprocess.run(["git", *args], capture_output=True, cwd=REPO)
    if r.returncode not in ok:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.decode(errors='replace')[:400]}")
    return r.stdout.decode("utf-8", "replace")


def show(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, cwd=REPO)
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def trivial(line):
    s = line.strip()
    return len(s) <= 2 or bool(TRIVIAL.match(s))


def similar(s, lines):
    for t in lines:
        if abs(len(t) - len(s)) > max(20, len(s) // 2):
            continue
        m = difflib.SequenceMatcher(None, s, t, autojunk=False)
        if m.real_quick_ratio() >= 0.8 and m.quick_ratio() >= 0.8 and m.ratio() >= 0.8:
            return True
    return False


def parse_diff(text):
    files, cur = [], None
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            cur = {"old": None, "new": None, "removed": [], "added": [], "binary": False, "status": "M"}
            files.append(cur)
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            if m:
                cur["old"], cur["new"] = m.group(1), m.group(2)
            continue
        if cur is None:
            continue
        if line.startswith("new file mode"):
            cur["status"] = "A"
        elif line.startswith("deleted file mode"):
            cur["status"] = "D"
        elif line.startswith("rename from "):
            cur["old"], cur["status"] = line[len("rename from "):], "R"
        elif line.startswith("rename to "):
            cur["new"] = line[len("rename to "):]
        elif line.startswith("Binary files "):
            cur["binary"] = True
        elif line.startswith("--- ") or line.startswith("+++ "):
            continue
        elif line.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
            a, b = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
            if b > 0:
                cur["removed"].append((a, b))
        elif line.startswith("+"):
            cur["added"].append(line[1:])
    return files


def blame_lost(F0, p, path, ranges):
    args = ["blame", "--porcelain"]
    for a, b in ranges:
        args += ["-L", f"{a},+{b}"]
    out = run(*args, f"{F0}..{p}", "--", path)
    lost, boundary, meta, cur = [], set(), {}, None
    for line in out.split("\n"):
        m = re.match(r"^([0-9a-f]{40}) \d+ (\d+)", line)
        if m:
            cur = {"sha": m.group(1)}
            continue
        if cur is None:
            continue
        if line == "boundary":
            boundary.add(cur["sha"])
        elif line.startswith("summary "):
            meta.setdefault(cur["sha"], line[8:])
        elif line.startswith("\t"):
            if cur["sha"] not in boundary and cur["sha"] != F0:
                lost.append((cur["sha"], line[1:]))
            cur = None
    return lost, meta


def collect(prs):
    by_merge = {p["mergeCommit"]["oid"]: p for p in prs if p.get("mergeCommit")}
    commits = [l.split() for l in run("rev-list", "--topo-order", "--reverse", "--parents", END, f"^{START}").split("\n") if l.strip()]
    records, cands = [], []
    for X, *parents in commits:
        pr = by_merge.get(X)
        rec = {"commit": X, "parents": parents, "subject": run("log", "-1", "--format=%s", X).strip(),
               "pr": pr["number"] if pr else None}
        if pr and len(parents) == 1:
            P, head = parents[0], pr["headRefOid"]
            if run("cat-file", "-t", head, ok=(0, 1, 128)).strip() != "commit":
                raise RuntimeError(f"PR #{pr['number']} head {head} is missing; fetch refs/pull/{pr['number']}/head")
            bounds = [l[1:] for l in run("rev-list", "--boundary", head, f"^{P}").split("\n") if l.startswith("-")]
            F0 = (run("merge-base", "--octopus", *bounds).strip() if len(bounds) > 1 else bounds[0]) if bounds \
                else run("merge-base", head, P).strip()
            rec.update({"kind": "squash", "head": head, "forkPoint": F0,
                        "finalMergeBase": run("merge-base", head, P).strip(),
                        "githubBaseSha": pr["baseRefOid"], "integrations": max(len(bounds) - 1, 0)})
            sides = [(P, F0)]
        elif len(parents) >= 2:
            F0 = run("merge-base", "--octopus", *parents).strip()
            rec.update({"kind": "merge", "forkPoint": F0})
            sides = [(p, F0) for p in parents]
        else:
            rec["kind"] = "direct"
            records.append(rec)
            continue
        rec["sides"] = []
        for p, F0 in sides:
            if F0 == p:
                rec["sides"].append({"parent": p, "mainCommitsSinceFork": 0})
                continue
            changed = set(x for x in run("diff", "--name-only", "--no-renames", F0, p).split("\n") if x)
            rec["sides"].append({"parent": p, "mainCommitsSinceFork": int(run("rev-list", "--count", f"{F0}..{p}").strip()),
                                 "filesChangedSinceFork": len(changed)})
            base = {"commit": X, "pr": rec["pr"], "parent": p, "forkPoint": F0}
            for f in parse_diff(run("diff", "-U0", "-M", "--no-color", "--no-ext-diff", p, X)):
                old = f["old"]
                if old not in changed:
                    continue
                if f["binary"]:
                    cands.append(base | {"file": old, "type": "binary", "origin": None, "lines": []})
                    continue
                if f["removed"] and f["status"] != "A":
                    lost, meta = blame_lost(F0, p, old, f["removed"])
                    by_origin = defaultdict(list)
                    for sha, text in lost:
                        by_origin[sha].append(text)
                    for sha, texts in by_origin.items():
                        cands.append(base | {"file": old, "newPath": f["new"], "status": f["status"], "type": "removed",
                                             "origin": sha, "originSubject": meta.get(sha, ""), "lines": texts,
                                             "nontrivial": sum(0 if trivial(t) else 1 for t in texts)})
                if f["added"]:
                    rem = set(t[1:] for t in run("diff", "-U0", "--no-color", "--no-ext-diff", F0, p, "--", old).split("\n")
                              if t.startswith("-") and not t.startswith("---"))
                    back = [t for t in f["added"] if t in rem and not trivial(t)]
                    if back:
                        cands.append(base | {"file": old, "newPath": f["new"], "status": f["status"], "type": "readded",
                                             "origin": None, "lines": back, "nontrivial": len(back)})
        records.append(rec)
    return records, cands


def blob(ref, path):
    r = subprocess.run(["git", "rev-parse", f"{ref}:{path}"], capture_output=True, cwd=REPO)
    return r.stdout.decode().strip() if r.returncode == 0 else None


def liveness(cands):
    cache = {}
    for c in cands:
        c["pathNow"] = c.get("newPath") if c.get("status") == "R" else c["file"]
        if c["type"] == "binary":
            now, x, p = blob(NOW, c["pathNow"]), blob(c["commit"], c.get("newPath") or c["file"]), blob(c["parent"], c["file"])
            c["live"] = "binary-review" if (now is not None and now == x and now != p) else "not-live"
            continue
        if c["pathNow"] not in cache:
            cache[c["pathNow"]] = show(NOW, c["pathNow"])
        cur = cache[c["pathNow"]]
        lines = [l for l in c["lines"] if not trivial(l)]
        if not lines:
            c["live"] = "trivial-only"
        elif cur is None:
            c["live"], c["absent"] = "file-gone", lines
        else:
            have = set(l.strip() for l in cur.split("\n"))
            if c["type"] == "removed":
                c["absent"] = [l for l in lines if l.strip() not in have]
                c["live"] = "present-today" if not c["absent"] else (
                    "partial" if len(c["absent"]) < len(lines) else "absent-today")
            else:
                c["stillThere"] = [l for l in lines if l.strip() in have]
                c["live"] = "readded-present" if c["stillThere"] else "readded-gone"


def exact_count(text, probe):
    return sum(1 for l in (text or "").split("\n") if l.strip() == probe)


def mechanism(cands, recs):
    """A hint at how the branch lost the line; pickaxe finds candidates, exact counts decide."""
    for c in cands:
        if c["live"] not in LIVE + ("readded-present",):
            continue
        r = recs[c["commit"]]
        if r["kind"] == "merge":
            c["mechanism"] = "main-merge"
            continue
        lines = c.get("absent") or c.get("stillThere") or []
        if not lines:
            continue
        probe = c["probe"] = max(lines, key=lambda l: len(l.strip())).strip()
        out = run("log", "--first-parent", "--diff-merges=first-parent", "--format=%H %P", "-S", probe,
                  r["head"], f"^{c['parent']}", "--", c["file"])
        mech = None
        for ev in [l.split() for l in out.strip().split("\n") if l.strip()]:
            sha, parents = ev[0], ev[1:]
            before = exact_count(show(parents[0], c["file"]), probe) if parents else 0
            after = exact_count(show(sha, c["file"]), probe)
            if before == after:
                continue
            if c["type"] == "removed":
                mech = ("integration-removed" if len(parents) > 1 else "branch-edit") if after < before else "branch-had-line"
            else:
                mech = ("readded-by-merge" if len(parents) > 1 else "readded-by-edit") if after > before else "readded-then-removed"
            c["lastBranchEvent"] = sha
            break
        c["mechanism"] = mech or ("never-on-branch-first-parent" if c["type"] == "removed" else "readded-at-integration")


def clear(cands):
    if run("rev-parse", "HEAD").strip() != run("rev-parse", NOW).strip() or run("status", "--porcelain").strip():
        raise RuntimeError("the checkout must be clean at NOW: the tree-wide search reads the working tree")
    pats = sorted(set(l.strip() for c in cands if c["live"] in LIVE for l in c["absent"]) - {""})
    pat_file = os.path.join(OUT, "patterns.txt")
    open(pat_file, "w").write("\n".join(pats) + "\n")
    # Records, reflections, changelogs and the retired app quote old lines
    # verbatim, so a line found only there is not live on main.
    excludes = [g for d in SEARCH_EXCLUDES for g in ("--glob", f"!{d}")]
    out = subprocess.run(["rg", "-F", "--hidden", "--glob", "!.git", *excludes, "-I", "-N", "--no-filename", "-f", pat_file, "."],
                         cwd=REPO, capture_output=True).stdout.decode("utf-8", "replace")
    anywhere = set(l.strip() for l in out.split("\n")) & set(pats)
    cache = {}
    for c in cands:
        if c["live"] not in LIVE:
            continue
        if c["pathNow"] not in cache:
            cache[c["pathNow"]] = [l.strip() for l in (show(NOW, c["pathNow"]) or "").split("\n")]
        c["residual"] = [l for l in c["absent"] if l.strip() not in anywhere and not similar(l.strip(), cache[c["pathNow"]])]
        c["clear"] = "carried-forward" if not c["residual"] else "residual"


def triage(cands, recs, prs):
    titles = {p["number"]: p["title"] for p in prs}
    for i, c in enumerate(cands, 1):
        c["id"] = f"C{i:04d}"
        c["generatedBy"] = next((v for k, v in GENERATED.items() if re.search(k, c["file"])), None)
        c["generated"] = c["generatedBy"] is not None
        c["doc"] = bool(DOC.search(c["file"]))
        if c["live"] == "file-gone":
            if c.get("status") == "D":
                c["deletedBy"] = c["commit"]
            else:
                dl = run("log", "--format=%H", "--diff-filter=D", f"{c['commit']}..{NOW}", "--", c["pathNow"]).split()
                c["deletedBy"] = dl[-1] if dl else None
        if c.get("residual"):
            xl = [l.strip() for l in (show(c["commit"], c["pathNow"]) or "").split("\n")]
            c["residualRewrittenInX"] = sum(1 for l in c["residual"] if similar(l.strip(), xl))
        if c["generated"]:
            c["auto"] = "generated: " + c["generatedBy"]
        elif c["live"] in ("present-today", "readded-gone", "not-live", "trivial-only"):
            c["auto"] = c["live"]
        elif c["live"] in LIVE and c.get("clear") == "carried-forward":
            c["auto"] = "carried-forward"
        elif c["live"] == "file-gone" and c.get("deletedBy") and c["deletedBy"] != c["commit"] and c["doc"]:
            c["auto"] = f"superseded: file deleted later in {c['deletedBy'][:10]}"
        else:
            c["auto"] = None
        c["prTitle"] = titles.get(c["pr"]) if c["pr"] else recs[c["commit"]]["subject"]


def main():
    os.makedirs(OUT, exist_ok=True)
    prs = json.load(open(PRS))
    records, cands = collect(prs)
    recs = {r["commit"]: r for r in records}
    liveness(cands)
    mechanism(cands, recs)
    clear(cands)
    triage(cands, recs, prs)
    json.dump(records, open(os.path.join(OUT, "records.json"), "w"), indent=1)
    json.dump(cands, open(os.path.join(OUT, "candidates.json"), "w"), indent=1)
    print("commits", len(records), Counter(r["kind"] for r in records))
    print("candidates", len(cands), "review set", sum(1 for c in cands if c["auto"] is None))
    print(Counter((c["auto"] or "review").split(":")[0] for c in cands))


if __name__ == "__main__":
    main()
