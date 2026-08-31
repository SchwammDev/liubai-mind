import { RULE, packHash } from "../contract.ts";
import { CC_DELTA_NUDGE, CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { ProbeReport } from "./canary.ts";
import type { ProbeSpawner } from "./spawner.ts";
import { validatePack } from "./phrasing.ts";

export function healthyProbeReporter(): ProbeSpawner {
  return async (spec) => {
    const packContent = spec.env.LIUBAI_PHRASING_PACK;
    const validated = packContent === undefined ? undefined : validatePack(packContent);
    const pack = validated !== undefined && "pack" in validated ? validated.pack : {};

    const nudges: Partial<Record<"python" | "typescript", string[]>> = {};
    for (const fixture of PROBE_FIXTURES) {
      const entry = pack.CC_NUDGE?.[fixture.lang] ?? CC_NUDGE[fixture.lang];
      const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang] ?? 8;
      nudges[fixture.lang] = [formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold })];
    }

    const report: ProbeReport = {
      packHash: packHash(packContent ?? null),
      nudges,
      errors: [],
      ccNudge: {
        python: pack.CC_NUDGE?.python ?? CC_NUDGE.python,
        typescript: pack.CC_NUDGE?.typescript ?? CC_NUDGE.typescript,
        cpp: pack.CC_NUDGE?.cpp ?? CC_NUDGE.cpp,
      },
      ccDeltaNudge: pack.CC_DELTA_NUDGE ?? CC_DELTA_NUDGE,
    };

    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
}
