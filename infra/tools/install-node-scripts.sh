#!/usr/bin/env bash
#
# Put the node-side deploy scripts on the node.
#
#   tools/install-node-scripts.sh
#
# `tools/node/` is the source of truth; the copies under /opt/oxagen/bin are
# installed from it. Run this after changing anything in that directory —
# there is deliberately no mechanism that syncs them on its own, because a
# script that rewrites itself on the box during a deploy is a worse failure
# than a stale one.
#
# The transfer goes through S3 rather than an inline SSM payload for the same
# reason the artifact does: an SSM command's parameters are capped, and the
# cap is not generous. Uploading first also means the install is idempotent —
# re-running it re-copies the same objects.

set -euo pipefail

# New account's node by default (the 2026-08-27 cutover is complete and this
# is the live node; both accounts' compute runs in us-east-1). Point it at
# the old, not-yet-decommissioned account with:
#   INSTANCE=i-023d002d6e44f8f84 BUCKET=oxagen-deploy-578673726240 \
#   CADDYFILE=Caddyfile LOG_DRIVER=json-file tools/install-node-scripts.sh
REGION="${REGION:-us-east-1}"
# Resolved by tag, not pinned to an id. The node is replaced whenever its user
# data changes, and on 2026-09-08 a replacement left every hardcoded copy of
# this id pointing at a terminated box. Override with INSTANCE=... for the old
# account's node, which carries a different tag.
if [[ -z "${INSTANCE:-}" ]]; then
  INSTANCE=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=${NODE_NAME:-oxagen-app}" \
              "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  if [[ $(printf '%s' "$INSTANCE" | wc -w) -ne 1 ]]; then
    echo "expected exactly one running instance tagged Name=${NODE_NAME:-oxagen-app}, got: $INSTANCE" >&2
    exit 1
  fi
fi
BUCKET="${BUCKET:-oxagen-deploy-916294258235}"
# Which file under tools/caddy/ this node runs. The new account's node
# terminates no TLS of its own — see Caddyfile.alb's header — so it takes a
# different file from the old account's `Caddyfile`.
CADDYFILE="${CADDYFILE:-Caddyfile.alb}"
# awslogs on the new node — its IAM role is granted CloudWatch Logs write
# access and should use it; json-file was the old node's default.
LOG_DRIVER="${LOG_DRIVER:-awslogs}"

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "==> uploading tools/node -> s3://$BUCKET/_bin/"
aws s3 sync "$HERE/node" "s3://$BUCKET/_bin/" \
  --region "$REGION" --exclude '*.md' --delete --only-show-errors

# node.env tells deploy-service.sh which bucket and region this node's own
# artifacts live in — see that script's header. Generated here rather than
# hand-maintained on the box, so it can never drift from what this run
# actually targeted.
NODE_ENV_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-node-env-XXXXXX")
printf 'DEPLOY_BUCKET=%s\nREGION=%s\nLOG_DRIVER=%s\n' "$BUCKET" "$REGION" "$LOG_DRIVER" > "$NODE_ENV_FILE"
aws s3 cp "$NODE_ENV_FILE" "s3://$BUCKET/_bin/node.env" --region "$REGION" --only-show-errors
rm -f "$NODE_ENV_FILE"

