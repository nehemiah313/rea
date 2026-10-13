import { z } from "zod";

import { jsonValueSchema } from "../domain/jsonValue.js";

/** Version of the compact doctor-report wire contract. */
export const DOCTOR_REPORT_CONTRACT_VERSION = 1 as const;

/** A probe that did not reach a completed diagnostic result. */
export const doctorCheckExecutionStatusSchema = z.enum([
  "completed",
  "timed_out",
  "cancelled",
  "not_examined",
]);

/** Stable public classifications assigned to doctor diagnostics. */
export const doctorCheckClassificationSchema = z.enum([
  "healthy",
  "missing_dependency",
  "unsupported_host",
  "unsupported_target",
  "missing_analysis_engine",
  "config_drift",
  "diagnostic_incomplete",
]);

/** One doctor diagnostic, including JSON-safe structured detail when supplied. */
export const doctorCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    classification: doctorCheckClassificationSchema,
    detail: z.string().optional(),
    details: z.record(z.string(), jsonValueSchema).optional(),
    remediation: z.string().optional(),
    execution_status: doctorCheckExecutionStatusSchema.optional(),
  })
  .strict();

/** Normalized readiness boundary included in doctor reports. */
export const doctorReportScopeSchema = z
  .object({
    mode: z.enum(["audit-wide", "explicit"]),
    clients: z.array(z.string()).readonly(),
    skill_clients: z.array(z.string()).readonly().optional(),
    providers: z.array(z.string()).readonly(),
    skill: z.boolean(),
    target: z.string().nullable(),
  })
  .strict();

/** Completion metadata retained when diagnosis stopped before every probe completed. */
export const doctorReportExecutionSchema = z
  .object({
    complete: z.boolean(),
    stop_reason: z.enum(["deadline", "cancelled"]).nullable(),
    deadline_ms: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.complete && execution.stop_reason !== null)
      context.addIssue({
        code: "custom",
        path: ["stop_reason"],
        message: "Complete reports must have a null stop_reason",
      });
  });

const nonnegativeInteger = z.number().int().nonnegative();

/** Original check counts, before presentation filtering. */
export const doctorCheckCountsSchema = z
  .object({
    total: nonnegativeInteger,
    passed: nonnegativeInteger,
    failed: nonnegativeInteger,
    // Omitted for complete reports to keep the established compact shape exact.
    incomplete: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((counts, context) => {
    const accounted = counts.passed + counts.failed + (counts.incomplete ?? 0);
    if (counts.total !== accounted)
      context.addIssue({
        code: "custom",
        path: ["total"],
        message:
          "total must equal passed + failed plus incomplete when incomplete is present",
      });
  });

const compactDoctorReportBaseShape = {
  report_contract_version: z.literal(DOCTOR_REPORT_CONTRACT_VERSION),
  healthy: z.boolean(),
  environment_healthy: z.boolean(),
  scope: doctorReportScopeSchema,
  check_counts: z
    .object({
      scope: doctorCheckCountsSchema,
      informational: doctorCheckCountsSchema,
    })
    .strict(),
  execution: doctorReportExecutionSchema.optional(),
};

/** Compact status with aggregate counts only. */
export const doctorReportSummarySchema = z
  .object({
    report_view: z.literal("summary"),
    ...compactDoctorReportBaseShape,
  })
  .strict();

/** Compact status retaining failed or incomplete diagnostics. */
export const doctorFailureReportSchema = z
  .object({
    report_view: z.literal("failures-only"),
    ...compactDoctorReportBaseShape,
    scope_checks: z.array(doctorCheckSchema).readonly(),
    informational_checks: z.array(doctorCheckSchema).readonly(),
  })
  .strict();

/** Strict discriminated compact doctor-report contract. */
export const compactDoctorReportSchema = z.discriminatedUnion("report_view", [
  doctorReportSummarySchema,
  doctorFailureReportSchema,
]);

const doctorProviderCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    code: z.string().nullable(),
    detail: z.string(),
    remediation: z.string().nullable(),
    classification: doctorCheckClassificationSchema.exclude(["healthy"]),
  })
  .passthrough();

// Provider adapters own their detailed observations. Retain unknown additive
// provider fields while validating the common envelope available to doctor.
const doctorProviderInspectionSchema = z
  .object({
    id: z.string(),
    configured: z.boolean(),
    available: z.boolean(),
    providerVersion: z.string().nullable(),
    registrationEnvironment: z.record(z.string(), z.string()),
    checks: z.array(doctorProviderCheckSchema).readonly(),
  })
  .passthrough();

/**
 * Full doctor report validation. The full report deliberately remains additive:
 * identity and provider owners may carry fields outside this boundary, while
 * public doctor checks retain their strict known shape.
 */
export const doctorReportSchema = z
  .object({
    healthy: z.boolean(),
    environment_healthy: z.boolean(),
    scope: doctorReportScopeSchema,
    scope_checks: z.array(doctorCheckSchema).readonly(),
    informational_checks: z.array(doctorCheckSchema).readonly(),
    hopperPath: z.string().optional(),
    providerInspections: z
      .array(doctorProviderInspectionSchema)
      .readonly()
      .optional(),
    checks: z.array(doctorCheckSchema).readonly(),
    // Identity is owned by package, catalog, skill, and client boundaries.
    identity: z.unknown().optional(),
    execution: doctorReportExecutionSchema.optional(),
  })
  .passthrough();

/** Inferred compact summary contract type. */
export type DoctorReportSummary = Readonly<
  z.output<typeof doctorReportSummarySchema>
>;
/** Inferred compact failures-only contract type. */
export type DoctorFailureReport = Readonly<
  z.output<typeof doctorFailureReportSchema>
>;
/** Inferred discriminated compact report contract type. */
export type CompactDoctorReport = z.output<typeof compactDoctorReportSchema>;
/** Inferred optional execution metadata. */
export type DoctorReportExecution = z.output<
  typeof doctorReportExecutionSchema
>;

/** Named JSON Schema for summary-mode compact reports. */
export const doctorReportSummaryJsonSchema = z.toJSONSchema(
  doctorReportSummarySchema,
  { unrepresentable: "any" },
);
/** Named JSON Schema for failures-only compact reports. */
export const doctorFailureReportJsonSchema = z.toJSONSchema(
  doctorFailureReportSchema,
  { unrepresentable: "any" },
);
/** Named JSON Schema for the compact discriminated report union. */
export const compactDoctorReportJsonSchema = z.toJSONSchema(
  compactDoctorReportSchema,
  { unrepresentable: "any" },
);
/** Named JSON Schema for additive full doctor reports. */
export const doctorReportJsonSchema = z.toJSONSchema(doctorReportSchema, {
  unrepresentable: "any",
});
