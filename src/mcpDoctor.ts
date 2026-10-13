import { ChildProcess } from "node:child_process";
import { explicitBooleanArgumentError } from "./cli/explicitBooleanArguments.js";
import { withCommandCancellation } from "./cli/commandCancellation.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Formatter, Help, Parser, z } from "incur";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { CATALOG_IDENTITY } from "./catalogIdentity.js";
import type {
  McpDoctorCheck,
  McpDoctorIncomplete,
} from "./contracts/mcpDoctorReportSchemas.js";
import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { err, ok } from "./domain/result.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { MCP_STARTUP_POLICY } from "./mcpStartupPolicy.js";
import {
  envelopeMcpDoctorCompactReport,
  projectMcpDoctorReport,
  renderMcpDoctorHuman,
} from "./mcpDoctorReport.js";

export type { McpDoctorCheck } from "./contracts/mcpDoctorReportSchemas.js";

const OUTPUT_FORMATS = ["toon", "json", "yaml", "md", "jsonl"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * Canonical `rea mcp doctor` options. This schema is the single source of
 * truth for the Incur parser and help renderer. Keep both consumers aligned by
 * changing this schema, rather than duplicating option declarations.
 */
export const MCP_DOCTOR_OPTIONS = z.object({
  format: z.enum(OUTPUT_FORMATS).optional().describe("Output format"),
  json: z.boolean().default(false).describe("Emit the report as JSON"),
  fullOutput: z
    .boolean()
    .default(false)
    .describe("Show the full output envelope for compact views"),
  summary: z
    .boolean()
    .default(false)
    .describe("Return status and original check counts without diagnostics"),
  failuresOnly: z
    .boolean()
    .default(false)
    .describe(
      "Return only failed checks with original details and full counts",
    ),
  human: z
    .boolean()
    .default(false)
    .describe(
      "Render prose for a fresh REA stdio server, not an active client session",
    ),
  deadlineMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional()
    .describe("Positive absolute diagnostic deadline in milliseconds"),
  help: z.boolean().default(false).describe("Show help"),
});

const MCP_DOCTOR_ALIAS = { help: "h" } as const;

const MCP_DOCTOR_COMMAND = "rea mcp doctor";
const MCP_DOCTOR_DESCRIPTION =
  "Start a fresh REA MCP stdio server and validate startup, inventory, and target-free request flow";

/** Help flags derived from `MCP_DOCTOR_OPTIONS` plus its alias. */
const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--format",
  "--deadline-ms",
]);
const BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  "json",
  "fullOutput",
  "summary",
  "failuresOnly",
  "human",
  "help",
]);

/** Answer an advertised help request without starting a diagnostic session. */
const renderMcpDoctorHelp = (): string =>
  Help.formatCommand(MCP_DOCTOR_COMMAND, {
    description: MCP_DOCTOR_DESCRIPTION,
    hideGlobalOptions: true,
    options: MCP_DOCTOR_OPTIONS,
    alias: MCP_DOCTOR_ALIAS,
    hint: "This entry accepts only the options above.",
  });

export interface McpDoctorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface InventoryComparison {
  readonly expected: number;
  readonly observed: number;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
}

interface McpDoctorInventory {
  readonly tools: InventoryComparison | null;
  readonly prompts: InventoryComparison | null;
}

interface McpDoctorIdentity {
  readonly expected_package_version: string;
  readonly observed_package_version: string | null;
  readonly expected_catalog_digest: string;
  readonly observed_catalog_digest: string | null;
}

/** Raw, compatibility-preserving result from a production stdio diagnostic. */
export interface ProductionMcpDoctorResult {
  readonly healthy: boolean;
  readonly adapter: "production-stdio";
  readonly server: {
    readonly name: string | null;
    readonly version: string | null;
    readonly protocol_version: string | null;
  } | null;
  readonly inventory: McpDoctorInventory | null;
  readonly identity: McpDoctorIdentity | null;
  readonly request_flow: {
    readonly tool: "binary_session";
    readonly ok: boolean;
  };
  readonly checks: readonly McpDoctorCheck[];
  readonly incomplete?: McpDoctorIncomplete;
}

