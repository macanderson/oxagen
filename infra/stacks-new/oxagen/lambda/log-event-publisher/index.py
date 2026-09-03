"""Parse CloudWatch Logs subscription-filter records and republish each
matched line as a structured event on the oxagen-incidents EventBridge bus.

CloudWatch delivers a subscription filter's matches to Lambda as a single
invocation carrying a base64-encoded, gzip-compressed JSON blob — never as
plain event records — so decoding that envelope is the first thing this
function does, not an edge case.

Each log event's `message` is treated as JSON if it parses as JSON (the
convention every service here is expected to log in: {"level", "msg",
"source", "line", "trace_id", ...}), and passed through unparsed under
`raw_message` otherwise. This function cannot invent a source file, a line
number, or a trace id that the log line never carried — it forwards
structured fields it finds and forwards nothing it does not.
"""

import base64
import gzip
import json
import os

import boto3

EVENT_BUS_NAME = os.environ["EVENT_BUS_NAME"]
_events = boto3.client("events")


def handler(event, _context):
    payload = base64.b64decode(event["awslogs"]["data"])
    envelope = json.loads(gzip.decompress(payload))

    log_group = envelope.get("logGroup", "")
    log_stream = envelope.get("logStream", "")

    entries = []
    for log_event in envelope.get("logEvents", []):
        message = log_event.get("message", "")
        try:
            parsed = json.loads(message)
            detail = parsed if isinstance(parsed, dict) else {"raw_message": message}
        except (json.JSONDecodeError, TypeError):
            detail = {"raw_message": message}

        detail["log_group"] = log_group
        detail["log_stream"] = log_stream
        detail["ingested_at"] = log_event.get("timestamp")

        entries.append(
            {
                "Source": "oxagen.logs",
                "DetailType": "log.warning_or_error",
                "Detail": json.dumps(detail),
                "EventBusName": EVENT_BUS_NAME,
            }
        )

    # PutEvents caps a single call at 10 entries.
    for i in range(0, len(entries), 10):
        batch = entries[i : i + 10]
        if not batch:
            continue
        response = _events.put_events(Entries=batch)
        if response.get("FailedEntryCount"):
            # Logged rather than raised: a partial publish failure should not
            # make CloudWatch retry the whole batch and re-publish the
            # entries that already succeeded.
            print(f"put_events partial failure: {response['Entries']}")

    return {"published": len(entries)}
