#!/usr/bin/env python3
"""Turn a Vercel DNS export into the record set Terraform recreates in Route 53.

Run once per domain while the old provider is still readable:

    python3 tools/import-dns.py dns-oxagen.sh.json > stacks/oxagen/imported-dns.json

The point is to move the records that have nothing to do with hosting — mail
routing, DKIM keys, domain-ownership proofs — without a human retyping a
400-character public key. Everything this drops, it drops for a stated reason:

  ALIAS/A/AAAA at a name we are about to serve
      Replaced by the CloudFront alias records the site modules create. Keeping
      the old value would point the name at the host we are migrating off.

  The wildcard record
      `*.oxagen.sh` currently sends every unclaimed subdomain to the old host.
      Carried over, it would resolve names we are not hosting to somewhere that
      answers HTTP 402, which reads as "broken site" rather than "no such
      site". A subdomain we actually serve gets an explicit record instead.

  CAA
      Rewritten rather than copied, because the existing set authorises three
      issuers and Amazon is not among them. Copied verbatim it would block ACM
      from issuing at all — the certificate request simply fails validation
      with no obvious cause. See `caa_issuers` in the stack.
"""

from __future__ import annotations

import json
import sys

# Record types that describe where the site is hosted, as opposed to what the
# domain proves or how its mail is routed. These are the migration's subject,
# so they are never carried across.
HOSTING_TYPES = {"ALIAS", "A", "AAAA"}

# Rewritten by the stack, never copied.
REWRITTEN_TYPES = {"CAA"}

# A single character-string in a TXT record cannot exceed 255 bytes. A longer
# value is expressed as several adjacent quoted strings, which resolvers
# concatenate — that is how a 2048-bit DKIM key fits in DNS at all.
TXT_CHUNK = 255


def quote_txt(value: str) -> str:
    """Render one TXT value the way the Terraform AWS provider wants it.

    The provider wraps every TXT value in quotes on its way to the API, so a
    value that arrives already quoted reaches Route 53 as `""like this""` and
    is rejected as an invalid character-string. Short values therefore go
    across raw.

    That auto-quoting leaves no direct way to express a value longer than the
    255-byte limit for a single character-string. The way through is to close
    and reopen the quoting inside the value: emitting `chunk1" "chunk2` lets
    the provider's own outer quotes complete it into the `"chunk1" "chunk2"`
    that Route 53 parses as two adjacent strings. Ugly, and the only form that
    survives the round trip — which is why a 2048-bit DKIM key needs it.
    """
    if len(value) <= TXT_CHUNK:
        return value
    chunks = [value[i : i + TXT_CHUNK] for i in range(0, len(value), TXT_CHUNK)]
    return '" "'.join(chunks)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    with open(sys.argv[1]) as fh:
        records = json.load(fh).get("records", [])

    grouped: dict[str, dict] = {}
    skipped: list[str] = []

    for rec in records:
        rtype = rec.get("type")
        name = rec.get("name") or ""

        if rtype in HOSTING_TYPES or rtype in REWRITTEN_TYPES or name == "*":
            skipped.append(f"{rtype} {name or '@'}")
            continue

        value = rec.get("value", "")
        if rtype == "MX":
            # Route 53 carries the preference in the record value itself.
            value = f"{rec.get('mxPriority', 10)} {value}"
        elif rtype == "TXT":
            value = quote_txt(value)

        # Route 53 holds one resource record set per (name, type); several
        # values of the same type at the same name belong in one set, not in
        # competing sets that would overwrite each other.
        key = f"{name or '@'}|{rtype}"
        entry = grouped.setdefault(
            key, {"name": name, "type": rtype, "ttl": rec.get("ttl") or 300, "records": []}
        )
        entry["records"].append(value)
        # Several values at one name can disagree on TTL; the shortest is the
        # only choice that cannot serve a stale answer.
        entry["ttl"] = min(entry["ttl"], rec.get("ttl") or 300)

    print(json.dumps(grouped, indent=2, sort_keys=True))
    print(
        f"# carried {len(grouped)} record sets; skipped {len(skipped)}: {', '.join(skipped)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
