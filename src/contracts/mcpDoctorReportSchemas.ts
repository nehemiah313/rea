import { z } from "zod";

/** One completed MCP doctor observation, retaining its original diagnostic detail. */
export const mcpDoctorCheckSchema = z
  .object({
    name: z.string().min(1),
    ok: z.boolean(),
    detail: z.string(),
    execution_status: z
      .enum(["completed", "timed_out", "cancelled", "not_examined"])
      .optional(),
  })
  .strict();
export type McpDoctorCheck = z.infer<typeof mcpDoctorCheckSchema>;

/** Counts describe every completed doctor check before presentation filtering. */
export const mcpDoctorCheckCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    incomplete: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.total !== value.passed + value.failed + (value.incomplete ?? 0))
      context.addIssue({
        code: "custom",
        message: "check_counts.total must equal passed plus failed",
      });
  });
export type McpDoctorCheckCounts = z.infer<typeof mcpDoctorCheckCountsSchema>;

/** Explicitly preserve work the deadline prevented the doctor from examining. */
export const mcpDoctorIncompleteSchema = z
  .object({
    reason: z.enum(["timeout", "cancelled", "dependency_failed"]),
    not_examined: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type McpDoctorIncomplete = z.infer<typeof mcpDoctorIncompleteSchema>;

const mcpDoctorCompactReportBaseSchema = z
  .object({
    report_contract_version: z.literal(1),
    healthy: z.boolean(),
    adapter: z.literal("production-stdio"),
    check_counts: mcpDoctorCheckCountsSchema,
    incomplete: mcpDoctorIncompleteSchema.optional(),
  })
  .strict();

/** Versioned compact status report without individual diagnostic details. */
export const mcpDoctorSummaryReportSchema =
  mcpDoctorCompactReportBaseSchema.extend({
    report_view: z.literal("summary"),
  });
export type McpDoctorSummaryReport = z.infer<
  typeof mcpDoctorSummaryReportSchema
>;

/** Versioned compact report that retains only original failed check details. */
export const mcpDoctorFailuresOnlyReportSchema =
  mcpDoctorCompactReportBaseSchema.extend({
    report_view: z.literal("failures-only"),
    checks: z.array(mcpDoctorCheckSchema),
  });
export type McpDoctorFailuresOnlyReport = z.infer<
  typeof mcpDoctorFailuresOnlyReportSchema
>;

/** Every versioned machine-oriented MCP doctor compact report. */
export const mcpDoctorCompactReportSchema = z.discriminatedUnion(
  "report_view",
  [mcpDoctorSummaryReportSchema, mcpDoctorFailuresOnlyReportSchema],
);
export type McpDoctorCompactReport = z.infer<
  typeof mcpDoctorCompactReportSchema
>;

/** Full-output envelope for a compact report selected by the caller. */
export const mcpDoctorCompactReportEnvelopeSchema = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), data: mcpDoctorCompactReportSchema })
    .strict(),
  z
    .object({ ok: z.literal(false), error: mcpDoctorCompactReportSchema })
    .strict(),
]);
export type McpDoctorCompactReportEnvelope = z.infer<
  typeof mcpDoctorCompactReportEnvelopeSchema
>;

/** JSON Schema for one completed doctor check. */
export const mcpDoctorCheckJsonSchema = z.toJSONSchema(mcpDoctorCheckSchema, {
  target: "draft-2020-12",
});

/** JSON Schema for compact-report check counts. */
export const mcpDoctorCheckCountsJsonSchema = z.toJSONSchema(
  mcpDoctorCheckCountsSchema,
  { target: "draft-2020-12" },
);

/** JSON Schema for deadline-related incompleteness metadata. */
export const mcpDoctorIncompleteJsonSchema = z.toJSONSchema(
  mcpDoctorIncompleteSchema,
  { target: "draft-2020-12" },
);

/** JSON Schema for the summary discriminator branch. */
export const mcpDoctorSummaryReportJsonSchema = z.toJSONSchema(
  mcpDoctorSummaryReportSchema,
  { target: "draft-2020-12" },
);

/** JSON Schema for the failures-only discriminator branch. */
export const mcpDoctorFailuresOnlyReportJsonSchema = z.toJSONSchema(
  mcpDoctorFailuresOnlyReportSchema,
  { target: "draft-2020-12" },
);

/** JSON Schema for every versioned compact MCP doctor report. */
export const mcpDoctorCompactReportJsonSchema = z.toJSONSchema(
  mcpDoctorCompactReportSchema,
  { target: "draft-2020-12" },
);

/** JSON Schema for compact-report full-output envelopes. */
export const mcpDoctorCompactReportEnvelopeJsonSchema = z.toJSONSchema(
  mcpDoctorCompactReportEnvelopeSchema,
  { target: "draft-2020-12" },
);
