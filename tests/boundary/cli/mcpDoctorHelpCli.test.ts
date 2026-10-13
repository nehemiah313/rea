import { describe, expect, it } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";
import { parseMcpDoctorArguments } from "../../../src/mcpDoctor.js";

const CLI_INTEGRATION_TIMEOUT_MS = 60_000;

describe("MCP doctor help boundary", () => {
  workspaceCliTest(
    "answers the advertised help option instead of validating it",
    async ({ cli }) => {
      const parent = await cli.run({ arguments: ["mcp", "--help"] });
      expect(parent.exitCode).toBe(0);
      expect(parent.stdout).toContain("doctor");
      for (const argument of ["--help", "-h"]) {
        const result = await cli.run({
          arguments: ["mcp", "doctor", argument],
        });
        expect(result).toMatchObject({ exitCode: 0 });
        expect(result.stdout).toContain("Usage: rea mcp doctor [options]");
        expect(result.stdout).toContain("--format <toon|json|yaml|md|jsonl>");
        expect(result.stdout).toContain("--full-output");
        expect(result.stdout).toContain("--summary");
        expect(result.stdout).toContain("--failures-only");
        expect(result.stdout).toContain("--human");
        expect(result.stdout).toContain("--deadline-ms <number>");
        // Help returns before the diagnostic session starts, so no report
        // envelope and no startup diagnostics are produced.
        expect(result.stdout).not.toContain("healthy");
        expect(result.stderr).toBe("");
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "answers help in option position regardless of surrounding output options",
    async ({ cli }) => {
      for (const arguments_ of [
        ["mcp", "doctor", "--json", "--help"],
        ["mcp", "doctor", "--format", "bogus", "--help"],
        ["mcp", "doctor", "--help", "--format", "json"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result).toMatchObject({ exitCode: 0 });
        expect(result.stdout).toContain("Usage: rea mcp doctor [options]");
        expect(result.stdout).toContain("--help, -h");
        expect(result.stdout).not.toContain("healthy");
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "treats help consumed as --format value as an invalid format, not help",
    async ({ cli }) => {
      for (const arguments_ of [
        ["mcp", "doctor", "--format", "--help"],
        ["mcp", "doctor", "--format", "-h"],
        ["mcp", "doctor", "--format=--help"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result).toMatchObject({ exitCode: 1 });
        expect(result.stdout).toContain("Invalid output format:");
        expect(result.stdout).not.toContain("Usage: rea mcp doctor");
      }
      for (const arguments_ of [
        ["mcp", "doctor", "--deadline-ms", "--help"],
        ["mcp", "doctor", "--deadline-ms", "-h"],
        ["mcp", "doctor", "--deadline-ms=--help"],
      ]) {
        const result = await cli.run({ arguments: arguments_ });
        expect(result).toMatchObject({ exitCode: 1 });
        expect(result.stdout).toContain("Invalid --deadline-ms value:");
        expect(result.stdout).not.toContain("Usage: rea mcp doctor");
      }
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );

  workspaceCliTest(
    "keeps the actionable error for a genuinely unknown option",
    async ({ cli }) => {
      const result = await cli.run({ arguments: ["mcp", "doctor", "--bogus"] });
      expect(result).toMatchObject({
        exitCode: 1,
        stdout:
          'code: VALIDATION_ERROR\nmessage: "Unknown mcp doctor option: --bogus"\n',
      });
      const invalid = await cli.run({
        arguments: ["mcp", "doctor", "--format", "bogus"],
      });
      expect(invalid).toMatchObject({
        exitCode: 1,
        stdout:
          'code: VALIDATION_ERROR\nmessage: "Invalid output format: bogus"\n',
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});

describe("MCP doctor canonical option parser", () => {
  it("preserves bare and explicit boolean values while rejecting invalid explicit booleans", () => {
    expect(parseMcpDoctorArguments(["--summary"])).toMatchObject({
      ok: true,
      summary: true,
      failuresOnly: false,
    });
    expect(
      parseMcpDoctorArguments([
        "--summary=false",
        "--failures-only=true",
        "--full-output=false",
      ]),
    ).toMatchObject({
      ok: true,
      summary: false,
      failuresOnly: true,
      fullOutput: false,
    });
    for (const argument of [
      "--summary=invalid",
      "--failures-only=1",
      "--human=",
      "--json=YES",
    ])
      expect(parseMcpDoctorArguments([argument])).toMatchObject({
        ok: false,
        message: expect.stringContaining("Invalid boolean value"),
      });
  });

  it("accepts only a positive integer deadline and keeps its value from help", () => {
    expect(parseMcpDoctorArguments(["--deadline-ms", "17"])).toMatchObject({
      ok: true,
      deadlineMs: 17,
    });
    for (const argument of ["0", "-1", "1.5", "NaN", ""])
      expect(
        parseMcpDoctorArguments(["--deadline-ms", argument]),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining("positive integer"),
      });
    expect(parseMcpDoctorArguments(["--deadline-ms", "--help"])).toMatchObject({
      ok: false,
      help: false,
      message: expect.any(String),
    });
    expect(parseMcpDoctorArguments(["--help", "--deadline-ms", "17"])).toEqual({
      ok: false,
      help: true,
    });
  });

  it("rejects human rendering with every explicit machine-output selector before diagnostic work", () => {
    for (const arguments_ of [
      ["--human", "--format", "toon"],
      ["--human", "--json=false"],
      ["--human", "--full-output=false"],
    ])
      expect(parseMcpDoctorArguments(arguments_)).toMatchObject({
        ok: false,
        message: expect.stringContaining("--human cannot be combined"),
      });
    expect(parseMcpDoctorArguments(["--human", "--summary"])).toMatchObject({
      ok: true,
      human: true,
      summary: true,
    });
  });
});
