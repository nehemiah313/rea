import { describe, expect, it } from "vitest";

import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { runDoctor, runDoctorOwned } from "./Doctor.js";
import { projectDoctorReport } from "./DoctorReportView.js";

const full = { summary: false, failuresOnly: false };
const summary = { summary: true, failuresOnly: false };
const failures = { summary: false, failuresOnly: true };

const registrationHost = () =>
  createDoctorHostFixture({
    clientRegistrations: () =>
      Promise.resolve([
        {
          client: "codex",
          config_path: "/fixture/home/.codex/config.toml",
          command: ["rea", "mcp"],
          state: "aligned",
          remediation: null,
        },
        {
          client: "cursor",
          config_path: "/fixture/home/.cursor/mcp.json",
          command: ["old-rea", "mcp"],
          state: "stale",
          remediation: "Run rea setup --client cursor.",
        },
      ]),
  });

describe("doctor report views", () => {
  it("returns the original full report by default", async () => {
    const report = await runDoctor(undefined, createDoctorHostFixture());
    expect(projectDoctorReport(report, full)).toBe(report);
    expect(report).not.toHaveProperty("report_view");
  });

  it("summarizes required and informational checks independently", async () => {
    const report = await runDoctor(undefined, registrationHost(), {
      clients: ["codex"],
    });
    expect(projectDoctorReport(report, summary)).toEqual({
      report_view: "summary",
      report_contract_version: 1,
      healthy: true,
      environment_healthy: false,
      scope: report.scope,
      check_counts: {
        scope: { total: 2, passed: 2, failed: 0 },
        informational: { total: 3, passed: 2, failed: 1 },
      },
    });
  });

  it("keeps informational drift visible without making a ready scope fail", async () => {
    const report = await runDoctor(undefined, registrationHost(), {
      clients: ["codex"],
    });
    const original = structuredClone(report);
    expect(projectDoctorReport(report, failures)).toEqual({
      report_view: "failures-only",
      report_contract_version: 1,
      healthy: true,
      environment_healthy: false,
      scope: report.scope,
      check_counts: {
        scope: { total: 2, passed: 2, failed: 0 },
        informational: { total: 3, passed: 2, failed: 1 },
      },
      scope_checks: [],
      informational_checks: report.informational_checks.filter(({ ok }) => !ok),
    });
    expect(report).toEqual(original);
  });

  it("preserves required target diagnostics, exact details and remediation", async () => {
    const check = {
      name: "target",
      ok: false,
      classification: "unsupported_target" as const,
      detail: "/fixture/app",
      details: { reason: "Unsupported format", offsets: [0, 128] },
      remediation: "Select a supported local target.",
    };
    const report = await runDoctor(
      check.detail,
      createDoctorHostFixture({ inspectTarget: () => Promise.resolve(check) }),
      { skill: false },
    );
    expect(projectDoctorReport(report, failures)).toMatchObject({
      healthy: false,
      scope: { target: check.detail },
      check_counts: { scope: { total: 2, passed: 1, failed: 1 } },
      scope_checks: [check],
    });
  });

  it("counts audit-wide failures without duplicating the audit arrays", async () => {
    const report = await runDoctor(undefined, registrationHost());
    const view = projectDoctorReport(report, failures);
    expect(view).toMatchObject({
      healthy: false,
      environment_healthy: false,
      scope: { mode: "audit-wide" },
      check_counts: {
        scope: { total: 4, passed: 3, failed: 1 },
        informational: { total: 0, passed: 0, failed: 0 },
      },
      scope_checks: [expect.objectContaining({ name: "registration:cursor" })],
      informational_checks: [],
    });
    expect(view).not.toHaveProperty("checks");
    expect(view).not.toHaveProperty("identity");
  });

  it("retains cleanup failures produced after otherwise successful diagnosis", async () => {
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        close: () => Promise.resolve("Cleanup failed"),
      }),
      { skill: false },
    );
    expect(projectDoctorReport(report, failures)).toMatchObject({
      healthy: false,
      environment_healthy: false,
      scope_checks: [
        expect.objectContaining({
          name: "doctor-resource-cleanup",
          detail: "Cleanup failed",
        }),
      ],
      check_counts: { scope: { total: 2, passed: 1, failed: 1 } },
    });
  });

  it("lets failures-only include summary counts when both options are selected", async () => {
    const report = await runDoctor(undefined, createDoctorHostFixture());
    expect(
      projectDoctorReport(report, { summary: true, failuresOnly: true }),
    ).toEqual(projectDoctorReport(report, failures));
  });

  it("preserves execution metadata and counts incomplete checks separately", async () => {
    const base = await runDoctor(undefined, createDoctorHostFixture());
    const report = {
      ...base,
      execution: {
        complete: false,
        stop_reason: "deadline" as const,
        deadline_ms: 500,
      },
      scope_checks: base.scope_checks.map((check, index) =>
        index === 0
          ? { ...check, ok: false, execution_status: "timed_out" as const }
          : check,
      ),
    };

    expect(projectDoctorReport(report, summary)).toMatchObject({
      report_view: "summary",
      report_contract_version: 1,
      execution: report.execution,
      check_counts: {
        scope: {
          total: base.scope_checks.length,
          passed: base.scope_checks.length - 1,
          failed: 0,
          incomplete: 1,
        },
      },
    });
    expect(projectDoctorReport(report, failures)).toMatchObject({
      scope_checks: [
        expect.objectContaining({ execution_status: "timed_out" }),
      ],
      check_counts: {
        scope: {
          total: base.scope_checks.length,
          passed: base.scope_checks.length - 1,
          failed: 0,
          incomplete: 1,
        },
      },
    });
  });
});
