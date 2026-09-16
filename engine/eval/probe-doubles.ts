import { RULE, nudgePhrasingHash } from "../contract.ts";
import { CC_DELTA_NUDGE, CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { ProbeReport } from "./canary.ts";
import type { ProbeSpawner } from "./spawner.ts";
import { validateNudgePhrasing } from "./phrasing.ts";

export function healthyProbeReporter(): ProbeSpawner {
  return async (spec) => {
    const nudgePhrasing = spec.env.LIUBAI_NUDGE_PHRASING;
    const validated = nudgePhrasing === undefined ? undefined : validateNudgePhrasing(nudgePhrasing);
    const phrasing = validated !== undefined && "phrasing" in validated ? validated.phrasing : {};

    const nudges: Partial<Record<"python" | "typescript", string[]>> = {};
    for (const fixture of PROBE_FIXTURES) {
      const entry = phrasing.CC_NUDGE?.[fixture.lang] ?? CC_NUDGE[fixture.lang];
      const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang] ?? 8;
      nudges[fixture.lang] = [formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold })];
    }

    const report: ProbeReport = {
      nudgePhrasingHash: nudgePhrasingHash(nudgePhrasing ?? null),
      nudges,
      errors: [],
      ccNudge: {
        python: phrasing.CC_NUDGE?.python ?? CC_NUDGE.python,
        typescript: phrasing.CC_NUDGE?.typescript ?? CC_NUDGE.typescript,
        cpp: phrasing.CC_NUDGE?.cpp ?? CC_NUDGE.cpp,
      },
      ccDeltaNudge: phrasing.CC_DELTA_NUDGE ?? CC_DELTA_NUDGE,
    };

    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
}
