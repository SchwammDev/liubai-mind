import type { Lang, RailError } from "../contract.ts";
import { RULE, nudgePhrasingHash } from "../contract.ts";
import { CC_DELTA_NUDGE as DEFAULT_CC_DELTA_NUDGE, CC_NUDGE as DEFAULT_CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import type { FixtureLang, ProbeFixture, ProbeReport } from "../delivery-probe.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { TreatmentManifest } from "./eval-contract.ts";
import type { NudgePhrasing } from "./phrasing.ts";
import { validateNudgePhrasing } from "./phrasing.ts";

export type { ProbeReport } from "../delivery-probe.ts";

export interface EvaluateCanaryInput {
  treatment: TreatmentManifest;
  nudgePhrasing: string | undefined;
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
  return isStringOrNull(obj.nudgePhrasingHash)
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

function failure(treatmentId: string, mismatch: string): { ok: false; reason: string } {
  return { ok: false, reason: `treatment ${treatmentId}: ${mismatch}` };
}

function resolvePhrasing(treatment: TreatmentManifest, nudgePhrasing: string | undefined): { value: NudgePhrasing } | { error: string } {
  if (treatment.nudgePhrasingFile === undefined) return { value: {} };
  if (nudgePhrasing === undefined) return { error: "treatment declares a nudgePhrasingFile but no nudge phrasing content was supplied" };

  const validated = validateNudgePhrasing(nudgePhrasing);
  if ("error" in validated) return { error: `invalid nudge phrasing: ${validated.error}` };
  return { value: validated.phrasing };
}

function expectedNudgePhrasingHash(treatment: TreatmentManifest, nudgePhrasing: string | undefined): string | null {
  if (treatment.nudgePhrasingFile === undefined) return null;
  return nudgePhrasingHash(nudgePhrasing ?? null);
}

function ccNudgeEntryFor(lang: FixtureLang, phrasing: NudgePhrasing): { first: string; rest: string } {
  return phrasing.CC_NUDGE?.[lang] ?? DEFAULT_CC_NUDGE[lang];
}

export function ccDeltaTextFor(phrasing: NudgePhrasing): string {
  return phrasing.CC_DELTA_NUDGE ?? DEFAULT_CC_DELTA_NUDGE;
}

function checkCcDeltaConstant(report: ProbeReport, phrasing: NudgePhrasing): string | undefined {
  const expected = ccDeltaTextFor(phrasing);
  if (report.ccDeltaNudge !== expected) {
    return `CC_DELTA_NUDGE mismatch — expected "${expected}", got "${report.ccDeltaNudge}"`;
  }
  return undefined;
}

function checkCcNudgeConstant(report: ProbeReport, phrasing: NudgePhrasing): string | undefined {
  for (const fixture of PROBE_FIXTURES) {
    const expected = ccNudgeEntryFor(fixture.lang, phrasing);
    const actual = report.ccNudge[fixture.lang];
    if (actual === undefined || actual.first !== expected.first || actual.rest !== expected.rest) {
      return `CC_NUDGE.${fixture.lang} mismatch — resolved constant does not match the expected phrasing`;
    }
  }
  return undefined;
}

function expectedCcNudgeText(fixture: ProbeFixture, phrasing: NudgePhrasing): string {
  const entry = ccNudgeEntryFor(fixture.lang, phrasing);
  const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang];
  if (threshold === undefined) throw new Error(`cc rule carries no threshold for ${fixture.lang}`);
  return formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold });
}

function checkCcNudgeFiring(report: ProbeReport, phrasing: NudgePhrasing): string | undefined {
  for (const fixture of PROBE_FIXTURES) {
    const expectedText = expectedCcNudgeText(fixture, phrasing);
    const produced = report.nudges[fixture.lang] ?? [];
    if (!produced.some((msg) => msg.includes(expectedText))) {
      return `expected CC_NUDGE phrasing for ${fixture.lang} was not delivered — looked for "${expectedText}" in ${JSON.stringify(produced)}`;
    }
  }
  return undefined;
}

type ParsedStage = { report: ProbeReport; phrasing: NudgePhrasing } | { error: string };

function parseAndResolve(input: EvaluateCanaryInput): ParsedStage {
  if (input.exitCode !== 0) {
    return { error: `probe exited ${input.exitCode}: ${input.stderr.trim() || "(no stderr)"}` };
  }

  const parsed = parseProbeStdout(input.stdout);
  if ("error" in parsed) return parsed;

  if (parsed.errors.length > 0) {
    return { error: `probe reported analyze errors: ${parsed.errors.map((e) => `${e.source}: ${e.msg}`).join("; ")}` };
  }

  const phrasing = resolvePhrasing(input.treatment, input.nudgePhrasing);
  if ("error" in phrasing) return phrasing;

  return { report: parsed, phrasing: phrasing.value };
}

interface DeliveryCtx {
  treatment: TreatmentManifest;
  nudgePhrasing: string | undefined;
  report: ProbeReport;
  phrasing: NudgePhrasing;
}

function checkNudgePhrasingHash(ctx: DeliveryCtx): string | undefined {
  const expected = expectedNudgePhrasingHash(ctx.treatment, ctx.nudgePhrasing);
  if (ctx.report.nudgePhrasingHash === expected) return undefined;
  return `nudgePhrasingHash mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(ctx.report.nudgePhrasingHash)}`;
}

function checkCcDelta(ctx: DeliveryCtx): string | undefined {
  return checkCcDeltaConstant(ctx.report, ctx.phrasing);
}

function checkCcNudge(ctx: DeliveryCtx): string | undefined {
  const railsOff = Boolean(ctx.treatment.env.LIUBAI_RAILS_OFF);
  return railsOff ? checkCcNudgeConstant(ctx.report, ctx.phrasing) : checkCcNudgeFiring(ctx.report, ctx.phrasing);
}

const DELIVERY_CHECKS: ((ctx: DeliveryCtx) => string | undefined)[] = [checkNudgePhrasingHash, checkCcDelta, checkCcNudge];

function checkDelivery(ctx: DeliveryCtx): string | undefined {
  for (const check of DELIVERY_CHECKS) {
    const mismatch = check(ctx);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

export function evaluateCanary(input: EvaluateCanaryInput): CanaryResult {
  const stage = parseAndResolve(input);
  if ("error" in stage) return failure(input.treatment.id, stage.error);

  const mismatch = checkDelivery({ treatment: input.treatment, nudgePhrasing: input.nudgePhrasing, report: stage.report, phrasing: stage.phrasing });
  if (mismatch !== undefined) return failure(input.treatment.id, mismatch);

  return { ok: true, report: stage.report };
}