export type ProductionMcpDoctorRunResult = ProductionMcpDoctorResult & {
  readonly diagnostics: {
    readonly stderr: string;
    readonly stderr_bytes: number;
  };
};

/** Diagnose the actual production stdio adapter with one startup-bounded SDK session. */
export const runProductionMcpDoctor = async (
  options: McpDoctorOptions,
): Promise<ProductionMcpDoctorRunResult> => {
  if (
    options.deadlineMs !== undefined &&
    (!Number.isSafeInteger(options.deadlineMs) ||
      options.deadlineMs <= 0 ||
      options.deadlineMs > 2_147_483_647)
  )
    throw new RangeError(
      "MCP doctor deadline must be a positive timer-safe integer.",
    );
  const deadline =
    performance.now() +
    (options.deadlineMs ?? MCP_STARTUP_POLICY.doctorDeadlineMs);
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new Error("Production MCP doctor deadline expired")),
    Math.max(1, Math.ceil(deadline - performance.now())),
  );
  const stderr = captureStderr();
  const transport = new OwnedStdioClientTransport({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: targetFreeEnvironment(options.environment),
    stderr: "pipe",
  });
  transport.stderr?.on("data", stderr.append);
  const client = new Client({ name: "rea-mcp-doctor", version: "1" });
  let result: ProductionMcpDoctorResult;
  let cleanupFailure: { readonly cause: unknown } | undefined;
  try {
    await client.connect(
      transport,
      requestOptions(deadline, controller.signal),
    );
    result = await inspectProductionMcpSession(
      client,
      deadline,
      controller.signal,
    );
  } catch (cause: unknown) {
    result = connectionFailure(cause, controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    try {
      await client.close();
    } catch (cause: unknown) {
      cleanupFailure = { cause };
    }
    try {
      // An interrupted connect can clear the client's transport reference
      // before its startup child is closed. The transport retains that child.
      await transport.close();
    } catch (cause: unknown) {
      cleanupFailure = {
        cause:
          cleanupFailure === undefined || cleanupFailure.cause === cause
            ? cause
            : new AggregateError(
                [cleanupFailure.cause, cause],
                `MCP client and transport cleanup failed: ${errorMessage(cleanupFailure.cause)}; ${errorMessage(cause)}`,
              ),
      };
    }
  }
  if (cleanupFailure !== undefined)
    result = {
      ...result,
      healthy: false,
      checks: [
        ...result.checks,
        {
          name: "cleanup",
          ok: false,
          detail: `MCP stdio cleanup failed: ${errorMessage(cleanupFailure.cause)}`,
        },
      ],
    };
  return { ...result, diagnostics: stderr.value() };
};

/** Join SDK-triggered and caller-triggered close calls for the same child. */
class OwnedStdioClientTransport extends StdioClientTransport {
  #closePromise: Promise<void> | undefined;
  #child: ChildProcess | undefined;
  #exited: Promise<void> | undefined;

  override async start(): Promise<void> {
    const started = super.start();
    // The pinned SDK creates this child synchronously in start. Keep the actual
    // owned handle before SDK close clears it; never reacquire ownership by PID.
    const child: unknown = Reflect.get(this, "_process");
    if (child instanceof ChildProcess) {
      this.#child = child;
      this.#exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((resolve) => {
              child.once("exit", () => resolve());
              child.once("error", () => {
                if (child.pid === undefined) resolve();
              });
            });
    }
    await started;
    if (this.#child === undefined)
      throw new Error(
        "Pinned SDK did not expose its owned stdio child for verified cleanup.",
      );
  }

  override close(): Promise<void> {
    this.#closePromise ??= this.#closeOwnedChild();
    return this.#closePromise;
  }

  async #closeOwnedChild(): Promise<void> {
    await super.close();
    if (this.#exited === undefined) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "MCP owned child exit could not be confirmed after teardown",
                ),
              ),
            5_000,
          );
        }),
      ]);
      this.#child?.stdin?.destroy();
      this.#child?.stdout?.destroy();
      this.#child?.stderr?.destroy();
      this.#child = undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Inspect stages in dependency order. Concurrent inventory requests use
 * allSettled so a failed peer never abandons another request we own.
 */
