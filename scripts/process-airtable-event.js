#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FIELD_EVENT_NAME = "Event Name";
const FIELD_START = "Start";
const FIELD_END = "End";
const FIELD_LOCATION = "Location";
const FIELD_DESCRIPTION = "Description";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read JSON file at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function readDispatchPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH || process.argv[2];
  if (!eventPath) {
    throw new Error(
      "No event payload path found. Set GITHUB_EVENT_PATH or pass a JSON file path as argv[2]."
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(eventPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read event JSON at ${eventPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${eventPath}: ${error.message}`);
  }

  const payload =
    parsed && typeof parsed.client_payload === "object" && parsed.client_payload
      ? parsed.client_payload
      : parsed;

  return { eventPath, payload };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== "object") {
    return "";
  }
  for (const key of keys) {
    const value = nonEmptyString(obj[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function parseAutomationConfigFile() {
  const configPath = optionalEnv("AIRTABLE_CONFIG_PATH") || "config/airtable-automations.json";
  const absolutePath = path.resolve(configPath);
  const parsed = readJsonFile(absolutePath);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Config file ${absolutePath} must be a JSON object keyed by automation key.`
    );
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    throw new Error(`Config file ${absolutePath} is empty.`);
  }

  return { configPath: absolutePath, configMap: parsed };
}

function resolveAirtableConfig(payload) {
  const recordId = nonEmptyString(payload && payload.recordId);
  if (!recordId) {
    throw new Error("Dispatch payload is missing required client_payload.recordId");
  }

  const airtableToken = requireEnv("AIRTABLE_TOKEN");
  const tableFromPayload = nonEmptyString(payload && payload.tableName);
  const { configPath, configMap } = parseAutomationConfigFile();
  const availableKeys = Object.keys(configMap);
  const payloadAutomationKey = nonEmptyString(payload && payload.automationKey);
  const automationKey = payloadAutomationKey || (availableKeys.length === 1 ? availableKeys[0] : "");

  if (!automationKey) {
    throw new Error(
      `Multiple automation configs found in ${configPath} (${availableKeys.join(
        ", "
      )}). Include client_payload.automationKey.`
    );
  }

  const selected = configMap[automationKey];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new Error(`automationKey "${automationKey}" was not found in ${configPath}.`);
  }

  const baseId = pickString(selected, ["baseId", "airtableBaseId"]);
  const tableIdOrName = tableFromPayload || pickString(selected, ["tableId", "tableName", "table"]);
  const attachmentField = pickString(selected, ["icsField", "attachmentField", "airtableIcsField"]);
  const updatedAtField = pickString(selected, ["updatedAtField", "airtableUpdatedAtField"]);
  const releaseTag = pickString(selected, ["releaseTag"]) || "airtable-ics-assets";
  const eventNameField =
    pickString(selected, ["eventNameField", "summaryField", "titleField"]) || FIELD_EVENT_NAME;
  const startField = pickString(selected, ["startField"]) || FIELD_START;
  const endField = pickString(selected, ["endField"]) || FIELD_END;
  const locationField = pickString(selected, ["locationField"]) || FIELD_LOCATION;
  const descriptionField = pickString(selected, ["descriptionField"]) || FIELD_DESCRIPTION;

  if (!baseId) {
    throw new Error(`Missing baseId for automationKey "${automationKey}" in ${configPath}.`);
  }
  if (!tableIdOrName) {
    throw new Error(
      `Missing table for automationKey "${automationKey}" in ${configPath}. Add tableId/tableName or pass client_payload.tableName.`
    );
  }
  if (!attachmentField) {
    throw new Error(`Missing icsField for automationKey "${automationKey}" in ${configPath}.`);
  }
  if (!updatedAtField) {
    throw new Error(
      `Missing updatedAtField for automationKey "${automationKey}" in ${configPath}.`
    );
  }

  return {
    recordId,
    automationKey,
    configPath,
    airtableToken,
    baseId,
    tableIdOrName,
    attachmentField,
    updatedAtField,
    releaseTag,
    eventNameField,
    startField,
    endField,
    locationField,
    descriptionField,
  };
}

function toUtcIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseDate(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required Airtable field: ${fieldName}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date in Airtable field "${fieldName}": ${value}`);
  }
  return date;
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).join(", ");
  }
  return JSON.stringify(value);
}

function escapeIcsText(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcsLine(line, maxLen = 75) {
  if (line.length <= maxLen) {
    return line;
  }
  let remaining = line;
  const chunks = [];
  while (remaining.length > maxLen) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  chunks.push(remaining);
  return chunks.join("\r\n ");
}

function buildIcs({ recordId, eventName, startDate, endDate, location, description }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//airtable_wf//Airtable Dispatch//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:airtable-${recordId}@airtable-wf`,
    `DTSTAMP:${toUtcIcsDate(new Date())}`,
    `DTSTART:${toUtcIcsDate(startDate)}`,
    `DTEND:${toUtcIcsDate(endDate)}`,
    foldIcsLine(`SUMMARY:${escapeIcsText(eventName)}`),
  ];

  if (location) {
    lines.push(foldIcsLine(`LOCATION:${escapeIcsText(location)}`));
  }
  if (description) {
    lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(description)}`));
  }

  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

async function fetchJson(url, { method = "GET", token, body, headers = {} } = {}) {
  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...headers,
  };

  if (body !== undefined && !(body instanceof Buffer)) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body:
      body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const detail = parsed ? (typeof parsed === "string" ? parsed : JSON.stringify(parsed)) : "";
    throw new Error(`${method} ${url} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  return parsed;
}

async function fetchGithub(url, { method = "GET", token, body, headers = {} } = {}) {
  const requestHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...headers,
  };

  if (body !== undefined && !(body instanceof Buffer) && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body:
      body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return { ok: response.ok, status: response.status, data: parsed };
}

function airtableRecordUrl(baseId, tableIdOrName, recordId) {
  return `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(
    tableIdOrName
  )}/${encodeURIComponent(recordId)}`;
}

async function fetchAirtableRecord({ airtableToken, baseId, tableIdOrName, recordId }) {
  return fetchJson(airtableRecordUrl(baseId, tableIdOrName, recordId), {
    token: airtableToken,
  });
}

async function updateAirtableRecord({ airtableToken, baseId, tableIdOrName, recordId, fields }) {
  return fetchJson(airtableRecordUrl(baseId, tableIdOrName, recordId), {
    method: "PATCH",
    token: airtableToken,
    body: { fields },
  });
}

function isInvalidValueForColumnError(error) {
  const message = error && error.message ? String(error.message) : "";
  return message.includes("INVALID_VALUE_FOR_COLUMN");
}

async function updateAirtableTimestampField({
  airtableToken,
  baseId,
  tableIdOrName,
  recordId,
  updatedAtField,
}) {
  const now = new Date();
  const candidateValues = [now.toISOString(), now.toISOString().slice(0, 10)];
  let lastInvalidValueError = null;

  for (const candidateValue of candidateValues) {
    try {
      await updateAirtableRecord({
        airtableToken,
        baseId,
        tableIdOrName,
        recordId,
        fields: {
          [updatedAtField]: candidateValue,
        },
      });
      return candidateValue;
    } catch (error) {
      if (isInvalidValueForColumnError(error)) {
        lastInvalidValueError = error;
        continue;
      }
      throw error;
    }
  }

  const detail =
    lastInvalidValueError && lastInvalidValueError.message
      ? ` Original error: ${lastInvalidValueError.message}`
      : "";
  throw new Error(
    `Field "${updatedAtField}" rejected both datetime and date values. ` +
      `Use an editable date/date-time or text field for updatedAtField.` +
      detail
  );
}

async function uploadAttachmentToAirtable({
  airtableToken,
  baseId,
  recordId,
  attachmentField,
  filename,
  icsBuffer,
}) {
  const uploadUrl = `https://content.airtable.com/v0/${encodeURIComponent(
    baseId
  )}/${encodeURIComponent(recordId)}/${encodeURIComponent(attachmentField)}/uploadAttachment`;

  return fetchJson(uploadUrl, {
    method: "POST",
    token: airtableToken,
    body: {
      contentType: "text/calendar",
      filename,
      file: icsBuffer.toString("base64"),
    },
  });
}

