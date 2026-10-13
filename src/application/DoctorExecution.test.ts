import { describe, expect, it } from "vitest";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { runDoctorOwned, getDoctorReadiness } from "./Doctor.js";
import { DoctorExecution } from "./DoctorExecution.js";
import { execFileOutput } from "../process/ExecFileOutput.js";

const interruptible = (signal?: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

describe("doctor bounded execution", () => {
  it("retains ready registrations when optional installation discovery times out", async () => {
    let cleaned = false;
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        clientRegistrations: async () => [
          {
            client: "codex",
            config_path: "/fixture/codex",
            command: ["rea", "mcp"],
            state: "aligned",
            remediation: null,
          },
        ],
        installationPaths: (signal) => interruptible(signal),
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          cleaned = true;
          return undefined;
        },
      }),
      { clients: ["codex"] },
      { deadlineMs: 30 },
    );
    expect(cleaned).toBe(true);
    expect(report.identity).toMatchObject({
      skill: { state: "aligned" },
      registrations: [expect.objectContaining({ client: "codex" })],
      installations: { state: "unknown" },
      observations: {
        installations: "incomplete",
        skill: "completed",
        registrations: "completed",
      },
    });
    expect(report.healthy).toBe(true);
    expect(report.environment_healthy).toBe(false);
    expect(report.execution).toEqual({
      complete: false,
      stop_reason: "deadline",
      deadline_ms: 30,
    });
    expect(report.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "installation:paths",
        execution_status: "timed_out",
        classification: "diagnostic_incomplete",
      }),
    );
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:codex", ok: true }),
    );
  });

  it("never reports a timed-out required registration as missing or ready", async () => {
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        clientRegistrations: (signal) => interruptible(signal),
      }),
      { clients: ["codex"] },
      { deadlineMs: 20 },
    );
    expect(report.healthy).toBe(false);
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:codex",
        classification: "diagnostic_incomplete",
        execution_status: "timed_out",
      }),
    );
    expect(
      report.scope_checks.find(({ name }) => name === "registration:codex")
        ?.detail,
    ).not.toContain("not detected");
  });

  it("labels required provider discovery as incomplete rather than unavailable", async () => {
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        providerInspections: (signal) => interruptible(signal),
      }),
      { providers: ["ghidra"] },
      { deadlineMs: 20 },
    );
    expect(report.healthy).toBe(false);
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "provider:ghidra",
        classification: "diagnostic_incomplete",
      }),
    );
    expect(report.scope_checks).not.toContainEqual(
      expect.objectContaining({ classification: "missing_analysis_engine" }),
    );
  });

  it("retains completed identity evidence when target admission is interrupted", async () => {
    const report = await runDoctorOwned(
      "/fixture/target",
      createDoctorHostFixture({
        inspectTarget: (_path, signal) => interruptible(signal),
      }),
      { skill: false },
      { deadlineMs: 20 },
    );
    expect(report.healthy).toBe(false);
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "target",
        execution_status: "timed_out",
      }),
    );
    expect(report.identity?.skill.state).toBe("aligned");
  });
});

describe("doctor cancellation and cleanup", () => {
  it("records external cancellation and retains cleanup failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({ close: async () => "cleanup failed" }),
      { skill: false },
      { signal: controller.signal },
    );
    expect(report.execution?.stop_reason).toBe("cancelled");
    expect(report.healthy).toBe(false);
    expect(getDoctorReadiness(report).blockerChecks).toContainEqual(
      expect.objectContaining({ name: "doctor-resource-cleanup" }),
    );
  });

  it("keeps optional missing-provider failures out of audit blockers", async () => {
    const report = await runDoctorOwned(
      undefined,
      createDoctorHostFixture({
        executable: async () => false,
        providerInspections: async () => [
          {
            id: "ghidra",
            configured: true,
            available: true,
            providerVersion: "12.1.4",
            registrationEnvironment: {},
            checks: [],
          },
        ],
      }),
    );
    expect(report.healthy).toBe(true);
    expect(getDoctorReadiness(report).blockerChecks).toEqual([]);
    expect(getDoctorReadiness(report).optionalChecks).toContainEqual(
      expect.objectContaining({ name: "hopper", ok: false }),
    );
    expect(report).not.toHaveProperty("execution");
  });

  it("awaits the supervised child exit rather than abandoning a timed-out subprocess", async () => {
    const execution = new DoctorExecution({ deadlineMs: 80 });
    let settled = false;
    try {
      const result = await execution.probe("test-child", async () => {
        try {
          return await execFileOutput(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { signal: execution.signal, stopSignal: "SIGTERM" },
          );
        } finally {
          settled = true;
        }
      });
      expect(result).toMatchObject({
        ok: false,
        check: { execution_status: "timed_out" },
      });
      expect(settled).toBe(true);
    } finally {
      execution.close();
    }
  });

  it("preserves full target report ordering for signal-only execution", async () => {
    const controller = new AbortController();
    const before = await runDoctorOwned(
      "/fixture/Hopper",
      createDoctorHostFixture(),
    );
    const after = await runDoctorOwned(
      "/fixture/Hopper",
      createDoctorHostFixture(),
      undefined,
      { signal: controller.signal },
    );
    expect(after).toEqual(before);
    expect(after.checks.at(-1)?.name).toBe("target");
  });

  it("rejects deadlines that timers would clamp", () => {
    for (const deadlineMs of [0, -1, 1.5, Infinity, 2_147_483_648])
      expect(() => new DoctorExecution({ deadlineMs })).toThrow(RangeError);
  });
});