const inspectProductionMcpSession = async (
  client: Client,
  deadline: number,
  signal: AbortSignal,
): Promise<ProductionMcpDoctorResult> => {
  const serverVersion = client.getServerVersion();
  const protocolVersion = client.getNegotiatedProtocolVersion();
  const checks: McpDoctorCheck[] = [
    initializeCheck(serverVersion, protocolVersion),
  ];
  const [toolsResult, promptsResult] = await Promise.allSettled([
    Promise.resolve().then(() =>
      client.listTools(undefined, requestOptions(deadline, signal)),
    ),
    Promise.resolve().then(() =>
      client.listPrompts(undefined, requestOptions(deadline, signal)),
    ),
  ]);
  const incompleteStages: string[] = [];
  const tools =
    toolsResult.status === "fulfilled" ? toolsResult.value : undefined;
  const prompts =
    promptsResult.status === "fulfilled" ? promptsResult.value : undefined;
  const toolsInventory =
    tools === undefined
      ? null
      : compareInventory(
          TOOL_CONTRACTS.map(({ name }) => name),
          tools.tools.map(({ name }) => name),
        );
  const promptsInventory =
    prompts === undefined
      ? null
      : compareInventory(
          PROMPT_CONTRACTS.map(({ name }) => name),
          prompts.prompts.map(({ name }) => name),
        );
  // Retain each successful inventory peer even if its sibling failed.
  const inventory = { tools: toolsInventory, prompts: promptsInventory };
  if (toolsInventory === null) {
    checks.push(stageFailureCheck("inventory:tools", toolsResult, signal));
    if (signal.aborted) incompleteStages.push("inventory:tools");
  } else checks.push(inventoryCheck("tools", toolsInventory));
  if (promptsInventory === null) {
    checks.push(stageFailureCheck("inventory:prompts", promptsResult, signal));
    if (signal.aborted) incompleteStages.push("inventory:prompts");
  } else checks.push(inventoryCheck("prompts", promptsInventory));

  if (tools === undefined) {
    incompleteStages.push("server-identity", "request-flow");
    checks.push(
      ...["server-identity", "request-flow"].map((name) => ({
        name,
        ok: false,
        execution_status: "not_examined" as const,
        detail: "Not examined because prior diagnosis did not complete.",
      })),
    );
    return buildInspectionResult({
      serverVersion,
      protocolVersion,
      inventory,
      identity: null,
      requestFlowOk: false,
      checks,
      incomplete: signal.aborted
        ? timeoutIncomplete(signal, incompleteStages)
        : {
            reason: "dependency_failed",
            not_examined: ["server-identity", "request-flow"],
          },
    });
  }

  const sessionTool = tools.tools.find(({ name }) => name === "binary_session");
  if (sessionTool === undefined) {
    checks.push({
      name: "request-flow",
      ok: false,
      detail: "binary_session is missing from discovered tool inventory",
    });
    checks.push({
      name: "server-identity",
      ok: false,
      execution_status: "not_examined",
      detail: "Identity tool absent from discovered inventory.",
    });
    return buildInspectionResult({
      serverVersion,
      protocolVersion,
      inventory,
      identity: null,
      requestFlowOk: false,
      checks,
      incomplete: {
        reason: "dependency_failed",
        not_examined: ["server-identity"],
      },
    });
  }

  const requestFlow = await Promise.resolve()
    .then(() =>
      client.callTool(
        { name: "binary_session", arguments: {} },
        {
          ...requestOptions(deadline, signal),
          toolDefinition: sessionTool,
        },
      ),
    )
    .then(ok, (cause: unknown) =>
      err({
        kind: "request-flow" as const,
        detail: stageFailureDetail(cause, signal),
      }),
    );
  if (!requestFlow.ok && signal.aborted)
    incompleteStages.push("server-identity", "request-flow");
  const observedIdentity = parseIdentityToolResult(
    requestFlow.ok ? requestFlow.value.structuredContent : undefined,
  );
  checks.push({
    name: "server-identity",
    ...(!requestFlow.ok && signal.aborted
      ? { execution_status: "not_examined" as const }
      : {}),
    ok:
      observedIdentity.packageVersion === PRODUCT_IDENTITY.packageVersion &&
      observedIdentity.catalogDigest ===
        CATALOG_IDENTITY.digests.combined_sha256,
    detail:
      !requestFlow.ok && signal.aborted
        ? "Server identity not examined after interruption."
        : `package=${observedIdentity.packageVersion ?? "missing"}; catalog=${observedIdentity.catalogDigest ?? "missing"}`,
  });
  checks.push({
    name: "request-flow",
    ...(!requestFlow.ok && signal.aborted
      ? { execution_status: interruptionStatus(signal) }
      : {}),
    ok: requestFlow.ok && requestFlow.value.isError !== true,
    detail: requestFlow.ok
      ? "binary_session target-free request"
      : requestFlow.error.detail,
  });
  return buildInspectionResult({
    serverVersion,
    protocolVersion,
    inventory,
    identity: {
      expected_package_version: PRODUCT_IDENTITY.packageVersion,
      observed_package_version: observedIdentity.packageVersion,
      expected_catalog_digest: CATALOG_IDENTITY.digests.combined_sha256,
      observed_catalog_digest: observedIdentity.catalogDigest,
    },
    requestFlowOk: requestFlow.ok && requestFlow.value.isError !== true,
    checks,
    incomplete: timeoutIncomplete(signal, incompleteStages),
  });
};

