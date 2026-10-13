import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  mcpDoctorCompactReportEnvelopeJsonSchema,
  mcpDoctorCompactReportEnvelopeSchema,
  mcpDoctorCompactReportJsonSchema,
  mcpDoctorCompactReportSchema,
} from "./contracts/mcpDoctorReportSchemas.js";
import {
  envelopeMcpDoctorCompactReport,
  projectMcpDoctorReport,
  renderMcpDoctorHuman,
  type McpDoctorReportSource,
} from "./mcpDoctorReport.js";

const source = (overrides: Partial<McpDoctorReportSource> = {}) =>
  ({
    healthy: false,
    adapter: "production-stdio" as const,
    checks: [
      { name: "initialize", ok: true, detail: "rea@1; protocol=1" },
      { name: "request-flow", ok: false, detail: "deadline expired" },
    ],
    incomplete: {
      reason: "timeout" as const,
      not_examined: ["server-identity"],
    },
    ...overrides,
  }) satisfies McpDoctorReportSource;

describe("MCP doctor report projections", () => {
  it("uses the exact versioned summary discriminator and counts original checks", () => {
    expect(
      projectMcpDoctorReport(source(), {
        summary: true,
        failuresOnly: false,
      }),
    ).toEqual({
      report_contract_version: 1,
      report_view: "summary",
      healthy: false,
      adapter: "production-stdio",
      check_counts: { total: 2, passed: 1, failed: 1 },
      incomplete: {
        reason: "timeout",
        not_examined: ["server-identity"],
      },
    });
  });

  it("keeps only failed checks while retaining their exact details", () => {
    const report = source();
    const view = projectMcpDoctorReport(report, {
      summary: true,
      failuresOnly: true,
    });
    expect(view).toEqual({
      report_contract_version: 1,
      report_view: "failures-only",
      healthy: false,
      adapter: "production-stdio",
      check_counts: { total: 2, passed: 1, failed: 1 },
      incomplete: {
        reason: "timeout",
        not_examined: ["server-identity"],
      },
      checks: [{ name: "request-flow", ok: false, detail: "deadline expired" }],
    });
    expect(report.checks).toHaveLength(2);
    expect(mcpDoctorCompactReportSchema.parse(view)).toEqual(view);
  });

  it("runtime-validates appropriate full-output success and failure envelopes", () => {
    const failure = projectMcpDoctorReport(source(), {
      summary: false,
      failuresOnly: true,
    });
    expect(envelopeMcpDoctorCompactReport(failure)).toEqual({
      ok: false,
      error: failure,
    });
    const healthy = projectMcpDoctorReport(
      {
        healthy: true,
        adapter: "production-stdio",
        checks: [{ name: "initialize", ok: true, detail: "ok" }],
      },
      { summary: true, failuresOnly: false },
    );
    expect(envelopeMcpDoctorCompactReport(healthy)).toEqual({
      ok: true,
      data: healthy,
    });
    expect(
      mcpDoctorCompactReportEnvelopeSchema.safeParse({
        ok: false,
        error: { ...failure, report_contract_version: 2 },
      }).success,
    ).toBe(false);
  });

  it("exports Draft 2020-12 schemas that validate the same compact documents", () => {
    const report = projectMcpDoctorReport(source(), {
      summary: false,
      failuresOnly: true,
    });
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(mcpDoctorCompactReportJsonSchema)(report)).toBe(true);
    expect(
      ajv.compile(mcpDoctorCompactReportEnvelopeJsonSchema)(
        envelopeMcpDoctorCompactReport(report),
      ),
    ).toBe(true);
  });

  it("makes clear that it starts a fresh server instead of inspecting a client session", () => {
    const text = renderMcpDoctorHuman(source(), undefined);
    expect(text).toContain("fresh REA stdio server");
    expect(text).toContain("active client session");
    expect(text).toContain("Incomplete: timeout");
  });
});

it("human output uses the same incomplete counts without compact flags", () => {
  const text = renderMcpDoctorHuman(
    {
      healthy: false,
      adapter: "production-stdio",
      checks: [
        {
          name: "transport",
          ok: false,
          detail: "interrupted",
          execution_status: "timed_out",
        },
      ],
    },
    undefined,
  );
  expect(text).toContain("0 failed");
  expect(text).toContain("Incomplete checks: 1");
});