# Caddyfile.alb names the proxies it trusts by address range rather than by
# `private_ranges`, and the range is the ALB's, so it cannot be a literal in a
# checked-in file: the load balancer's ENIs are per-AZ and come and go as it
# scales. What IS stable is the set of subnets it is attached to — the ALB only
# ever gets addresses inside them — so that is what gets substituted, resolved
# from the live load balancer on every run.
#
# Why it matters that this is narrow: `private_ranges` is every RFC1918 block,
# and this ALB is internet-facing, so a caller reaching it from a private source
# (a workload in the VPC, a peered network, a VPN client) has its OWN address
# appended to X-Forwarded-For. Caddy's strict mode skips entries it considers
# trusted proxies, so under `private_ranges` it skipped the caller and walked
# into the prefix the caller wrote — handing it `{client_ip}`, and with it the
# IAM ip_ranges allowlist. The subnets the ALB lives in are public and exclude
# the private subnets the workloads run in, which is what closes that.
#
# Everything here fails the run rather than falling back. There is no safe
# default for "which proxies are in front of me": every plausible one is wider
# than the truth, and wider is the defect.
ALB_NAME="${ALB_NAME:-oxagen-app}"
render_caddyfile() {
  local src="$1" out="$2"
  if ! grep -q '__ALB_SUBNET_CIDRS__' "$src"; then
    # The old account's Caddyfile terminates TLS itself, so Caddy is the edge
    # there and its peer IS the client: it declares no trusted proxies and needs
    # no substitution. Copy it through untouched.
    cp "$src" "$out"
    return
  fi

  local subnet_ids
  subnet_ids=$(aws elbv2 describe-load-balancers \
    --region "$REGION" --names "$ALB_NAME" \
    --query 'LoadBalancers[].AvailabilityZones[].SubnetId' --output text) || {
    echo "could not describe load balancer '$ALB_NAME' in $REGION" >&2
    exit 1
  }
  if [[ -z "${subnet_ids// /}" ]]; then
    echo "load balancer '$ALB_NAME' reports no subnets; refusing to render a trusted-proxy list" >&2
    exit 1
  fi

  local cidrs
  # shellcheck disable=SC2086  # subnet_ids is a deliberate word list
  cidrs=$(aws ec2 describe-subnets \
    --region "$REGION" --subnet-ids $subnet_ids \
    --query 'Subnets[].CidrBlock' --output text) || {
    echo "could not resolve CIDRs for subnets: $subnet_ids" >&2
    exit 1
  }
  cidrs=$(printf '%s' "$cidrs" | tr '\t' ' ' | tr -s ' ')
  if [[ -z "${cidrs// /}" ]]; then
    echo "no CIDRs resolved for subnets: $subnet_ids; refusing to render an empty trusted-proxy list" >&2
    exit 1
  fi

  echo "==> ALB '$ALB_NAME' trusted proxy ranges: $cidrs"
  sed "s|__ALB_SUBNET_CIDRS__|$cidrs|" "$src" > "$out"

  # Belt and braces. `caddy validate` on the node would reject the placeholder
  # too — it is not a CIDR — but that check runs after the object is already in
  # S3, where the next node replacement would pick it up. Refuse here instead.
  if grep -q '__ALB_' "$out"; then
    echo "rendered Caddyfile still contains an unsubstituted placeholder; refusing to upload" >&2
    exit 1
  fi
}

# The canonical object is PUBLISHED LAST, and this is the whole reason.
#
# `_caddy/Caddyfile` is not just this run's input. The node bootstrap
# (infra/modules/app-node/user-data.sh.tftpl) copies whatever is under that key
# onto a brand-new node at boot. So writing it before the config has been
# validated makes every future node replacement the blast radius of a syntax
# error in this render: this node keeps its previous config and looks fine,
# while the next node to come up — at a scale-out, or after an instance
# replacement weeks later — takes the broken object and never serves.
#
# The placeholder guard above is specific: it catches an unsubstituted
# `__ALB_SUBNET_CIDRS__` and nothing else. Every OTHER way a render can be
# invalid — a stray brace, a directive `caddy:2` does not know, a bad CIDR from
# the ALB lookup — is only caught by `caddy validate`, and that runs on the
# node, after the upload.
#
# So upload a CANDIDATE, validate it there, and promote it to the canonical key
# only once the node has accepted it. A failed validation leaves the canonical
# object exactly as it was: not deleted, not half-written, not touched at all.
# The promotion is a single server-side copy, so a reader (the bootstrap) sees
# either the whole old object or the whole new one and never a partial write.
#
# Nothing reads the candidate key but the remote script in this same run. Do
# not point a reader at it — it exists precisely because it carries no
# authority until it is promoted.
CANDIDATE_KEY="_caddy/Caddyfile.candidate.$(date -u +%Y%m%dT%H%M%SZ).$$"

CADDYFILE_RENDERED=$(mktemp "${TMPDIR:-/tmp}/oxagen-caddyfile-XXXXXX")
REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-params-XXXXXX")

# One trap, not three. Each `trap ... EXIT` REPLACES the previous one, so the
# three this file used to install left the first two files behind — and would
# now leave a candidate object in the bucket on any early exit.
cleanup() {
  rm -f "$CADDYFILE_RENDERED" "$REMOTE_FILE" "$PARAMS_FILE"
  if [[ -n "${CANDIDATE_UPLOADED:-}" ]]; then
    aws s3 rm "s3://$BUCKET/$CANDIDATE_KEY" --region "$REGION" --only-show-errors \
      || echo "warning: could not remove candidate s3://$BUCKET/$CANDIDATE_KEY" >&2
  fi
}
trap cleanup EXIT