const buildInspectionResult = (input: {
  readonly serverVersion:
    | { readonly name?: string; readonly version?: string }
    | undefined;
  readonly protocolVersion: string | undefined;
  readonly inventory: McpDoctorInventory | null;
  readonly identity: McpDoctorIdentity | null;
  readonly requestFlowOk: boolean;
  readonly checks: readonly McpDoctorCheck[];
  readonly incomplete: McpDoctorIncomplete | undefined;
}): ProductionMcpDoctorResult => ({
  healthy: input.checks.every(({ ok }) => ok),
  adapter: "production-stdio",
  server: {
    name: input.serverVersion?.name ?? null,
    version: input.serverVersion?.version ?? null,
    protocol_version: input.protocolVersion ?? null,
  },
  inventory: input.inventory,
  identity: input.identity,
  request_flow: { tool: "binary_session", ok: input.requestFlowOk },
  checks: input.checks,
  ...(input.incomplete === undefined ? {} : { incomplete: input.incomplete }),
});

const connectionFailure = (
  cause: unknown,
  signal: AbortSignal,
): ProductionMcpDoctorResult => {
  const incomplete = timeoutIncomplete(signal, [
    "initialize",
    "inventory:tools",
    "inventory:prompts",
    "server-identity",
    "request-flow",
  ]);
  return {
    healthy: false,
    adapter: "production-stdio",
    server: null,
    inventory: null,
    identity: null,
    request_flow: { tool: "binary_session", ok: false },
    checks: [
      {
        name: "transport",
        ok: false,
        ...(signal.aborted
          ? { execution_status: interruptionStatus(signal) }
          : {}),
        detail: stageFailureDetail(cause, signal),
      },
      ...(incomplete === undefined
        ? []
        : incomplete.not_examined.map((name) => ({
            name,
            ok: false,
            execution_status: "not_examined" as const,
            detail: "Not examined because prior diagnosis did not complete.",
          }))),
    ],
    ...(incomplete === undefined ? {} : { incomplete }),
  };
};

const initializeCheck = (
  serverVersion:
    | { readonly name?: string; readonly version?: string }
    | undefined,
  protocolVersion: string | undefined,
): McpDoctorCheck => ({
  name: "initialize",
  ok:
    serverVersion?.name === PRODUCT_IDENTITY.mcpServerKey &&
    serverVersion.version === PRODUCT_IDENTITY.packageVersion &&
    protocolVersion !== undefined,
  detail: `${serverVersion?.name ?? "unknown"}@${serverVersion?.version ?? "unknown"}; protocol=${protocolVersion ?? "unknown"}`,
});

const stageFailureCheck = (
  name: string,
  result: PromiseSettledResult<unknown>,
  signal: AbortSignal,
): McpDoctorCheck => ({
  name,
  ok: false,
  ...(signal.aborted ? { execution_status: interruptionStatus(signal) } : {}),
  detail:
    result.status === "rejected"
      ? stageFailureDetail(result.reason, signal)
      : "MCP doctor stage did not produce a result",
});

