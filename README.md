# Airtable -> GitHub Workflows

This repository receives `repository_dispatch` events from Airtable automations, generates an `.ics` calendar file from an Airtable record, and writes the file back to Airtable.

## What this workflow does

1. Airtable automation sends a `repository_dispatch` event (`airtable_event`) with `recordId`.
2. GitHub Actions runs [`scripts/process-airtable-event.js`](scripts/process-airtable-event.js).
3. The script:
   - fetches the Airtable record,
   - builds a standards-friendly ICS (`UTC`, stable `UID`, escaped text),
   - uploads the ICS to Airtable attachment field,
   - updates `ICS Updated At` so your automation can skip already-processed records.

## Required Airtable fields

Use these field names in your table:

- `Event Name` (single line text)
- `Start` (date/time)
- `End` (date/time)
- `Location` (optional)
- `Description` (optional)
- `ICS` (attachment field)
- `ICS Updated At` (date/time)

## Required GitHub secrets

### Recommended (multiple automations)

Set one JSON secret named `AIRTABLE_AUTOMATIONS`, keyed by `automationKey`:

```json
{
  "events_eu": {
    "token": "patXXXXXXXXXXXXXX",
    "baseId": "appXXXXXXXXXXXXXX",
    "tableId": "tblXXXXXXXXXXXXXX",
    "icsField": "ICS",
    "updatedAtField": "ICS Updated At"
  },
  "events_us": {
    "token": "patYYYYYYYYYYYYYY",
    "baseId": "appYYYYYYYYYYYYYY",
    "tableName": "Events",
    "icsField": "ICS",
    "updatedAtField": "ICS Updated At",
    "releaseTag": "airtable-ics-assets-us"
  }
}
```

Per-automation keys:

- `token` (optional if you set global `AIRTABLE_TOKEN`)
- `baseId` (required)
- `tableId` or `tableName` (required unless passed in payload)
- `icsField` (required)
- `updatedAtField` (required)
- `releaseTag` (optional)

Then dispatch with:

- `client_payload.recordId` (required)
- `client_payload.automationKey` (required when more than one config exists)
- `client_payload.tableName` (optional override)

### Backward-compatible (single automation)

You can still use individual secrets:

- `AIRTABLE_TOKEN` (Airtable PAT)
- `AIRTABLE_BASE_ID` (e.g. `appXXXXXXXXXXXXXX`)
- `AIRTABLE_TABLE_ID` (table ID like `tbl...` or table name)
- `AIRTABLE_ICS_FIELD` (attachment field name, e.g. `ICS`)
- `AIRTABLE_UPDATED_AT_FIELD` (e.g. `ICS Updated At`)

Optional:

- `AIRTABLE_ICS_RELEASE_TAG` (default: `airtable-ics-assets`)

## Attachment upload approach

Implemented in this repo:

1. Preferred path: Airtable direct upload endpoint  
   `POST https://content.airtable.com/v0/{baseId}/{recordId}/{attachmentField}/uploadAttachment`

2. Fallback path (if direct upload fails):  
   upload the ICS as a GitHub Release asset (tag: `airtable-ics-assets` by default), then write the asset URL into the Airtable attachment field.

Notes:

- Fallback uses `GITHUB_TOKEN` automatically available in Actions.
- URL-based fallback works best when the repository is public, so Airtable can download the asset URL.

## Airtable automation script example (Script action)

In Airtable Automation, add a **Run script** action and call GitHub API:

```javascript
const inputConfig = input.config();
const recordId = inputConfig.recordId; // map from trigger step
const automationKey = inputConfig.automationKey; // e.g. "events_eu"

const owner = "YOUR_GITHUB_OWNER";
const repo = "airtable_wf";
const githubToken = inputConfig.githubToken; // store securely in Airtable automation input/secret

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${githubToken}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  },
  body: JSON.stringify({
    event_type: "airtable_event",
    client_payload: {
      recordId,
      automationKey,
      // optional:
      // tableName: "Events"
    },
  }),
});

if (!res.ok) {
  const text = await res.text();
  throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
}
```

## Local testing

1. Create a sample event file:

```json
{
  "client_payload": {
    "recordId": "recXXXXXXXXXXXXXX",
    "automationKey": "events_eu",
    "tableName": "Events"
  }
}
```

2. Run the script:

```bash
export AIRTABLE_AUTOMATIONS='{"events_eu":{"token":"pat...","baseId":"app...","tableId":"tbl...","icsField":"ICS","updatedAtField":"ICS Updated At"}}'
export GITHUB_EVENT_PATH="$PWD/sample-event.json"

node scripts/process-airtable-event.js
```

Single-automation mode still works with the individual env vars above.

You can also pass the event file as CLI arg:

```bash
node scripts/process-airtable-event.js ./sample-event.json
```
