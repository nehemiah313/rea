import { mcpDoctorCompactReportSchema } from "../../../src/contracts/mcpDoctorReportSchemas.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  doctorReportSummarySchema,
  doctorFailureReportSchema,
  doctorReportSchema,
} from "../../../src/contracts/doctorReportSchemas.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

cliTest(
  "doctor contracts preserve envelopes, filtering, and format behavior",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-doctor-contract-");
    const run = (args: readonly string[]) =>
      cli.run({
        arguments: ["doctor", "--client", "codex", ...args],
        environment: { HOME: home, USERPROFILE: home },
      });
    const summary = await run(["--summary", "--json"]);
    const parsed = doctorReportSummarySchema.parse(summary.json);
    expect(summary.exitCode).toBe(1);
    expect(parsed.report_contract_version).toBe(1);
    const full = await run(["--summary", "--json", "--full-output"]);
    expect(full.json).toMatchObject({
      ok: false,
      error: parsed,
      meta: { command: "doctor" },
    });
    const filtered = await run([
      "--summary",
      "--json",
      "--filter-output",
      "healthy",
    ]);
    expect(filtered.exitCode).toBe(1);
    expect(filtered.json).toBe(false);
    const failures = await run(["--failures-only", "--format", "jsonl"]);
    expect(
      doctorFailureReportSchema.parse(failures.json).scope_checks,
    ).toContainEqual(expect.objectContaining({ name: "registration:codex" }));
    const yaml = await run(["--summary", "--format", "yaml"]);
    expect(yaml.exitCode).toBe(1);
    expect(yaml.stdout).toContain("report_contract_version: 1");
    const audit = await cli.run({
      arguments: ["doctor", "--summary", "--json"],
      environment: { HOME: home, USERPROFILE: home },
    });
    expect(doctorReportSummarySchema.parse(audit.json).scope.mode).toBe(
      "audit-wide",
    );
  },
  60_000,
);

cliTest(
  "human doctor is plain text, read-only, and rejects structured combinations",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-doctor-human-");
    const directory = join(home, ".config/opencode");
    const path = join(directory, "opencode.json");
    await mkdir(directory, { recursive: true });
    const registration = JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [
            "npx",
            "-y",
            PRODUCT_IDENTITY.registrationPackageSpecifier,
            "mcp",
          ],
          enabled: true,
        },
      },
    });
    await writeFile(path, registration);
    const environment = { HOME: home, USERPROFILE: home, NO_COLOR: "1" };
    const human = await cli.run({
      arguments: ["doctor", "--client", "opencode", "--human", "--summary"],
      environment,
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("REA doctor: ready.");
    expect(human.stdout).toContain("0 blocker");
    expect(human.stdout).not.toContain("\u001b[");
    expect(human.stdout.trim()).not.toMatch(/^\{/u);
    expect(await readFile(path, "utf8")).toBe(registration);
    for (const flag of ["--json", "--full-output", "--token-count"]) {
      const invalid = await cli.run({
        arguments: ["doctor", "--human", flag],
        environment,
      });
      expect(invalid.exitCode).toBe(1);
      expect(invalid.json).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
      expect(invalid.stdout).not.toContain("REA doctor:");
    }
  },
  60_000,
);

cliTest(
  "invalid boolean and deadline values fail before diagnostics",
  async ({ cli }) => {
    for (const flag of [
      "--summary=invalid",
      "--failures-only=invalid",
      "--human=invalid",
      "--deadline-ms=0",
      "--deadline-ms=1.5",
      "--deadline-ms=2147483648",
    ]) {
      const result = await cli.run({
        arguments: ["doctor", "--skill=false", flag, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("VALIDATION_ERROR");
      expect(result.stdout).not.toContain("cli_package_version");
      expect(result.stdout).not.toContain("scope_checks");
    }
    const help = await cli.run({
      arguments: ["doctor", "--summary=invalid", "--help"],
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--deadline-ms");
  },
  60_000,
);

cliTest(
  "deadline reports are schema-valid and default JSON remains unversioned",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-doctor-deadline-");
    const environment = { HOME: home, USERPROFILE: home };
    const bounded = await cli.run({
      arguments: [
        "doctor",
        "--skill=false",
        "--deadline-ms",
        "1",
        "--failures-only",
        "--json",
      ],
      environment,
    });
    const report = doctorFailureReportSchema.parse(bounded.json);
    expect(report.execution).toMatchObject({
      complete: false,
      stop_reason: "deadline",
      deadline_ms: 1,
    });
    expect([
      ...report.scope_checks,
      ...report.informational_checks,
    ]).toContainEqual(
      expect.objectContaining({ classification: "diagnostic_incomplete" }),
    );
    const full = await cli.run({
      arguments: ["doctor", "--skill=false", "--json"],
      environment,
    });
    doctorReportSchema.parse(full.json);
    expect(full.json).not.toHaveProperty("report_view");
    expect(full.json).not.toHaveProperty("report_contract_version");
    expect(full.json).not.toHaveProperty("execution");
  },
  30_000,
);

cliTest(
  "MCP doctor shares compact views and reports incomplete deadlines",
  async ({ cli }) => {
    const summary = await cli.run({
      arguments: ["mcp", "doctor", "--summary", "--json"],
    });
    expect(summary.exitCode).toBe(0);
    expect(mcpDoctorCompactReportSchema.parse(summary.json)).toMatchObject({
      report_view: "summary",
      healthy: true,
      report_contract_version: 1,
    });
    const failures = await cli.run({
      arguments: [
        "mcp",
        "doctor",
        "--summary",
        "--failures-only",
        "--json",
        "--full-output",
      ],
    });
    expect(failures.json).toMatchObject({
      ok: true,
      data: { report_view: "failures-only", checks: [] },
    });
    const bounded = await cli.run({
      arguments: [
        "mcp",
        "doctor",
        "--deadline-ms",
        "1",
        "--failures-only",
        "--json",
      ],
    });
    const report = mcpDoctorCompactReportSchema.parse(bounded.json);
    expect(bounded.exitCode).toBe(1);
    expect(report.incomplete?.reason).toBe("timeout");
    expect(report.check_counts.failed).toBe(0);
    expect(report.check_counts.incomplete).toBeGreaterThan(0);
    if (report.report_view === "failures-only")
      expect(report.checks).toContainEqual(
        expect.objectContaining({ execution_status: "timed_out" }),
      );
    const human = await cli.run({
      arguments: ["mcp", "doctor", "--human", "--summary"],
    });
    expect(human.stdout).toContain("fresh REA stdio server");
    expect(human.stdout).toContain("does not inspect");
  },
  60_000,
);

cliTest(
  "local doctor preserves SIGINT status after awaited probe cleanup",
  async ({ cli }) => {
    if (process.platform === "win32") return;
    const home = await createTestTempDirectory("rea-doctor-interrupt-");
    const command = join(home, "which");
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.kill(process.ppid, "SIGINT"); setInterval(() => {}, 1000);\n`,
    );
    await chmod(command, 0o700);
    const result = await cli.run({
      arguments: ["doctor", "--skill=false", "--json"],
      environment: {
        HOME: home,
        USERPROFILE: home,
        PATH: `${home}:${process.env.PATH ?? ""}`,
      },
    });
    expect(result.exitCode).toBe(130);
    expect(result.json).toMatchObject({
      execution: { stop_reason: "cancelled", complete: false },
    });
  },
  30_000,
);
