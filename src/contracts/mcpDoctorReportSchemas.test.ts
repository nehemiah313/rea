import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  mcpDoctorCheckJsonSchema,
  mcpDoctorCheckCountsJsonSchema,
  mcpDoctorIncompleteJsonSchema,
  mcpDoctorSummaryReportJsonSchema,
  mcpDoctorFailuresOnlyReportJsonSchema,
  mcpDoctorCompactReportSchema,
  type McpDoctorSummaryReport,
  type McpDoctorFailuresOnlyReport,
} from "./mcpDoctorReportSchemas.js";

const summary: McpDoctorSummaryReport = {
  report_contract_version: 1,
  report_view: "summary",
  healthy: false,
  adapter: "production-stdio",
  check_counts: { total: 2, passed: 1, failed: 0, incomplete: 1 },
  incomplete: { reason: "timeout", not_examined: ["request-flow"] },
};
const failure: McpDoctorFailuresOnlyReport = {
  ...summary,
  report_view: "failures-only",
  checks: [
    {
      name: "request-flow",
      ok: false,
      detail: "Interrupted probe",
      execution_status: "timed_out",
    },
  ],
};

describe("MCP doctor published contracts", () => {
  it("validates every named JSON schema against representative facts", () => {
    const ajv = new Ajv2020({ strict: false });
    for (const [schema, value] of [
      [mcpDoctorCheckJsonSchema, failure.checks[0]],
      [mcpDoctorCheckCountsJsonSchema, summary.check_counts],
      [mcpDoctorIncompleteJsonSchema, summary.incomplete],
      [mcpDoctorSummaryReportJsonSchema, summary],
      [mcpDoctorFailuresOnlyReportJsonSchema, failure],
    ] as const)
      expect(ajv.compile(schema)(value)).toBe(true);
  });
  it("rejects invalid tags and count conservation violations", () => {
    expect(
      mcpDoctorCompactReportSchema.safeParse({
        ...summary,
        report_view: "failures-only",
      }).success,
    ).toBe(false);
    expect(
      mcpDoctorCompactReportSchema.safeParse({
        ...summary,
        check_counts: { total: 2, passed: 2, failed: 1 },
      }).success,
    ).toBe(false);
    expect(mcpDoctorCompactReportSchema.parse(failure).report_view).toBe(
      "failures-only",
    );
  });
  it("narrows diagnostics only in the failures-only variant", () => {
    const report: McpDoctorSummaryReport | McpDoctorFailuresOnlyReport =
      mcpDoctorCompactReportSchema.parse(failure);
    if (report.report_view === "failures-only")
      expect(report.checks).toHaveLength(1);
    else throw new Error("Unexpected summary");
  });
});
