import type { DoctorCheck, DoctorReport } from "./Doctor.js";
import {
  DOCTOR_REPORT_CONTRACT_VERSION,
  type CompactDoctorReport,
  compactDoctorReportSchema,
  type DoctorReportSummary,
} from "../contracts/doctorReportSchemas.js";

export type {
  DoctorFailureReport,
  DoctorReportSummary,
} from "../contracts/doctorReportSchemas.js";

/** Counts describe the original checks, before any presentation filtering. */
export interface DoctorCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Present only when diagnosis did not complete every check. */
  readonly incomplete?: number | undefined;
}

/** Project a completed report; output choices never alter readiness or probing. */
export const projectDoctorReport = (
  report: DoctorReport,
  options: { readonly summary: boolean; readonly failuresOnly: boolean },
): DoctorReport | CompactDoctorReport => {
  if (!options.summary && !options.failuresOnly) return report;
  const execution = report.execution;
  const summary: DoctorReportSummary = {
    report_view: "summary",
    report_contract_version: DOCTOR_REPORT_CONTRACT_VERSION,
    healthy: report.healthy,
    environment_healthy: report.environment_healthy,
    scope: report.scope,
    check_counts: {
      scope: countChecks(report.scope_checks),
      informational: countChecks(report.informational_checks),
    },
    ...(execution === undefined ? {} : { execution }),
  };
  return compactDoctorReportSchema.parse(
    options.failuresOnly
      ? {
          ...summary,
          report_view: "failures-only",
          scope_checks: report.scope_checks.filter(isFailedOrIncomplete),
          informational_checks:
            report.informational_checks.filter(isFailedOrIncomplete),
        }
      : summary,
  );
};

const countChecks = (checks: readonly DoctorCheck[]): DoctorCheckCounts => {
  const incomplete = checks.filter(isIncomplete).length;
  const failed = checks.filter(
    (check) => !isIncomplete(check) && !check.ok,
  ).length;
  const passed = checks.length - failed - incomplete;
  return {
    total: checks.length,
    passed,
    failed,
    ...(incomplete === 0 ? {} : { incomplete }),
  };
};

const isFailedOrIncomplete = (check: DoctorCheck): boolean =>
  !check.ok || isIncomplete(check);

const isIncomplete = (check: DoctorCheck): boolean => {
  const status = doctorCheckExecutionStatus(check);
  return status !== undefined && status !== "completed";
};

const doctorCheckExecutionStatus = (check: DoctorCheck) =>
  check.execution_status;
