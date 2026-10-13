import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import type { DoctorReport } from "../../../src/application/Doctor.js";
import type {
  DoctorFailureReport,
  DoctorReportSummary,
} from "../../../src/application/DoctorReportView.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "doctor report views preserve scoped exit status and never rewrite registrations",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-doctor-views-");
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
    const run = (
      options: readonly string[],
      clients: readonly string[] = ["opencode"],
    ) =>
      cli.run({
        arguments: [
          "doctor",
          ...clients.flatMap((client) => ["--client", client]),
          ...options,
          "--json",
        ],
        cwd: home,
        environment: { HOME: home, USERPROFILE: home },
      });

    const result = await run([]);
    expect(result.exitCode, result.stdout).toBe(0);
    const report = result.json as DoctorReport;
    expect(report).not.toHaveProperty("report_view");
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:opencode", ok: true }),
    );

    const compact = await run(["--summary"]);
    expect(compact.exitCode).toBe(result.exitCode);
    const compactReport = compact.json as DoctorReportSummary;
    expect(compactReport).toMatchObject({
      report_view: "summary",
      healthy: report.healthy,
      environment_healthy: report.environment_healthy,
      scope: report.scope,
      check_counts: { scope: { total: report.scope_checks.length, failed: 0 } },
    });
    expect(compactReport).not.toHaveProperty("identity");
    expect(compactReport).not.toHaveProperty("scope_checks");

    const filtered = await run(["--failures-only"]);
    expect(filtered.exitCode).toBe(result.exitCode);
    const filteredReport = filtered.json as DoctorFailureReport;
    expect(filteredReport).toEqual({
      ...compactReport,
      report_view: "failures-only",
      scope_checks: [],
      informational_checks: report.informational_checks.filter(({ ok }) => !ok),
    });
    expect((await run(["--summary", "--failures-only"])).json).toEqual(
      filteredReport,
    );
    expect(
      (await run(["--summary=false", "--failures-only=false"])).json,
    ).toEqual(report);

    const missing = await run([], ["codex", "opencode"]);
    expect(missing.exitCode).toBe(1);
    const missingReport = missing.json as DoctorReport;
    const missingFiltered = await run(
      ["--failures-only"],
      ["codex", "opencode"],
    );
    expect(missingFiltered.exitCode).toBe(1);
    expect(missingFiltered.json).toMatchObject({
      healthy: false,
      scope_checks: missingReport.scope_checks.filter(({ ok }) => !ok),
      check_counts: {
        scope: { total: missingReport.scope_checks.length, failed: 1 },
      },
    });
    expect((await run(["--summary"], ["codex", "opencode"])).exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe(registration);
    expect(await readdir(directory)).toEqual(["opencode.json"]);
  },
);

cliTest(
  "doctor help advertises compact views without running diagnosis",
  async ({ cli }) => {
    const result = await cli.run({ arguments: ["doctor", "--help"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--summary");
    expect(result.stdout).toContain("--failures-only");
  },
);
