import type { DoctorCheck, DoctorReport } from "./Doctor.js";

/** Counts describe the original checks, before any presentation filtering. */
export interface DoctorCheckCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

/** Compact status for the selected readiness boundary and the wider audit. */
export interface DoctorReportSummary {
  readonly report_view: "summary" | "failures-only";
  readonly healthy: boolean;
  readonly environment_healthy: boolean;
  readonly scope: DoctorReport["scope"];
  readonly check_counts: {
    readonly scope: DoctorCheckCounts;
    readonly informational: DoctorCheckCounts;
  };
}

/** Failed diagnostics retain their original details and remediation. */
export interface DoctorFailureReport extends DoctorReportSummary {
  readonly report_view: "failures-only";
  readonly scope_checks: readonly DoctorCheck[];
  readonly informational_checks: readonly DoctorCheck[];
}

/** Project a completed report; output choices never alter readiness or probing. */
export const projectDoctorReport = (
  report: DoctorReport,
  options: { readonly summary: boolean; readonly failuresOnly: boolean },
): DoctorReport | DoctorReportSummary | DoctorFailureReport => {
  if (!options.summary && !options.failuresOnly) return report;
  const summary: DoctorReportSummary = {
    report_view: options.failuresOnly ? "failures-only" : "summary",
    healthy: report.healthy,
    environment_healthy: report.environment_healthy,
    scope: report.scope,
    check_counts: {
      scope: countChecks(report.scope_checks),
      informational: countChecks(report.informational_checks),
    },
  };
  return options.failuresOnly
    ? {
        ...summary,
        report_view: "failures-only",
        scope_checks: report.scope_checks.filter(({ ok }) => !ok),
        informational_checks: report.informational_checks.filter(
          ({ ok }) => !ok,
        ),
      }
    : summary;
};

const countChecks = (checks: readonly DoctorCheck[]): DoctorCheckCounts => {
  const failed = checks.filter(({ ok }) => !ok).length;
  return { total: checks.length, passed: checks.length - failed, failed };
};
