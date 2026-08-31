import type { Lang, RailError } from "../contract.ts";
import { RULE, packHash } from "../contract.ts";
import { CC_DELTA_NUDGE as DEFAULT_CC_DELTA_NUDGE, CC_NUDGE as DEFAULT_CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import type { FixtureLang, ProbeFixture, ProbeReport } from "../delivery-probe.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { ConditionManifest } from "./eval-contract.ts";
import type { ValidPack } from "./phrasing.ts";
import { validatePack } from "./phrasing.ts";

export type { ProbeReport } from "../delivery-probe.ts";

export interface EvaluateCanaryInput {
  condition: ConditionManifest;
  packContent: string | undefined;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CanaryResult = { ok: true; report: ProbeReport } | { ok: false; reason: string };

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRailErrorArray(value: unknown): value is RailError[] {
  return Array.isArray(value) && value.every(
    (e) => typeof e === "object" && e !== null && typeof (e as Record<string, unknown>).source === "string" && typeof (e as Record<string, unknown>).msg === "string",
  );
}

function isNudgeMap(value: unknown): value is Partial<Record<FixtureLang, string[]>> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
}

function isCcNudgeEntry(value: unknown): value is { first: string; rest: string } {
  if (typeof value !== "object" || value === null) return false;
  const { first, rest } = value as Record<string, unknown>;
  return typeof first === "string" && typeof rest === "string";
}

function isCcNudgeMap(value: unknown): value is Record<Lang, { first: string; rest: string }> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every(isCcNudgeEntry);
}

function isProbeReport(value: unknown): value is ProbeReport {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return isStringOrNull(obj.packHash)
    && isNudgeMap(obj.nudges)
    && isRailErrorArray(obj.errors)
    && isCcNudgeMap(obj.ccNudge)
    && typeof obj.ccDeltaNudge === "string";
}

export function parseProbeStdout(stdout: string): ProbeReport | { error: string } {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return { error: "probe printed no output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (err) {
    return { error: `probe stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!isProbeReport(parsed)) return { error: "probe output is missing expected fields" };
  return parsed;
}

function failure(conditionId: string, mismatch: string): { ok: false; reason: string } {
  return { ok: false, reason: `condition ${conditionId}: ${mismatch}` };
}

function resolvePack(condition: ConditionManifest, packContent: string | undefined): { value: ValidPack } | { error: string } {
  if (condition.phrasingPack === undefined) return { value: {} };
  if (packContent === undefined) return { error: "condition declares a phrasingPack but no pack content was supplied" };

  const validated = validatePack(packContent);
  if ("error" in validated) return { error: `invalid phrasing pack: ${validated.error}` };
  return { value: validated.pack };
}

function expectedPackHash(condition: ConditionManifest, packContent: string | undefined): string | null {
  if (condition.phrasingPack === undefined) return null;
  return packHash(packContent ?? null);
}

function ccNudgeEntryFor(lang: FixtureLang, pack: ValidPack): { first: string; rest: string } {
  return pack.CC_NUDGE?.[lang] ?? DEFAULT_CC_NUDGE[lang];
}

export function ccDeltaTextFor(pack: ValidPack): string {
  return pack.CC_DELTA_NUDGE ?? DEFAULT_CC_DELTA_NUDGE;
}

function checkCcDeltaConstant(report: ProbeReport, pack: ValidPack): string | undefined {
  const expected = ccDeltaTextFor(pack);
  if (report.ccDeltaNudge !== expected) {
    return `CC_DELTA_NUDGE mismatch — expected "${expected}", got "${report.ccDeltaNudge}"`;
  }
  return undefined;
}

function checkCcNudgeConstant(report: ProbeReport, pack: ValidPack): string | undefined {
  for (const fixture of PROBE_FIXTURES) {
    const expected = ccNudgeEntryFor(fixture.lang, pack);
    const actual = report.ccNudge[fixture.lang];
    if (actual === undefined || actual.first !== expected.first || actual.rest !== expected.rest) {
      return `CC_NUDGE.${fixture.lang} mismatch — resolved constant does not match the expected phrasing`;
    }
  }
  return undefined;
}

function expectedCcNudgeText(fixture: ProbeFixture, pack: ValidPack): string {
  const entry = ccNudgeEntryFor(fixture.lang, pack);
  const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang];
  if (threshold === undefined) throw new Error(`cc rule carries no threshold for ${fixture.lang}`);
  return formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold });
}

function checkCcNudgeFiring(report: ProbeReport, pack: ValidPack): string | undefined {
  for (const fixture of PROBE_FIXTURES) {
    const expectedText = expectedCcNudgeText(fixture, pack);
    const produced = report.nudges[fixture.lang] ?? [];
    if (!produced.some((msg) => msg.includes(expectedText))) {
      return `expected CC_NUDGE phrasing for ${fixture.lang} was not delivered — looked for "${expectedText}" in ${JSON.stringify(produced)}`;
    }
  }
  return undefined;
}

type ParsedStage = { report: ProbeReport; pack: ValidPack } | { error: string };

function parseAndResolve(input: EvaluateCanaryInput): ParsedStage {
  if (input.exitCode !== 0) {
    return { error: `probe exited ${input.exitCode}: ${input.stderr.trim() || "(no stderr)"}` };
  }

  const parsed = parseProbeStdout(input.stdout);
  if ("error" in parsed) return parsed;

  if (parsed.errors.length > 0) {
    return { error: `probe reported analyze errors: ${parsed.errors.map((e) => `${e.source}: ${e.msg}`).join("; ")}` };
  }

  const pack = resolvePack(input.condition, input.packContent);
  if ("error" in pack) return pack;

  return { report: parsed, pack: pack.value };
}

interface DeliveryCtx {
  condition: ConditionManifest;
  packContent: string | undefined;
  report: ProbeReport;
  pack: ValidPack;
}

function checkPackHash(ctx: DeliveryCtx): string | undefined {
  const expected = expectedPackHash(ctx.condition, ctx.packContent);
  if (ctx.report.packHash === expected) return undefined;
  return `packHash mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(ctx.report.packHash)}`;
}

function checkCcDelta(ctx: DeliveryCtx): string | undefined {
  return checkCcDeltaConstant(ctx.report, ctx.pack);
}

function checkCcNudge(ctx: DeliveryCtx): string | undefined {
  const railsOff = Boolean(ctx.condition.env.LIUBAI_RAILS_OFF);
  return railsOff ? checkCcNudgeConstant(ctx.report, ctx.pack) : checkCcNudgeFiring(ctx.report, ctx.pack);
}

const DELIVERY_CHECKS: ((ctx: DeliveryCtx) => string | undefined)[] = [checkPackHash, checkCcDelta, checkCcNudge];

function checkDelivery(ctx: DeliveryCtx): string | undefined {
  for (const check of DELIVERY_CHECKS) {
    const mismatch = check(ctx);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

export function evaluateCanary(input: EvaluateCanaryInput): CanaryResult {
  const stage = parseAndResolve(input);
  if ("error" in stage) return failure(input.condition.id, stage.error);

  const mismatch = checkDelivery({ condition: input.condition, packContent: input.packContent, report: stage.report, pack: stage.pack });
  if (mismatch !== undefined) return failure(input.condition.id, mismatch);

  return { ok: true, report: stage.report };
}