const interruptionStatus = (signal: AbortSignal): "timed_out" | "cancelled" =>
  signal.reason instanceof Error &&
  signal.reason.message === "Production MCP doctor deadline expired"
    ? "timed_out"
    : "cancelled";

const stageFailureDetail = (cause: unknown, signal: AbortSignal): string =>
  signal.aborted
    ? `MCP doctor ${interruptionStatus(signal)}: ${errorMessage(cause)}`
    : errorMessage(cause);

const timeoutIncomplete = (
  signal: AbortSignal,
  stages: readonly string[],
): McpDoctorIncomplete | undefined => {
  if (!signal.aborted) return undefined;
  const not_examined = [...new Set(stages)];
  return {
    reason:
      interruptionStatus(signal) === "timed_out" ? "timeout" : "cancelled",
    not_examined:
      not_examined.length === 0
        ? ["remaining MCP diagnostic stages"]
        : not_examined,
  };
};

/**
 * Dispatcher entry for `rea mcp doctor`, kept separate from Incur MCP setup.
 * @public
 */
export const runProductionMcpDoctorCli = async (
  arguments_: readonly string[],
  input: { readonly dispatcherPath: string; readonly packageRoot: string },
): Promise<{ readonly output: string; readonly exitCode: number }> => {
  const parsed = parseMcpDoctorArguments(arguments_);
  if (!parsed.ok) {
    if (parsed.help)
      return { output: `${renderMcpDoctorHelp()}\n`, exitCode: 0 };
    return {
      output: `${Formatter.format(
        { code: "VALIDATION_ERROR", message: parsed.message },
        parsed.format,
      )}\n`,
      exitCode: 1,
    };
  }
  const result = await withCommandCancellation((signal) =>
    runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve(input.dispatcherPath), "mcp"],
      cwd: input.packageRoot,
      environment: process.env,
      signal,
      ...(parsed.deadlineMs === undefined
        ? {}
        : { deadlineMs: parsed.deadlineMs }),
    }),
  );
  const compact =
    parsed.summary || parsed.failuresOnly
      ? projectMcpDoctorReport(result, parsed)
      : undefined;
  if (parsed.human)
    return {
      output: `${renderMcpDoctorHuman(result, compact)}\n`,
      exitCode:
        typeof process.exitCode === "number" &&
        (process.exitCode === 130 || process.exitCode === 143)
          ? process.exitCode
          : result.healthy
            ? 0
            : 1,
    };
  const output =
    compact === undefined
      ? result
      : parsed.fullOutput
        ? envelopeMcpDoctorCompactReport(compact)
        : compact;
  return {
    output: `${Formatter.format(output, parsed.format)}\n`,
    exitCode:
      typeof process.exitCode === "number" &&
      (process.exitCode === 130 || process.exitCode === 143)
        ? process.exitCode
        : result.healthy
          ? 0
          : 1,
  };
};

/** Compare exact names while retaining actionable mismatch locations. */
export const compareInventory = (
  expectedNames: readonly string[],
  observedNames: readonly string[],
): InventoryComparison => {
  const expected = new Set(expectedNames);
  const observed = new Set(observedNames);
  return {
    expected: expectedNames.length,
    observed: observedNames.length,
    missing: [...expected].filter((name) => !observed.has(name)).sort(),
    unexpected: [...observed].filter((name) => !expected.has(name)).sort(),
    duplicates: [...observed]
      .filter(
        (name) =>
          observedNames.filter((candidate) => candidate === name).length > 1,
      )
      .sort(),
  };
};

const inventoryCheck = (
  name: string,
  comparison: InventoryComparison,
): McpDoctorCheck => ({
  name: `inventory:${name}`,
  ok:
    comparison.expected === comparison.observed &&
    comparison.missing.length === 0 &&
    comparison.unexpected.length === 0 &&
    comparison.duplicates.length === 0,
  detail: `expected=${String(comparison.expected)} observed=${String(comparison.observed)} missing=${comparison.missing.join(",") || "none"} unexpected=${comparison.unexpected.join(",") || "none"} duplicates=${comparison.duplicates.join(",") || "none"}`,
});

