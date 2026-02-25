# Airtable -> GitHub ICS Automation

This repo wires Airtable automations to GitHub Actions and back to Airtable.

The core loop is:

1. Airtable record changes.
2. Airtable automation sends `repository_dispatch` to GitHub.
3. GitHub Action builds an ICS file from the record.
4. GitHub Action writes the ICS attachment back to the same Airtable record.
5. GitHub Action updates a timestamp field so the record does not keep retriggering.

---

## How It Is Wired

### 1) Trigger in Airtable

An Airtable Automation triggers on record changes and runs a small script.

That script sends:

- `event_type: "airtable_event"`
- `client_payload.recordId`
- `client_payload.automationKey` (which config to use in this repo)

to:

- `POST https://api.github.com/repos/{owner}/{repo}/dispatches`

### 2) Trigger in GitHub

Workflow: [.github/workflows/airtable-dispatch.yml](.github/workflows/airtable-dispatch.yml)

- Listens on `repository_dispatch` type `airtable_event`
- Runs Node 20
- Executes [scripts/process-airtable-event.js](scripts/process-airtable-event.js)

### 3) Processor script

Script: [scripts/process-airtable-event.js](scripts/process-airtable-event.js)

What it does:

1. Reads GitHub event payload (`GITHUB_EVENT_PATH`)
2. Resolves automation config from [config/airtable-automations.json](config/airtable-automations.json)
3. Fetches Airtable record by `recordId`
4. Builds a valid ICS:
   - stable UID from Airtable record id
   - UTC timestamps (`DTSTAMP`, `DTSTART`, `DTEND`)
   - escaped ICS text fields
5. Uploads ICS back to Airtable attachment field
6. Normalizes attachment field to a single latest ICS file (prevents duplicates)
7. Updates configured `updatedAtField`

---

## Configuration Model

### Secrets (GitHub)

Required secret:

- `AIRTABLE_TOKEN`

Notes:

- This is the Airtable PAT used by GitHub Action.
- Non-secret config stays in repo JSON.

### Repo config file

File: [config/airtable-automations.json](config/airtable-automations.json)

Each top-level key is one automation target. Example:

```json
{
  "ehi_events": {
    "baseId": "appXXXXXXXXXXXXXX",
    "tableName": "Events",
    "eventNameField": "Name",
    "icsField": "ICS",
    "updatedAtField": "ICS_update",
    "releaseTag": "airtable-ics-assets_ehi"
  },
  "alberdilab_events": {
    "baseId": "appYYYYYYYYYYYYYY",
    "tableName": "Events",
    "eventNameField": "Name",
    "icsField": "ICS",
    "updatedAtField": "ICS_update",
    "releaseTag": "airtable-ics-assets_alberdilab"
  }
}
```

Per-automation keys:

- `baseId` (required)
- `tableId` or `tableName` (required unless payload overrides with `tableName`)
- `icsField` (required, attachment field)
- `updatedAtField` (required, editable field)
- `releaseTag` (optional, fallback upload tag)
- `eventNameField` (optional, default `Event Name`)
- `startField` (optional, default `Start`)
- `endField` (optional, default `End`)
- `locationField` (optional, default `Location`)
- `descriptionField` (optional, default `Description`)

Dispatch payload requirements:

- `client_payload.recordId` (required)
- `client_payload.automationKey` (required when config has multiple entries)
- `client_payload.tableName` (optional override)

---

## Airtable Setup (Per Base)

### Required fields in your `Events` table

- Event title field (`Name` in this repo config)
- Start date/time field
- End date/time field
- Location field (optional)
- Description field (optional)
- `ICS` (attachment field)
- `ICS_update` (editable date/date-time or text)

Important:

- `updatedAtField` must be writable.
- Do not use formula/lookup/rollup/created time/last modified time as `updatedAtField`.

### Recommended anti-loop trigger pattern

Use a view-based automation trigger, for example:

1. Add formula field `Needs_ICS_Sync`:

```text
AND(
  {Start},
  {End},
  OR(
    {ICS_update}=BLANK(),
    LAST_MODIFIED_TIME({Name},{Start},{End},{Location},{Description}) > {ICS_update}
  )
)
```

2. Create view filtered by `Needs_ICS_Sync = 1`
3. Trigger automation on "When record enters view"

This avoids rapid re-trigger loops.

---

## Airtable Script Action

In Airtable Automation:

1. Input variables:
   - `recordId` from trigger
   - `automationKey` static value matching config key (for example `alberdilab_events`)
2. Secret:
   - `github_token` (GitHub PAT)

Script:

```javascript
const { recordId, automationKey } = input.config();
const githubToken = input.secret("github_token");

const owner = "YOUR_GITHUB_OWNER_OR_ORG";
const repo = "airtable_wf";

if (!recordId) throw new Error("Missing recordId");
if (!automationKey) throw new Error("Missing automationKey");
if (!githubToken) throw new Error('Missing secret "github_token"');

const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    event_type: "airtable_event",
    client_payload: {
      recordId,
      automationKey,
    },
  }),
});

const text = await res.text();
if (!res.ok) {
  throw new Error(`Dispatch failed ${res.status}: ${text}`);
}
```

---

## GitHub Token for Airtable Script

The token used in Airtable script must be able to dispatch into this repo.

Recommended:

- Fine-grained PAT
- Resource owner = repo owner (org if org repo)
- Repository selected = this repo
- Permission: `Contents` -> `Read and write`

Store it in Airtable as an Automation secret (`github_token`), not as plain input.

---

## Testing

### Manual dispatch test

```bash
curl -i -X POST \
  -H "Authorization: Bearer <GH_TOKEN>" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/<OWNER>/<REPO>/dispatches \
  -d '{"event_type":"airtable_event","client_payload":{"recordId":"rec123","automationKey":"alberdilab_events"}}'
```

Expected: `204 No Content`

### Local script test

Create `sample-event.json`:

```json
{
  "client_payload": {
    "recordId": "recXXXXXXXXXXXXXX",
    "automationKey": "alberdilab_events"
  }
}
```

Run:

```bash
export AIRTABLE_TOKEN="pat..."
export GITHUB_EVENT_PATH="$PWD/sample-event.json"

node scripts/process-airtable-event.js
```

Optional:

```bash
export AIRTABLE_CONFIG_PATH="$PWD/config/airtable-automations.json"
```

---

## Troubleshooting

`Dispatch failed 404 Not Found`

- Wrong `owner/repo` or token cannot see repo.

`Dispatch failed 403 Resource not accessible by personal access token`

- Token lacks required repo permissions or org approval/SSO authorization.

`INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` from Airtable

- `AIRTABLE_TOKEN` does not include that base/table, or table id/name is wrong.

`Missing required Airtable field: ...`

- Config field mapping does not match actual Airtable column names.

`INVALID_VALUE_FOR_COLUMN` for `updatedAtField`

- Field type is not writable for this update value; use editable date/date-time/text.

Duplicate ICS attachments

- Current script normalizes to single latest attachment after upload. If old duplicates already exist, one successful run should collapse them.

---

## Adding A New Automation

1. Add a new key in [config/airtable-automations.json](config/airtable-automations.json)
2. Create/adjust Airtable automation in that base
3. Use that key as `automationKey` in script input
4. Test with one record
5. Confirm:
   - GitHub Action succeeds
   - `ICS` has one latest file
   - `updatedAtField` is updated

---

## Operational Notes

- Workflow file must exist in the repo default branch for `repository_dispatch` to trigger it.
- Fallback upload path uses GitHub release assets and may require publicly fetchable URLs for Airtable.
- Preferred path is direct Airtable upload and should work with private repos.
