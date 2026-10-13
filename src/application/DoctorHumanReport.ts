import type { DoctorCheck, DoctorReport } from "./Doctor.js";
import {
  projectDoctorReport,
  type DoctorCheckCounts,
} from "./DoctorReportView.js";

/** Caller-owned readiness classification, separate from the raw doctor report. */
export interface DoctorHumanReportReadiness {
  readonly blockerChecks: readonly DoctorCheck[];
  readonly optionalChecks: readonly DoctorCheck[];
}

/** Presentation flags shared with the compact doctor report projection. */
export interface DoctorHumanReportOptions {
  readonly summary: boolean;
  readonly failuresOnly: boolean;
}

/**
 * Render an inspected doctor report for a terminal or other plain-text sink.
 * Rendering is observational: it neither applies remediation nor emits color
 * control sequences.
 */
export const renderDoctorHumanReport = (
  report: DoctorReport,
  options: DoctorHumanReportOptions,
  readiness?: DoctorHumanReportReadiness,
): string => {
  const compact = projectDoctorReport(report, {
    summary: true,
    failuresOnly: false,
  });
  if (!("report_view" in compact) || compact.report_view !== "summary")
    throw new Error("Expected a compact doctor summary");

  const lines = [
    `REA doctor: ${report.healthy ? "ready" : "not ready"}.`,
    `Environment: ${report.environment_healthy ? "healthy" : "needs attention"}.`,
    `Scope: ${scopeDescription(report)}.`,
    countLine("Scope checks", compact.check_counts.scope),
    countLine("Informational checks", compact.check_counts.informational),
    ...executionLines(report),
  ];

  if (options.summary && !options.failuresOnly) {
    lines.push(
      "Run `rea doctor` without `--summary` or `--failures-only` for detailed checks and exact remediation text.",
    );
    appendReadiness(lines, report, readiness, true);
    return lines.join("\n");
  }

  const scopeChecks = options.failuresOnly
    ? report.scope_checks.filter(isFailedOrIncomplete)
    : report.scope_checks;
  const informationalChecks = options.failuresOnly
    ? report.informational_checks.filter(isFailedOrIncomplete)
    : report.informational_checks;

  if (readiness === undefined) {
    appendChecks(lines, "Scope checks", scopeChecks);
    appendChecks(lines, "Informational checks", informationalChecks);
  } else {
    appendChecks(lines, "Readiness blockers", readiness.blockerChecks);
    appendChecks(
      lines,
      "Optional findings (not readiness blockers)",
      readiness.optionalChecks,
    );
    if (!options.failuresOnly)
      appendChecks(
        lines,
        "Passed checks",
        report.scope_checks.filter(({ ok }) => ok),
      );
  }
  appendRemediation(lines, [...scopeChecks, ...informationalChecks]);
  appendReadiness(lines, report, readiness, false);
  return lines.join("\n");
};

const scopeDescription = ({ scope }: DoctorReport): string =>
  scope.mode === "audit-wide"
    ? "audit-wide"
    : [
        scope.target === null ? undefined : `target ${scope.target}`,
        scope.clients.length === 0
          ? undefined
          : `clients ${scope.clients.join(", ")}`,
        scope.providers.length === 0
          ? undefined
          : `providers ${scope.providers.join(", ")}`,
        scope.skill ? "skill" : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join("; ") || "explicit";

const countLine = (label: string, counts: DoctorCheckCounts): string =>
  `${label}: ${counts.total} total, ${counts.passed} passed, ${counts.failed} failed${counts.incomplete === undefined ? "" : `, ${counts.incomplete} incomplete`}.`;

const executionLines = (report: DoctorReport): readonly string[] => {
  const execution = reportExecution(report);
  if (execution === undefined) return [];
  return [
    execution.complete
      ? "Execution: complete."
      : `Execution: incomplete${execution.stop_reason === null ? "" : ` (${execution.stop_reason})`}.`,
  ];
};

const appendChecks = (
  lines: string[],
  heading: string,
  checks: readonly DoctorCheck[],
): void => {
  lines.push(`${heading}:`);
  if (checks.length === 0) {
    lines.push("- none");
    return;
  }
  for (const check of checks) {
    lines.push(`- ${check.name}: ${checkOutcome(check)}.`);
    if (check.detail !== undefined) lines.push(`  Detail: ${check.detail}`);
    if (check.details !== undefined)
      lines.push(`  Details: ${JSON.stringify(check.details)}`);
  }
};

const checkOutcome = (check: DoctorCheck): string => {
  const executionStatus = doctorCheckExecutionStatus(check);
  if (executionStatus !== undefined && executionStatus !== "completed")
    return executionStatus.replaceAll("_", " ");
  return check.ok ? "passed" : "failed";
};

const appendRemediation = (
  lines: string[],
  checks: readonly DoctorCheck[],
): void => {
  const groups = new Map<string, string[]>();
  for (const check of checks) {
    if (!isFailedOrIncomplete(check) || check.remediation === undefined)
      continue;
    const names = groups.get(check.remediation);
    if (names === undefined) groups.set(check.remediation, [check.name]);
    else names.push(check.name);
  }
  if (groups.size === 0) return;
  lines.push("Remediation:");
  for (const [remediation, names] of groups) {
    // Keep producer-owned remediation text verbatim; only its check association
    // is presentation-owned here.
    lines.push(remediation);
    lines.push(`  Checks: ${names.join(", ")}`);
  }
};

const appendReadiness = (
  lines: string[],
  report: DoctorReport,
  readiness: DoctorHumanReportReadiness | undefined,
  summary: boolean,
): void => {
  if (report.scope.mode === "audit-wide")
    lines.push(
      "Audit-wide raw failures are diagnostics, not automatic readiness blockers; blocker status comes from the readiness classification.",
    );
  if (readiness === undefined) return;
  const blockers = readiness.blockerChecks.filter(isFailedOrIncomplete);
  const optional = readiness.optionalChecks.filter(isFailedOrIncomplete);
  lines.push("Readiness classification:");
  if (summary) {
    lines.push(
      `- ${blockers.length} blocker ${pluralized("check", blockers.length)}; ${optional.length} optional ${pluralized("check", optional.length)}.`,
    );
    return;
  }
  lines.push(`- Blocker checks: ${checkNames(blockers)}.`);
  lines.push(`- Optional checks: ${checkNames(optional)}.`);
};

const checkNames = (checks: readonly DoctorCheck[]): string =>
  checks.length === 0 ? "none" : checks.map(({ name }) => name).join(", ");

const pluralized = (noun: string, count: number): string =>
  count === 1 ? noun : `${noun}s`;

const isFailedOrIncomplete = (check: DoctorCheck): boolean =>
  !check.ok || isIncomplete(check);

const isIncomplete = (check: DoctorCheck): boolean => {
  const status = doctorCheckExecutionStatus(check);
  return status !== undefined && status !== "completed";
};

const doctorCheckExecutionStatus = (check: DoctorCheck) =>
  check.execution_status;
const reportExecution = (report: DoctorReport) => report.execution;
