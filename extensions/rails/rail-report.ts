import { writeSync } from "node:fs";

import { RAIL_REPORT_FD, type RailReportLine } from "../../engine/contract.ts";

export type RailReport = (line: RailReportLine) => void;

export function railReportTo(fd: number): RailReport {
  return (line) => {
    try {
      writeSync(fd, JSON.stringify(line) + "\n");
    } catch {}
  };
}

export function createRailReport(): RailReport {
  return process.env.LIUBAI_EVAL ? railReportTo(RAIL_REPORT_FD) : () => {};
}
