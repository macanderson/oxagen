# schema.version.diff

Structural diff of two schema versions: added/removed/changed schemas, labels, relationship types, and properties. Useful for audit and release review before pinning.

## Mode
**sync**

## Surfaces
- API: `GET /v1/schema/versions/diff`
- MCP: `schema.version.diff`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromVersionId` | string | yes | Base version for comparison |
| `toVersionId` | string | yes | Target version for comparison |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `schemasAdded` | string[] | Schema names added in `toVersion` |
| `schemasRemoved` | string[] | Schema names removed in `toVersion` |
| `labelsAdded` | object[] | Labels added: `{schemaName, labelName}` |
| `labelsRemoved` | object[] | Labels removed: `{schemaName, labelName}` |
| `labelsChanged` | object[] | Labels changed: `{schemaName, labelName, changes: string[]}` |
| `relationshipTypesAdded` | object[] | Types added: `{schemaName, relationshipTypeName}` |
| `relationshipTypesRemoved` | object[] | Types removed: `{schemaName, relationshipTypeName}` |
| `relationshipTypesChanged` | object[] | Types changed: `{schemaName, relationshipTypeName, changes: string[]}` |
| `propertiesAdded` | object[] | Properties added: `{ownerName, key}` |
| `propertiesRemoved` | object[] | Properties removed: `{ownerName, key}` |
| `propertiesChanged` | object[] | Properties changed: `{ownerName, key, changes: string[]}` |

## Example

**Request:**
```http
GET /v1/schema/versions/diff?fromVersionId=ver_006&toVersionId=ver_007
```

**Response:**
```json
{
  "schemasAdded": [],
  "schemasRemoved": [],
  "labelsAdded": [
    { "schemaName": "crm", "labelName": "Contract" }
  ],
  "labelsRemoved": [
    { "schemaName": "crm", "labelName": "LegacyAccount" }
  ],
  "labelsChanged": [],
  "relationshipTypesAdded": [
    { "schemaName": "crm", "relationshipTypeName": "SIGNED_CONTRACT" }
  ],
  "relationshipTypesRemoved": [],
  "relationshipTypesChanged": [],
  "propertiesAdded": [
    { "ownerName": "Contract", "key": "value" },
    { "ownerName": "Contract", "key": "signedAt" }
  ],
  "propertiesRemoved": [],
  "propertiesChanged": []
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: medium.
- Either `versionId` can be the current draft — use the draft's `versionId` from `schema.version.list`.
- `changes` arrays within `labelsChanged`, `relationshipTypesChanged`, and `propertiesChanged` contain human-readable descriptions of field-level changes (e.g. `"description updated"`, `"required changed from false to true"`).

## Related
- `schema.version.list` — discover available version IDs
- `schema.version.pin` — pin after reviewing the diff
- `schema.reconcile.dispatch` — re-label graph data after a structural change
