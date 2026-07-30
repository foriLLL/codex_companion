import { EmbyError } from "./emby-client.mjs";

const DEFAULT_EVENT_FORMAT = [
  "layer",
  "start",
  "end",
  "style",
  "name",
  "marginl",
  "marginr",
  "marginv",
  "effect",
  "text"
];

function splitFields(value, count) {
  const fields = [];
  let rest = value;
  for (let index = 1; index < count; index += 1) {
    const comma = rest.indexOf(",");
    if (comma < 0) return null;
    fields.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  fields.push(rest);
  return fields;
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.](\d{1,3}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const fraction = match[4] ?? "0";
  const milliseconds = Number(fraction.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function formatTimestamp(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const remainder = total % 1000;
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":") + `.${String(remainder).padStart(3, "0")}`;
}

function stripAssOverrides(value) {
  let output = "";
  let cursor = 0;
  let drawing = false;
  for (const match of value.matchAll(/\{([^}]*)\}/g)) {
    if (!drawing) output += value.slice(cursor, match.index);
    for (const drawingTag of match[1].matchAll(/\\p(\d+)/gi)) {
      drawing = Number(drawingTag[1]) > 0;
    }
    cursor = match.index + match[0].length;
  }
  if (!drawing) output += value.slice(cursor);
  return output;
}

function cueText(value) {
  const plain = stripAssOverrides(String(value))
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/gi, "\u00a0")
    .replace(/\\([{}])/g, "$1")
    .trim();
  return plain
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function assToWebVtt(input) {
  const lines = String(input).replace(/^\uFEFF/, "").split(/\r?\n/);
  let inEvents = false;
  let format = DEFAULT_EVENT_FORMAT;
  const cues = [];

  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      inEvents = section[1].trim().toLowerCase() === "events";
      continue;
    }
    if (!inEvents) continue;

    const formatMatch = line.match(/^\s*Format\s*:\s*(.+)$/i);
    if (formatMatch) {
      const candidate = formatMatch[1].split(",").map((field) => field.trim().toLowerCase());
      if (candidate.includes("start") && candidate.includes("end") && candidate.includes("text")) {
        format = candidate;
      }
      continue;
    }

    const dialogue = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
    if (!dialogue) continue;
    const fields = splitFields(dialogue[1], format.length);
    if (!fields) continue;
    const event = Object.fromEntries(format.map((field, index) => [field, fields[index] ?? ""]));
    const start = parseTimestamp(event.start);
    const end = parseTimestamp(event.end);
    const text = cueText(event.text);
    if (start === null || end === null || end <= start || !text) continue;
    cues.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}`);
  }

  if (cues.length === 0) {
    throw new EmbyError("INVALID_SUBTITLE_RESPONSE", "ASS/SSA 字幕中没有可显示的文字事件");
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
