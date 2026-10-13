import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  compactDoctorReportJsonSchema,
  compactDoctorReportSchema,
  doctorCheckSchema,
  doctorFailureReportJsonSchema,
  doctorReportJsonSchema,
  doctorReportSchema,
  doctorReportSummaryJsonSchema,
  doctorReportSummarySchema,
} from "./doctorReportSchemas.js";

const scope = {
  mode: "explicit" as const,
  clients: ["codex"],
  providers: [],
  skill: false,
  target: null,
};

const counts = {
  scope: { total: 2, passed: 1, failed: 1 },
  informational: { total: 0, passed: 0, failed: 0 },
};

const summary = {
  report_contract_version: 1 as const,
  report_view: "summary" as const,
  healthy: false,
  environment_healthy: false,
  scope,
  check_counts: counts,
};

const check = {
  name: "target",
  ok: false,
  classification: "unsupported_target" as const,
  detail: "/fixture/app",
  details: { offsets: [0, 128], reason: "Unsupported format" },
  remediation: "Select a supported local target.",
};

describe("doctor compact report contracts", () => {
  it("accepts each exact report_view branch and rejects branch mixing", () => {
    expect(doctorReportSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      compactDoctorReportSchema.safeParse({
        ...summary,
        report_view: "failures-only",
        scope_checks: [check],
        informational_checks: [],
      }).success,
    ).toBe(true);
    expect(
      compactDoctorReportSchema.safeParse({
        ...summary,
        scope_checks: [],
      }).success,
    ).toBe(false);
    expect(
      compactDoctorReportSchema.safeParse({
        ...summary,
        report_view: "unknown",
      }).success,
    ).toBe(false);
    expect(
      compactDoctorReportSchema.safeParse({
        ...summary,
        report_contract_version: 2,
      }).success,
    ).toBe(false);
  });

  it("enforces complete count conservation and only permits positive incomplete counts", () => {
    expect(
      doctorReportSummarySchema.safeParse({
        ...summary,
        check_counts: {
          ...counts,
          scope: { total: 2, passed: 1, failed: 0, incomplete: 1 },
        },
      }).success,
    ).toBe(true);
    expect(
      doctorReportSummarySchema.safeParse({
        ...summary,
        check_counts: {
          ...counts,
          scope: { total: 2, passed: 1, failed: 1, incomplete: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      doctorReportSummarySchema.safeParse({
        ...summary,
        check_counts: {
          ...counts,
          scope: { total: 2, passed: 1, failed: 1, incomplete: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it("strictly validates known check fields and JSON-safe structured detail", () => {
    expect(
      doctorCheckSchema.safeParse({
        ...check,
        execution_status: "not_examined",
        classification: "diagnostic_incomplete",
      }).success,
    ).toBe(true);
    expect(
      doctorCheckSchema.safeParse({ ...check, unknown: true }).success,
    ).toBe(false);
    expect(
      doctorCheckSchema.safeParse({
        ...check,
        details: { invalid: Number.NaN },
      }).success,
    ).toBe(false);
  });

  it("retains additive full-report identity and provider fields", () => {
    const parsed = doctorReportSchema.parse({
      healthy: false,
      environment_healthy: false,
      scope,
      scope_checks: [check],
      informational_checks: [],
      checks: [check],
      identity: { future_identity_field: { retained: true } },
      providerInspections: [
        {
          id: "example",
          configured: true,
          available: false,
          providerVersion: null,
          registrationEnvironment: { MODE: "test" },
          checks: [
            {
              name: "example",
              ok: false,
              code: "missing",
              detail: "not installed",
              remediation: "Install it.",
              classification: "missing_analysis_engine",
              provider_owned_detail: { retained: true },
            },
          ],
          provider_owned_field: "retained",
        },
      ],
      execution: {
        complete: false,
        stop_reason: "deadline",
        deadline_ms: 500,
      },
      future_root_field: "retained",
    });

    expect(parsed).toMatchObject({
      identity: { future_identity_field: { retained: true } },
      providerInspections: [
        {
          provider_owned_field: "retained",
          checks: [{ provider_owned_detail: { retained: true } }],
        },
      ],
      future_root_field: "retained",
    });
  });

  it("publishes usable named JSON schemas for each compact report", () => {
    const ajv = new Ajv2020({ strict: false });
    const validateSummary = ajv.compile(doctorReportSummaryJsonSchema);
    const validateFailures = ajv.compile(doctorFailureReportJsonSchema);
    const validateCompact = ajv.compile(compactDoctorReportJsonSchema);

    expect(validateSummary(summary)).toBe(true);
    const failures = {
      ...summary,
      report_view: "failures-only" as const,
      scope_checks: [check],
      informational_checks: [],
    };
    expect(validateFailures(failures)).toBe(true);
    expect(validateCompact(summary)).toBe(true);
    expect(validateCompact(failures)).toBe(true);
    expect(doctorReportJsonSchema).toMatchObject({ type: "object" });
  });
});