const parseIdentityToolResult = (
  input: unknown,
): {
  readonly packageVersion: string | null;
  readonly catalogDigest: string | null;
} => {
  if (!isRecord(input) || !isRecord(input.result))
    return { packageVersion: null, catalogDigest: null };
  const identity = input.result.server_identity;
  if (!isRecord(identity)) return { packageVersion: null, catalogDigest: null };
  const packageIdentity = identity.package;
  const catalog = identity.catalog;
  const digests = isRecord(catalog) ? catalog.digests : undefined;
  return {
    packageVersion:
      isRecord(packageIdentity) && typeof packageIdentity.version === "string"
        ? packageIdentity.version
        : null,
    catalogDigest:
      isRecord(digests) && typeof digests.combined_sha256 === "string"
        ? digests.combined_sha256
        : null,
  };
};

/** Parsed `rea mcp doctor` arguments, including a help request. */
export type McpDoctorArguments =
  | {
      readonly ok: true;
      readonly format: OutputFormat;
      readonly fullOutput: boolean;
      readonly summary: boolean;
      readonly failuresOnly: boolean;
      readonly human: boolean;
      readonly deadlineMs: number | undefined;
    }
  | { readonly ok: false; readonly help: true }
  | {
      readonly ok: false;
      readonly help: false;
      readonly format: OutputFormat;
      readonly message: string;
    };

/** Parse the single canonical option schema while retaining legacy error text. */
export const parseMcpDoctorArguments = (
  arguments_: readonly string[],
): McpDoctorArguments => {
  // Help wins over validation errors, except when a valued option owns the
  // apparent help token. This preserves the documented `--format --help`
  // behavior and applies it equally to `--deadline-ms --help`.
  if (hasHelpInOptionPosition(arguments_)) return { ok: false, help: true };
  const format = outputFormatBeforeFailure(arguments_);
  const invalidBoolean = explicitBooleanArgumentError(
    arguments_,
    BOOLEAN_OPTIONS,
    VALUE_OPTIONS,
  );
  if (invalidBoolean !== undefined)
    return { ok: false, help: false, format, message: invalidBoolean };
  try {
    const parsed = Parser.parse([...arguments_], {
      args: z.object({ positionals: z.array(z.string()).optional() }),
      options: MCP_DOCTOR_OPTIONS,
      alias: MCP_DOCTOR_ALIAS,
    });
    if ((parsed.args.positionals?.length ?? 0) > 0)
      return {
        ok: false,
        help: false,
        format,
        message: `Unknown mcp doctor option: ${parsed.args.positionals?.[0] ?? "missing"}`,
      };
    const options = parsed.options;
    if (options.help) return { ok: false, help: true };
    const effectiveFormat = effectiveOutputFormat(arguments_, options.format);
    if (
      options.human &&
      (hasExplicitOption(arguments_, "format", false) ||
        hasExplicitOption(arguments_, "json", true) ||
        hasExplicitOption(arguments_, "fullOutput", true))
    )
      return {
        ok: false,
        help: false,
        format: effectiveFormat,
        message:
          "--human cannot be combined with an explicit --format, --json, or --full-output option",
      };
    return {
      ok: true,
      format: effectiveFormat,
      fullOutput: options.fullOutput,
      summary: options.summary,
      failuresOnly: options.failuresOnly,
      human: options.human,
      deadlineMs: options.deadlineMs,
    };
  } catch (cause: unknown) {
    const invalidFormat = invalidOutputFormat(arguments_);
    if (invalidFormat !== undefined)
      return {
        ok: false,
        help: false,
        format,
        message: `Invalid output format: ${invalidFormat}`,
      };
    const invalidDeadline = invalidDeadlineMs(arguments_);
    if (invalidDeadline !== undefined)
      return {
        ok: false,
        help: false,
        format,
        message: `Invalid --deadline-ms value: ${invalidDeadline}; expected a positive integer`,
      };
    const unknown = unknownOptionFromParserError(cause);
    return {
      ok: false,
      help: false,
      format,
      message:
        unknown === undefined
          ? errorMessage(cause)
          : `Unknown mcp doctor option: ${unknown}`,
    };
  }
};

/**
 * Report whether help appears in option position. Values owned by `--format`
 * and `--deadline-ms` are skipped so a malformed valued option remains an
 * actionable validation error instead of silently becoming a help request.
 */