echo "==> uploading tools/caddy/$CADDYFILE -> s3://$BUCKET/$CANDIDATE_KEY (candidate)"
render_caddyfile "$HERE/caddy/$CADDYFILE" "$CADDYFILE_RENDERED"
aws s3 cp "$CADDYFILE_RENDERED" "s3://$BUCKET/$CANDIDATE_KEY" \
  --region "$REGION" --only-show-errors
CANDIDATE_UPLOADED=1

read -r -d '' REMOTE_TEMPLATE <<'REMOTE_EOF' || true
set -euxo pipefail
mkdir -p /opt/oxagen/bin /opt/oxagen/services
# Fail the install rather than the first deploy if a dependency is missing.
# `flock` is on this list because the Caddy block below is serialised with it,
# and a missing flock would otherwise read as "no other install is running".
for tool in jq python3 curl docker aws flock; do
  command -v "$tool" >/dev/null || { echo "missing dependency: $tool"; exit 1; }
done
aws s3 sync s3://__BUCKET__/_bin/ /opt/oxagen/bin/ --region __REGION__ --delete
chmod 0755 /opt/oxagen/bin/*.sh
bash -n /opt/oxagen/bin/deploy-service.sh
ls -l /opt/oxagen/bin

# Caddy is the single point every public request passes through, so the new
# config is validated before it is installed and the running one is left alone
# if it does not parse. `caddy reload` would refuse a bad config too, but by
# then the file on disk is already wrong and the next container restart picks
# it up — which turns a typo into an outage that appears hours later.
#
# This reads the CANDIDATE key, not the canonical one. `set -e` is on, so a
# validation failure ends this script, SSM reports Failed, and the caller never
# promotes — which is what keeps a bad render out of the object a future node
# boots from.
# >>> caddy-install
# One install at a time on this node, across fetch, validate, swap and reload.
#
# Everything from here to the end of this block is shared, mutable node state:
# the staging file `/tmp/Caddyfile.incoming` is a fixed path with no run id in
# it, and `/opt/oxagen/caddy/Caddyfile`, its `.prev`, and the running Caddy
# process are the node itself and cannot be given a per-run copy. Two invocations
# — an operator retrying while the first SSM command is still in flight, which
# is exactly what a node replacement invites — interleave like this:
#
#   A fetches its candidate      -> incoming = bytesA
#   B fetches its candidate      -> incoming = bytesB   (same path, overwritten)
#   A validates                  -> validates bytesB
#   A swaps and reloads          -> the node runs bytesB
#   A exits 0, SSM reports Success, and A's caller promotes CANDIDATE A
#
# The canonical object is then bytesA: a render no node validated, and not the
# one this node is running. That is the validate-before-publish guarantee
# inverted — the publish happens, and what it publishes is the thing that was
# never checked. B tearing the staging file out from under A is the same race
# with a louder symptom, not a milder one.
#
# Isolating the staging file per run does NOT fix this, which is why there is
# one mechanism here and not two. The swap window is the same defect without the
# staging file: B copies the live config to `.prev` while A has already written
# its unaccepted candidate there, so B's rollback target is a config nothing
# accepted, and either trap can then restore it over the other run's work. Those
# paths are the node's state, so the only thing that can be made exclusive is
# the RUN.
#
# The lock is released by process exit and by nothing else. That ordering is
# load-bearing: bash runs EXIT traps before the process exits, so
# `caddy_restore_if_unaccepted` below runs while this run still holds the lock
# and cannot restore a file another run is midway through staging. Never add
# `flock -u` or `exec 200>&-` — an early release puts back the worse half of the
# bug this closes, with the rollback path inside the race instead of the swap.
#
# A bounded wait rather than an indefinite one: a near-simultaneous double-send
# is absorbed, a genuine overlap is refused with a reason inside the caller's
# poll window, and the refusal fails the run — so SSM reports Failed and the
# caller does not promote.
#
# An earlier revision of this comment went on to argue that queueing was
# therefore safe, reasoning that a waiter cannot finish before the run it waited
# on. That premise is true; the conclusion drawn from it — that the promotions
# then land in the same order — does not follow, and the sentence is paraphrased
# here rather than quoted because the check that forbids it reads this file as
# text and a quotation is indistinguishable from a claim. This lock orders the
# two runs ON THE NODE; the promotion is
# a separate S3 write made by each run's CALLER, on whatever machine invoked the
# installer, after a polling loop with five-second granularity. Node order does
# not imply caller order. See the note on the promotion at the bottom of this
# file for the interleaving that leaves the node and the canonical object
# disagreeing, and for why it cannot be closed from inside this lock.
mkdir -p /opt/oxagen/caddy
exec 200>/opt/oxagen/caddy-install.lock
if ! flock -x -w 60 200; then
  echo "CADDY: another install holds /opt/oxagen/caddy-install.lock — not proceeding." >&2
  echo "      Wait for the in-flight run to finish, then retry. Nothing was changed" >&2
  echo "      on this node and no candidate was promoted." >&2
  exit 1
fi

aws s3 cp s3://__BUCKET__/__CANDIDATE_KEY__ /tmp/Caddyfile.incoming --region __REGION__
docker run --rm -v /tmp/Caddyfile.incoming:/etc/caddy/Caddyfile:ro caddy:2 \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# `/opt/oxagen/caddy/Caddyfile` is what the `cmp` below compares against, so it
# has to mean "the config Caddy ACCEPTED". Between the copy and a successful
# reload it means something else — a candidate that has been written and not yet
# accepted — and if the script ends in that window the file keeps that meaning
# forever, because nothing reads it again to find out.
#
# That is the whole of the defect this guard closes, and it is a chain rather
# than a line. A transient `caddy reload` failure aborted here under `set -e`;
# the candidate stayed on disk; SSM reported Failed and the candidate was
# correctly NOT promoted. Then the retry, with the same render, compared that
# render against the file the FAILED attempt had left — found them identical —
# printed "caddy config unchanged", skipped the reload, exited 0, and the caller
# promoted the candidate to the canonical key and reported success. An operator
# reading that success then enables TRUST_EDGE_CLIENT_IP_HEADER while Caddy is
# still running the OLD config, which has no rule for x-oxagen-client-ip and
# forwards a caller-supplied copy unchanged — and the IAM `ip_ranges` bypass
# this whole branch exists to close is open again, by a route that reports
# green at every step.
#
# `cmp -s` was asking the wrong question: whether the render differs from a file
# on disk, when what it needs is whether the render differs from what Caddy is
# running. The cheap fix is to keep the file honest rather than to find a second
# source of truth. Reading the running config instead is stronger — `caddy adapt`
# plus the admin API at :2019 — but it compares adapted JSON to adapted JSON,
# needs canonicalisation to do that safely, and silently changes meaning if a
# future Caddyfile disables the admin endpoint. Not cheap, so not taken.
#
# The restore is a trap and NOT the `set -e` unwind, because `set -e` restores
# nothing: it is the mechanism that skipped the restore in the first place. The
# trap is installed unconditionally, above the branch, so a future early return
# anywhere below cannot step over it; `CADDY_SWAPPED` is what decides whether it
# has anything to undo. It is the only `trap ... EXIT` in this remote script —
# a second one would REPLACE it rather than add to it.
caddy_restore_if_unaccepted() {
  [ -n "${CADDY_SWAPPED:-}" ] || return 0
  if [ -n "${CADDY_HAD_PREV:-}" ]; then
    cp -f /opt/oxagen/caddy/Caddyfile.prev /opt/oxagen/caddy/Caddyfile
    echo "CADDY: reload did not succeed — restored the last accepted config" >&2
  else
    # First install on this node: there is no accepted config to go back to, so
    # the candidate is REMOVED. Leaving it would make the next run's `cmp`
    # report unchanged against a file nothing ever accepted, which is the same
    # defect reached by a different route.
    rm -f /opt/oxagen/caddy/Caddyfile
    echo "CADDY: reload did not succeed on first install — removed the unaccepted candidate" >&2
  fi
}
trap caddy_restore_if_unaccepted EXIT

if cmp -s /tmp/Caddyfile.incoming /opt/oxagen/caddy/Caddyfile; then
  echo "caddy config unchanged"
else
  if [ -f /opt/oxagen/caddy/Caddyfile ]; then
    cp /opt/oxagen/caddy/Caddyfile /opt/oxagen/caddy/Caddyfile.prev
    CADDY_HAD_PREV=1
  else
    # Stale .prev from an earlier node state would otherwise be restored over a
    # first install as though it were this node's accepted config.
    rm -f /opt/oxagen/caddy/Caddyfile.prev
    CADDY_HAD_PREV=
  fi
  CADDY_SWAPPED=1
  cp /tmp/Caddyfile.incoming /opt/oxagen/caddy/Caddyfile
  docker exec oxagen-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  # Cleared only on the line AFTER the reload returned 0. Anything that ends the
  # script before here leaves it set, and the trap puts the old config back.
  CADDY_SWAPPED=
  echo "caddy reloaded"
fi
rm -f /tmp/Caddyfile.incoming
# <<< caddy-install
REMOTE_EOF

# __BUCKET__/__REGION__ in the template are substituted here rather than
# being shell variables inside the heredoc, so the script that lands on the
# instance has this run's literal values baked in — the instance never needs
# to know REGION or BUCKET at all, only /opt/oxagen/bin/node.env does (via
# deploy-service.sh, at deploy time).
REMOTE=${REMOTE_TEMPLATE//__BUCKET__/$BUCKET}
REMOTE=${REMOTE//__REGION__/$REGION}
REMOTE=${REMOTE//__CANDIDATE_KEY__/$CANDIDATE_KEY}

# The script goes to SSM as a JSON file, not as an inline shell-interpolated
# argument. Interpolating it collapsed every newline into a literal "n" during
# the migration, so the remote shell received one run-on line and reported
# Success for a command that had executed nothing.
printf '%s\n' "$REMOTE" > "$REMOTE_FILE"

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
script = open(sys.argv[1]).read()
json.dump({"commands": script.splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command \
  --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)

echo "==> ssm command $CMD"
for _ in $(seq 1 30); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
       --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending ]] || break
  sleep 5
done

echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text 2>/dev/null | tail -20
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardErrorContent --output text 2>/dev/null | tail -20

if [[ $st != Success ]]; then
  echo "==> remote install did not succeed ($st)" >&2
  echo "    s3://$BUCKET/_caddy/Caddyfile is UNCHANGED — the candidate was never promoted," >&2
  echo "    so a node replacement still boots the last config this node validated." >&2
  exit 1
fi

# The node validated this render and is running it. Promote the candidate to the
# key the bootstrap reads, as one server-side copy: S3 object writes are atomic
# for a reader, so a node booting during this instant gets the whole old object
# or the whole new one.
#
# ## This write is OUTSIDE the node lock, and cannot be brought inside it
#
# The `flock` in the remote script orders two installs on the node. It is
# released when the SSM command exits, which is before this line runs, and this
# line runs here — on the machine that invoked the installer, not on the node. So:
#
#   A's node run reloads A and exits; B waits, reloads B, exits
#   B's caller polls, sees Success, promotes B     <- canonical = B, node = B
#   A's caller was slower to poll, and promotes A  <- canonical = A, node = B
#
# Nothing reports an error. The divergence surfaces when a LATER node boots the
# canonical object and comes up on A — which, after `TRUST_EDGE_CLIENT_IP_HEADER`
# is set, means a node whose Caddy does not write `x-oxagen-client-ip` while the
# application believes that header. Stale is not merely old there.
#
# The lock cannot be widened to cover this, and the reason is structural rather
# than a matter of effort. The only actor that knows, atomically, which render
# the node most recently accepted is whoever holds the lock, and the lock is on
# the node. Every caller-side variant is a check followed by a separate act with
# a window between them: comparing against the canonical object's ETag before the
# install refuses the WRONG run when A promotes first, and re-reading the node's
# accepted digest just before this copy narrows the window to one SSM round-trip
# without closing it. Releasing the lock later does not help either — it is the
# `trap ... EXIT` restore that requires the lock to outlive the remote script,
# which is precisely what puts this line outside it.
#
# What does close it is for the node to make this write itself, inside the lock,
# immediately after the reload it just accepted. That is one mechanism rather
# than two, and it is blocked on a decision rather than on code: the app node's
# role grants `s3:GetObject` and `s3:ListBucket` on this bucket and nothing more
# (`infra/stacks-new/ci-deploy/node.tf`, "The read side of the deploy path"), so
# the node would need `s3:PutObject` on `_caddy/Caddyfile` — the object every
# future node boots from. That widens what a compromised app node can reach, in
# the one direction this branch is otherwise narrowing, and it is not a trade to
# make silently inside a rate-limiter reconciliation. Until it is made, two
# installers must not be run against one node concurrently.
echo "==> promoting candidate -> s3://$BUCKET/_caddy/Caddyfile"
aws s3 cp "s3://$BUCKET/$CANDIDATE_KEY" "s3://$BUCKET/_caddy/Caddyfile" \
  --region "$REGION" --only-show-errors
