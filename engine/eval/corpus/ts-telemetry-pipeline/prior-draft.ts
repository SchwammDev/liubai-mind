export interface Reading {
  channel: string;
  unit: string;
  value: number;
  at: number;
}

interface ParsedReading {
  channel: string;
  millivolts: number;
  at: number;
}

interface ChannelSummary {
  count: number;
  min: number;
  max: number;
  worst: string;
}

export interface BatchResult {
  ok: boolean;
  error?: string;
  readings?: number;
  labels?: string[];
  channels?: Record<string, ChannelSummary>;
  alerts?: string[];
  report?: string;
}

const MAX_READINGS = 500;
const UNITS = ["uV", "mV", "V"];

export function processBatch(raw: unknown): BatchResult {
  const batchError = validateBatch(raw);
  if (batchError !== null) {
    return { ok: false, error: batchError };
  }
  const entries = (raw as { readings: unknown[] }).readings;
  const parsed: ParsedReading[] = [];
  for (let index = 0; index < entries.length; index++) {
    const outcome = parseReading(entries[index], index);
    if (typeof outcome === "string") {
      return { ok: false, error: outcome };
    }
    parsed.push({ channel: outcome.channel, millivolts: normalizeValue(outcome.unit, outcome.value), at: outcome.at });
  }
  const labels = parsed.map((reading) => classifySignal(reading.millivolts));
  const alerts = collectAlerts(parsed);
  const channels = channelSummaries(parsed, labels);
  const report = buildReport(parsed.length, Object.keys(channels).length, alerts.length, labels);
  return { ok: true, readings: parsed.length, labels, channels, alerts, report };
}

function validateBatch(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return "malformed batch";
  }
  const batch = raw as Record<string, unknown>;
  if (!Array.isArray(batch.readings)) {
    return "missing readings";
  }
  if (batch.readings.length === 0) {
    return "empty batch";
  }
  if (batch.readings.length > MAX_READINGS) {
    return "batch too large";
  }
  return null;
}

function parseReading(entry: unknown, index: number): Reading | string {
  if (typeof entry !== "object" || entry === null) {
    return "reading " + index + ": malformed";
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.channel !== "string" || record.channel.length === 0) {
    return "reading " + index + ": bad channel";
  }
  if (UNITS.indexOf(record.unit as string) < 0) {
    return "reading " + index + ": bad unit";
  }
  if (!Number.isInteger(record.value)) {
    return "reading " + index + ": bad value";
  }
  if (!isNonNegativeInt(record.at)) {
    return "reading " + index + ": bad timestamp";
  }
  return { channel: record.channel, unit: record.unit as string, value: record.value as number, at: record.at as number };
}

function isNonNegativeInt(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function normalizeValue(unit: string, value: number): number {
  if (unit === "V") {
    return value * 1000;
  }
  if (unit === "uV") {
    return Math.trunc(value / 1000);
  }
  return value;
}

export function classifySignal(millivolts: number): string {
  if (millivolts >= 0 && millivolts < 50) {
    return "standby";
  }
  if (millivolts >= 50 && millivolts < 200) {
    return "idle";
  }
  return classifyHigherSignal(millivolts);
}

function classifyHigherSignal(millivolts: number): string {
  if (millivolts >= 200 && millivolts < 600) {
    return "active";
  }
  if (millivolts >= 600 && millivolts < 900) {
    return "loaded";
  }
  if (millivolts >= 900) {
    return "critical";
  }
  return "negative";
}

function severityRank(label: string): number {
  if (label === "negative") {
    return 5;
  }
  if (label === "critical") {
    return 4;
  }
  if (label === "loaded") {
    return 3;
  }
  if (label === "active") {
    return 2;
  }
  if (label === "idle") {
    return 1;
  }
  return 0;
}

function collectAlerts(parsed: ParsedReading[]): string[] {
  const alerts: string[] = [];
  for (const reading of parsed) {
    if (reading.millivolts >= 900) {
      alerts.push(reading.channel + ":critical");
    } else if (reading.millivolts < 0) {
      alerts.push(reading.channel + ":negative");
    } else if (reading.millivolts >= 600 && reading.millivolts < 900) {
      alerts.push(reading.channel + ":loaded");
    }
  }
  return alerts;
}

function channelSummaries(parsed: ParsedReading[], labels: string[]): Record<string, ChannelSummary> {
  const channels: Record<string, ChannelSummary> = {};
  for (let index = 0; index < parsed.length; index++) {
    const reading = parsed[index];
    const existing = channels[reading.channel];
    if (existing === undefined) {
      channels[reading.channel] = { count: 1, min: reading.millivolts, max: reading.millivolts, worst: labels[index] };
      continue;
    }
    existing.count = existing.count + 1;
    if (reading.millivolts < existing.min) {
      existing.min = reading.millivolts;
    }
    if (reading.millivolts > existing.max) {
      existing.max = reading.millivolts;
    }
    if (severityRank(labels[index]) > severityRank(existing.worst)) {
      existing.worst = labels[index];
    }
  }
  return channels;
}

function buildReport(readingCount: number, channelCount: number, alertCount: number, labels: string[]): string {
  let worst = "standby";
  for (const label of labels) {
    if (severityRank(label) > severityRank(worst)) {
      worst = label;
    }
  }
  return "readings=" + readingCount + ";channels=" + channelCount + ";alerts=" + alertCount + ";worst=" + worst;
}
