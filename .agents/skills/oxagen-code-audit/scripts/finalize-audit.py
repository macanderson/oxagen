#!/usr/bin/env python3
"""Finalize the audit dataset: set real `applied` flags from the workflow's
fix-agent applied[] lists, populate fixesApplied/fixesSkipped, recompute rollup."""
import json, sys

data = json.load(open('/tmp/audit.json'))

wf_applied = data.get('_wfFixesApplied', [])
applied_ids = {a['id'] for a in wf_applied}

# mark findings
for f in data['findings']:
    f['applied'] = f['id'] in applied_ids
    f.pop('wfClaimedApplied', None)

# per-unit applied counts
unit_applied = {}
for a in wf_applied:
    unit_applied[a['unit']] = unit_applied.get(a['unit'], 0) + 1
for u in data['unitSummaries']:
    u['applied'] = unit_applied.get(u['unit'], 0)

# fixesApplied is the authoritative list
data['fixesApplied'] = [{'id': a['id'], 'files': a.get('files', []), 'summary': a.get('summary', ''), 'unit': a['unit']} for a in wf_applied]
data['fixesSkipped'] = data.get('fixesSkipped', [])

# tickets = confirmed needs-approval
confirmed = [f for f in data['findings'] if f['verdict'] == 'confirmed']
tickets = [f for f in confirmed if f['verifiedFixClass'] == 'needs-approval']
data['tickets'] = tickets

def count_by(arr, key):
    m = {}
    for x in arr:
        k = x.get(key)
        if k is not None:
            m[k] = m.get(k, 0) + 1
    return m

data['rollup'].update({
    'units': len(data['unitSummaries']),
    'totalFindings': len(data['findings']),
    'confirmed': len(confirmed),
    'falsePositive': sum(1 for f in data['findings'] if f['verdict'] == 'false-positive'),
    'uncertain': sum(1 for f in data['findings'] if f['verdict'] == 'uncertain'),
    'bySeverityConfirmed': count_by(confirmed, 'verifiedSeverity'),
    'byCategoryConfirmed': count_by(confirmed, 'category'),
    'fixesApplied': len(data['fixesApplied']),
    'fixesSkipped': len(data['fixesSkipped']),
    'ticketsNeeded': len(tickets),
})

# drop internal scratch keys from the shipped dataset
data.pop('_wfFixesApplied', None)
data.pop('_autoFixSafe', None)

json.dump(data, open('/tmp/audit-final.json', 'w'), indent=1)
print('applied:', len(applied_ids))
print('confirmed:', len(confirmed), ' tickets(needs-approval):', len(tickets))
print('rollup fixesApplied:', data['rollup']['fixesApplied'])
print('per-unit applied:', {u['unit']: u['applied'] for u in data['unitSummaries'] if u['applied']})
