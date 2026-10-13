import {
  mcpDoctorCompactReportEnvelopeSchema,
  mcpDoctorCompactReportSchema,
  type McpDoctorCheck,
  type McpDoctorCheckCounts,
  type McpDoctorCompactReport,
  type McpDoctorCompactReportEnvelope,
  type McpDoctorIncomplete,
} from "./contracts/mcpDoctorReportSchemas.js";

/** Completed production-adapter facts needed by the presentation boundary. */
export interface McpDoctorReportSource {
  readonly healthy: boolean;
  readonly adapter: "production-stdio";
  readonly checks: readonly McpDoctorCheck[];
  readonly incomplete?: McpDoctorIncomplete;
}

/** Caller-selected compact machine report options. */
export interface McpDoctorReportViewOptions {
  readonly summary: boolean;
  readonly failuresOnly: boolean;
}

/** Project an already-completed doctor report without changing diagnosis work. */
export const projectMcpDoctorReport = (
  report: McpDoctorReportSource,
  options: McpDoctorReportViewOptions,
): McpDoctorCompactReport => {
  const failed = report.checks.filter(({ ok }) => !ok);
  const incompleteCount = report.checks.filter(
    ({ execution_status }) =>
      execution_status !== undefined && execution_status !== "completed",
  ).length;
  const check_counts: McpDoctorCheckCounts = {
    total: report.checks.length,
    passed: report.checks.length - failed.length,
    failed: failed.length - incompleteCount,
    ...(incompleteCount === 0 ? {} : { incomplete: incompleteCount }),
  };
  const common = {
    report_contract_version: 1 as const,
    healthy: report.healthy,
    adapter: report.adapter,
    check_counts,
    ...(report.incomplete === undefined
      ? {}
      : { incomplete: report.incomplete }),
  };
  const projected = options.failuresOnly
    ? { ...common, report_view: "failures-only" as const, checks: failed }
    : { ...common, report_view: "summary" as const };
  return mcpDoctorCompactReportSchema.parse(projected);
};

/** Wrap a compact view only when the caller explicitly requested full output. */
export const envelopeMcpDoctorCompactReport = (
  report: McpDoctorCompactReport,
): McpDoctorCompactReportEnvelope =>
  mcpDoctorCompactReportEnvelopeSchema.parse(
    report.healthy ? { ok: true, data: report } : { ok: false, error: report },
  );

/** Render the fresh-process diagnostic in prose without implying session access. */
export const renderMcpDoctorHuman = (
  report: McpDoctorReportSource,
  projected: McpDoctorCompactReport | undefined,
): string => {
  const view = projected?.report_view;
  const lines = [
    "REA MCP doctor",
    "This diagnostic starts a fresh REA stdio server; it does not inspect, attach to, or reuse an active client session.",
    `Status: ${report.healthy ? "healthy" : "unhealthy"}`,
    `Adapter: ${report.adapter}`,
  ];
  const incomplete = projected?.incomplete ?? report.incomplete;
  if (incomplete !== undefined) {
    lines.push(
      `Incomplete: ${incomplete.reason}; not examined: ${incomplete.not_examined.join(", ")}`,
    );
  }
  if (projected !== undefined) {
    const { total, passed, failed } = projected.check_counts;
    lines.push(
      `Checks: ${String(total)} total; ${String(passed)} passed; ${String(failed)} failed`,
    );
    if (projected.check_counts.incomplete !== undefined)
      lines.push(`Incomplete checks: ${projected.check_counts.incomplete}`);
    if (view === "summary")
      lines.push(
        "Run `rea mcp doctor` without --summary or --failures-only for full diagnostics.",
      );
    if (view === "failures-only") appendChecks(lines, projected.checks);
  } else {
    const counts = projectMcpDoctorReport(report, {
      summary: true,
      failuresOnly: false,
    }).check_counts;
    lines.push(
      `Checks: ${counts.total} total; ${counts.passed} passed; ${counts.failed} failed`,
    );
    if (counts.incomplete !== undefined)
      lines.push(`Incomplete checks: ${counts.incomplete}`);
    appendChecks(lines, report.checks);
  }
  return lines.join("\n");
};

const appendChecks = (
  lines: string[],
  checks: readonly McpDoctorCheck[],
): void => {
  if (checks.length === 0) return;
  lines.push("Diagnostics:");
  for (const check of checks)
    lines.push(
      `- ${check.execution_status !== undefined && check.execution_status !== "completed" ? check.execution_status.toUpperCase() : check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
    );
};
