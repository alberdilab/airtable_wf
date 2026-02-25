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
- `ICS Updated At` (editable date/date-time or text; not formula/lookup)

## Repository config file

Non-secret Airtable settings now live in a repo JSON file:
[config/airtable-automations.json](config/airtable-automations.json)

Example:

```json
{
  "events_eu": {
    "baseId": "appXXXXXXXXXXXXXX",
    "tableId": "tblXXXXXXXXXXXXXX",
    "icsField": "ICS",
    "updatedAtField": "ICS Updated At",
    "releaseTag": "airtable-ics-assets-eu"
  },
  "events_us": {
    "baseId": "appYYYYYYYYYYYYYY",
    "tableName": "Events",
    "icsField": "ICS",
    "updatedAtField": "ICS Updated At"
  }
}
```

Per-automation keys:

- `baseId` (required)
- `tableId` or `tableName` (required unless passed in payload)
- `icsField` (required)
- `updatedAtField` (required)
- `releaseTag` (optional, default: `airtable-ics-assets`)
- `eventNameField` (optional, default: `Event Name`)
- `startField` (optional, default: `Start`)
- `endField` (optional, default: `End`)
- `locationField` (optional, default: `Location`)
- `descriptionField` (optional, default: `Description`)

Dispatch payload:

- `client_payload.recordId` (required)
- `client_payload.automationKey` (required when config has multiple entries)
- `client_payload.tableName` (optional override)

## Required GitHub secrets

- `AIRTABLE_TOKEN` (Airtable PAT)

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
export AIRTABLE_TOKEN="pat..."
export GITHUB_EVENT_PATH="$PWD/sample-event.json"

node scripts/process-airtable-event.js
```

Optional: use a non-default config file path:

```bash
export AIRTABLE_CONFIG_PATH="$PWD/config/airtable-automations.json"
```

You can also pass the event file as CLI arg:

```bash
node scripts/process-airtable-event.js ./sample-event.json
```
