import { describe, expect, it } from "vitest";

import type { DoctorReport } from "./Doctor.js";
import { renderDoctorHumanReport } from "./DoctorHumanReport.js";

const report = (): DoctorReport =>
  ({
    healthy: false,
    environment_healthy: false,
    scope: {
      mode: "audit-wide",
      clients: [],
      providers: [],
      skill: false,
      target: null,
    },
    scope_checks: [
      {
        name: "target",
        ok: false,
        classification: "unsupported_target",
        detail: "/fixture/app",
        details: { reason: "Unsupported format" },
        remediation: "Select a supported local target.",
      },
      {
        name: "node",
        ok: true,
        classification: "healthy",
      },
    ],
    informational_checks: [
      {
        name: "registration:cursor",
        ok: false,
        classification: "config_drift",
        remediation: "Select a supported local target.",
      },
    ],
    checks: [],
  }) as DoctorReport;

describe("human doctor report", () => {
  it("keeps summary output aggregate-only and advises how to request details", () => {
    const output = renderDoctorHumanReport(
      report(),
      { summary: true, failuresOnly: false },
      {
        blockerChecks: [report().scope_checks[0]!],
        optionalChecks: [report().informational_checks[0]!],
      },
    );

    expect(output).toContain("Scope checks: 2 total, 1 passed, 1 failed.");
    expect(output).toContain(
      "Informational checks: 1 total, 0 passed, 1 failed.",
    );
    expect(output).toContain(
      "Run `rea doctor` without `--summary` or `--failures-only`",
    );
    expect(output).not.toContain("Detail: /fixture/app");
    expect(output).not.toContain("Remediation:");
    expect(output).toContain("1 blocker check; 1 optional check.");
    expect(output).not.toContain("Blocker checks: target.");
    expect(output).not.toContain("Optional checks: registration:cursor.");
  });

  it("groups verbatim remediation text and explains audit-wide readiness", () => {
    const value = report();
    const output = renderDoctorHumanReport(
      value,
      { summary: false, failuresOnly: true },
      {
        blockerChecks: [value.scope_checks[0]!],
        optionalChecks: [value.informational_checks[0]!],
      },
    );

    expect(output).toContain("- target: failed.");
    expect(output).toContain("  Detail: /fixture/app");
    expect(output).toContain('  Details: {"reason":"Unsupported format"}');
    expect(output).toContain(
      "Select a supported local target.\n  Checks: target, registration:cursor",
    );
    expect(output).toContain(
      "Audit-wide raw failures are diagnostics, not automatic readiness blockers",
    );
    expect(output).not.toContain("- node: passed.");
  });

  it("reports incomplete checks independently from completed failures", () => {
    const value = {
      ...report(),
      execution: {
        complete: false,
        stop_reason: "deadline" as const,
        deadline_ms: 500,
      },
      scope_checks: [
        {
          ...report().scope_checks[0]!,
          execution_status: "timed_out" as const,
        },
      ],
    };

    const output = renderDoctorHumanReport(value, {
      summary: false,
      failuresOnly: true,
    });
    expect(output).toContain(
      "Scope checks: 1 total, 0 passed, 0 failed, 1 incomplete.",
    );
    expect(output).toContain("Execution: incomplete (deadline).");
    expect(output).toContain("- target: timed out.");
  });
});