const hasHelpInOptionPosition = (arguments_: readonly string[]): boolean => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (VALUE_OPTIONS.has(argument ?? "")) {
      index += 1;
      continue;
    }
    if (HELP_FLAGS.has(argument ?? "")) return true;
  }
  return false;
};

const normalizedOptionName = (raw: string): string | undefined => {
  const name = raw.startsWith("no-") ? raw.slice(3) : raw;
  const camel = name.replace(/-([a-z])/gu, (_, character: string) =>
    character.toUpperCase(),
  );
  return [
    "format",
    "json",
    "fullOutput",
    "summary",
    "failuresOnly",
    "human",
    "deadlineMs",
    "help",
  ].includes(camel)
    ? camel
    : undefined;
};

const hasExplicitOption = (
  arguments_: readonly string[],
  option: string,
  allowNegation: boolean,
): boolean =>
  arguments_.some((argument) => {
    const raw = argument?.startsWith("--")
      ? argument.slice(2).split("=", 1)[0]
      : undefined;
    if (raw === undefined) return false;
    if (!allowNegation && raw.startsWith("no-")) return false;
    return normalizedOptionName(raw) === option;
  });

const outputFormatBeforeFailure = (
  arguments_: readonly string[],
): OutputFormat => {
  let format: OutputFormat = "toon";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json" || argument === "--json=true") format = "json";
    const inline = argument?.startsWith("--format=")
      ? argument.slice("--format=".length)
      : undefined;
    if (argument === "--format" || inline !== undefined) {
      const candidate = inline ?? arguments_[index + 1];
      if (inline === undefined) index += 1;
      if (!isOutputFormat(candidate)) return format;
      format = candidate;
    }
  }
  return format;
};

const effectiveOutputFormat = (
  arguments_: readonly string[],
  parsedFormat: OutputFormat | undefined,
): OutputFormat =>
  arguments_.some(
    (arg) =>
      arg === "--json" ||
      arg === "--json=true" ||
      arg === "--format" ||
      arg.startsWith("--format="),
  )
    ? outputFormatBeforeFailure(arguments_)
    : (parsedFormat ?? "toon");

const invalidOutputFormat = (
  arguments_: readonly string[],
): string | undefined => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const inline = argument?.startsWith("--format=")
      ? argument.slice("--format=".length)
      : undefined;
    if (argument !== "--format" && inline === undefined) continue;
    const candidate = inline ?? arguments_[index + 1];
    if (inline === undefined) index += 1;
    if (!isOutputFormat(candidate)) return candidate ?? "missing";
  }
  return undefined;
};

const invalidDeadlineMs = (
  arguments_: readonly string[],
): string | undefined => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const inline = argument?.startsWith("--deadline-ms=")
      ? argument.slice("--deadline-ms=".length)
      : undefined;
    if (argument !== "--deadline-ms" && inline === undefined) continue;
    const candidate = inline ?? arguments_[index + 1];
    if (inline === undefined) index += 1;
    const numeric = candidate === undefined ? Number.NaN : Number(candidate);
    if (
      candidate === undefined ||
      candidate.trim() === "" ||
      !Number.isSafeInteger(numeric) ||
      numeric <= 0 ||
      numeric > 2_147_483_647
    )
      return candidate ?? "missing";
  }
  return undefined;
};

const unknownOptionFromParserError = (cause: unknown): string | undefined => {
  const match = /^Unknown flag: (.+)$/u.exec(errorMessage(cause));
  return match?.[1];
};

const isOutputFormat = (value: string | undefined): value is OutputFormat =>
  OUTPUT_FORMATS.some((candidate) => candidate === value);

const requestOptions = (deadline: number, signal: AbortSignal) => ({
  signal,
  timeout: Math.max(1, Math.ceil(deadline - performance.now())),
});

const targetFreeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of [
    "HOPPER_TARGET_PATH",
    "HOPPER_TARGET_KIND",
    "HOPPER_LOADER_ARGS_JSON",
  ])
    delete result[name];
  return result;
};

const captureStderr = () => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    append(chunk: unknown) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      bytes += buffer.byteLength;
      chunks.push(Buffer.from(buffer));
    },
    value: () => ({
      stderr: Buffer.concat(chunks, bytes).toString("utf8"),
      stderr_bytes: bytes,
    }),
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
