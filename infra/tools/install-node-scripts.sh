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
aws s3 sync s3://__BUCKET__/_bin/ /opt/oxagen/bin/ --region __REGION__ --delete
chmod 0755 /opt/oxagen/bin/*.sh
# Fail the install rather than the first deploy if a dependency is missing.
for tool in jq python3 curl docker aws; do
  command -v "$tool" >/dev/null || { echo "missing dependency: $tool"; exit 1; }
done
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
echo "==> promoting candidate -> s3://$BUCKET/_caddy/Caddyfile"
aws s3 cp "s3://$BUCKET/$CANDIDATE_KEY" "s3://$BUCKET/_caddy/Caddyfile" \
  --region "$REGION" --only-show-errors