function normalizeAttachmentForPatch(attachment, fallbackFilename) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const attachmentId = nonEmptyString(attachment.id);
  if (attachmentId) {
    return { id: attachmentId };
  }

  const attachmentUrl = nonEmptyString(attachment.url);
  if (!attachmentUrl) {
    return null;
  }

  const normalized = { url: attachmentUrl };
  const filename = nonEmptyString(attachment.filename) || fallbackFilename;
  if (filename) {
    normalized.filename = filename;
  }
  return normalized;
}

function extractLatestAttachmentFromUploadResponse(response, attachmentField, fallbackFilename) {
  const candidates = [];

  if (response && typeof response === "object") {
    if (
      response.fields &&
      typeof response.fields === "object" &&
      Array.isArray(response.fields[attachmentField])
    ) {
      candidates.push(...response.fields[attachmentField]);
    }

    if (Array.isArray(response[attachmentField])) {
      candidates.push(...response[attachmentField]);
    }

    if (Array.isArray(response.attachments)) {
      candidates.push(...response.attachments);
    }

    if (response.attachment && typeof response.attachment === "object") {
      candidates.push(response.attachment);
    }

    if (Array.isArray(response)) {
      candidates.push(...response);
    }

    candidates.push(response);
  }

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const normalized = normalizeAttachmentForPatch(candidates[i], fallbackFilename);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

async function getOrCreateGithubRelease({ token, repo, apiUrl, tag }) {
  const byTag = await fetchGithub(
    `${apiUrl}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { token }
  );

  if (byTag.ok) {
    return byTag.data;
  }
  if (byTag.status !== 404) {
    throw new Error(
      `Failed to fetch release by tag (${byTag.status}): ${JSON.stringify(byTag.data)}`
    );
  }

  const created = await fetchGithub(`${apiUrl}/repos/${repo}/releases`, {
    method: "POST",
    token,
    body: {
      tag_name: tag,
      name: "Airtable ICS Attachments",
      body: "Auto-generated release for Airtable ICS fallback uploads.",
      draft: false,
      prerelease: false,
    },
  });

  if (!created.ok) {
    throw new Error(`Failed to create release (${created.status}): ${JSON.stringify(created.data)}`);
  }

  return created.data;
}

async function uploadIcsToGithubRelease({ token, repo, apiUrl, tag, filename, icsBuffer }) {
  const release = await getOrCreateGithubRelease({ token, repo, apiUrl, tag });

  const existingAsset = Array.isArray(release.assets)
    ? release.assets.find((asset) => asset && asset.name === filename)
    : null;

  if (existingAsset) {
    const deleted = await fetchGithub(
      `${apiUrl}/repos/${repo}/releases/assets/${existingAsset.id}`,
      { method: "DELETE", token }
    );
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(
        `Failed to delete existing release asset (${deleted.status}): ${JSON.stringify(
          deleted.data
        )}`
      );
    }
  }

  const uploadBase = String(release.upload_url || "").split("{")[0];
  if (!uploadBase) {
    throw new Error("GitHub release upload_url is missing.");
  }
  const uploadUrl = `${uploadBase}?name=${encodeURIComponent(filename)}`;

  const uploaded = await fetchGithub(uploadUrl, {
    method: "POST",
    token,
    headers: {
      "Content-Type": "text/calendar",
    },
    body: icsBuffer,
  });

  if (!uploaded.ok) {
    throw new Error(`Failed to upload release asset (${uploaded.status}): ${JSON.stringify(uploaded.data)}`);
  }

  const downloadUrl =
    uploaded.data && typeof uploaded.data.browser_download_url === "string"
      ? uploaded.data.browser_download_url
      : null;

  if (!downloadUrl) {
    throw new Error("Upload succeeded but browser_download_url is missing.");
  }

  return downloadUrl;
}

async function attachIcsWithFallback({
  airtableToken,
  baseId,
  tableIdOrName,
  recordId,
  attachmentField,
  releaseTag,
  filename,
  icsBuffer,
}) {
  try {
    const uploadResponse = await uploadAttachmentToAirtable({
      airtableToken,
      baseId,
      recordId,
      attachmentField,
      filename,
      icsBuffer,
    });

    let latestAttachment = extractLatestAttachmentFromUploadResponse(
      uploadResponse,
      attachmentField,
      filename
    );

    if (!latestAttachment) {
      const refreshed = await fetchAirtableRecord({
        airtableToken,
        baseId,
        tableIdOrName,
        recordId,
      });
      const existingAttachments =
        refreshed &&
        refreshed.fields &&
        Array.isArray(refreshed.fields[attachmentField])
          ? refreshed.fields[attachmentField]
          : [];

      if (existingAttachments.length > 0) {
        latestAttachment = normalizeAttachmentForPatch(
          existingAttachments[existingAttachments.length - 1],
          filename
        );
      }
    }

    if (!latestAttachment) {
      throw new Error(
        `Direct Airtable upload succeeded but could not resolve attachment for field "${attachmentField}".`
      );
    }

    await updateAirtableRecord({
      airtableToken,
      baseId,
      tableIdOrName,
      recordId,
      fields: {
        [attachmentField]: [latestAttachment],
      },
    });

    return { method: "airtable_upload_attachment" };
  } catch (error) {
    console.warn(`Direct Airtable upload failed, trying URL fallback. Reason: ${error.message}`);
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPOSITORY;
  const githubApiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  if (!githubToken || !githubRepo) {
    throw new Error(
      "Fallback upload requires GITHUB_TOKEN and GITHUB_REPOSITORY. Direct Airtable upload also failed."
    );
  }

  const assetUrl = await uploadIcsToGithubRelease({
    token: githubToken,
    repo: githubRepo,
    apiUrl: githubApiUrl,
    tag: releaseTag,
    filename,
    icsBuffer,
  });

  await updateAirtableRecord({
    airtableToken,
    baseId,
    tableIdOrName,
    recordId,
    fields: {
      [attachmentField]: [{ url: assetUrl, filename }],
    },
  });

  return { method: "github_release_url", assetUrl };
}

async function main() {
  const { eventPath, payload } = readDispatchPayload();
  const config = resolveAirtableConfig(payload);
  const {
    recordId,
    automationKey,
    configPath,
    airtableToken,
    baseId,
    tableIdOrName,
    attachmentField,
    updatedAtField,
    releaseTag,
    eventNameField,
    startField,
    endField,
    locationField,
    descriptionField,
  } = config;

  console.log(`Event payload file: ${eventPath}`);
  console.log(`Config file: ${configPath}`);
  console.log(`Processing Airtable record: ${recordId}`);
  if (automationKey) {
    console.log(`Automation key: ${automationKey}`);
  }
  console.log(`Using table: ${tableIdOrName}`);

  const record = await fetchAirtableRecord({ airtableToken, baseId, tableIdOrName, recordId });
  const fields = record && typeof record.fields === "object" && record.fields ? record.fields : {};

  const eventName = normalizeText(fields[eventNameField]).trim();
  if (!eventName) {
    const availableFields = Object.keys(fields).sort().join(", ");
    throw new Error(
      `Missing required Airtable field: ${eventNameField}. Available fields: ${availableFields}`
    );
  }

  const startDate = parseDate(fields[startField], startField);
  const endDate = parseDate(fields[endField], endField);
  if (endDate <= startDate) {
    throw new Error(`Invalid event range: "${endField}" must be after "${startField}"`);
  }

  const location = normalizeText(fields[locationField]).trim();
  const description = normalizeText(fields[descriptionField]).trim();

  const icsText = buildIcs({
    recordId,
    eventName,
    startDate,
    endDate,
    location,
    description,
  });

  const filename = `${recordId}.ics`;
  const tmpPath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(tmpPath, icsText, "utf8");
  const icsBuffer = Buffer.from(icsText, "utf8");

  const attachmentResult = await attachIcsWithFallback({
    airtableToken,
    baseId,
    tableIdOrName,
    recordId,
    attachmentField,
    releaseTag,
    filename,
    icsBuffer,
  });

  const updatedAt = await updateAirtableTimestampField({
    airtableToken,
    baseId,
    tableIdOrName,
    recordId,
    updatedAtField,
  });

  console.log(`ICS written to: ${tmpPath}`);
  console.log(`Attachment method: ${attachmentResult.method}`);
  if (attachmentResult.assetUrl) {
    console.log(`Fallback asset URL: ${attachmentResult.assetUrl}`);
  }
  console.log(`Updated field "${updatedAtField}" -> ${updatedAt}`);
}

main().catch((error) => {
  console.error("Failed to process Airtable event.");
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
