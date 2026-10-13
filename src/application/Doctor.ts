import { constants } from "node:fs";
import {
  DoctorExecution,
  type DoctorExecutionOptions,
  type DoctorExecutionReport,
} from "./DoctorExecution.js";
import { access, readdir, stat } from "node:fs/promises";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { join } from "node:path";

import { analysisErrorRemediationAction } from "../domain/analysisErrorPresentation.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { parseBinaryTarget } from "./BinaryTargetResolver.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "../domain/runtimeVersion.js";
import { installedCaskAppdir, probeHomebrew } from "./homebrew.js";
import {
  linuxHopperBinarySupported,
  linuxSharedLibrariesAvailable,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import {
  readInstalledSkillIdentity,
  type InstalledSkillIdentity,
} from "./SetupSkill.js";
import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../identity.js";
import {
  readClientRegistrationStatuses,
  type ClientRegistrationStatus,
  type UnhealthyClientRegistrationStatus,
} from "./ClientRegistrationStatus.js";
import {
  collectDoctorDiagnostics,
  doctorHealthy,
  doctorBlockingChecks,
} from "./DoctorDiagnostics.js";
import {
  normalizeDoctorScope,
  scopeDoctorChecks,
  type DoctorScopeReport,
} from "./DoctorScope.js";

/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly classification:
    | "healthy"
    | "missing_dependency"
    | "unsupported_host"
    | "unsupported_target"
    | "missing_analysis_engine"
    | "config_drift"
    | "diagnostic_incomplete";
  readonly execution_status?:
    | "completed"
    | "timed_out"
    | "cancelled"
    | "not_examined";
  readonly detail?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly remediation?: string;
}

/** One provider-owned check projected without importing its adapter types. */
export interface DoctorProviderCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
}

/** Read-only provider inspection supplied by an outer composition adapter. */
export interface DoctorProviderInspection {
  readonly id: string;
  readonly configured: boolean;
  readonly available: boolean;
  readonly providerVersion: string | null;
  /** Adapter-validated non-secret settings, independent of runtime readiness.
   * Invalid installations publish no settings. */
  readonly registrationEnvironment: Readonly<Record<string, string>>;
  readonly checks: readonly DoctorProviderCheck[];
}
/** Read-only host capabilities required by diagnostics. */
export interface DoctorHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly runtime: JavaScriptRuntime;
  readonly homeDirectory: string;
  readonly configuredHopperPath?: string;
  readonly configuredIlspyCmdPath?: string;
  macosVersion(signal?: AbortSignal): Promise<string | undefined>;
  linuxDistribution(
    signal?: AbortSignal,
  ): Promise<LinuxDistribution | undefined>;
  validTarget(path: string, signal?: AbortSignal): Promise<boolean>;
  /** Route-specific target admission details, when supplied by the host. */
  inspectTarget?(path: string, signal?: AbortSignal): Promise<DoctorCheck>;
  executable(path: string, signal?: AbortSignal): Promise<boolean>;
  supportedLinuxHopper(path: string, signal?: AbortSignal): Promise<boolean>;
  linuxDemoRuntimeCheck(signal?: AbortSignal): Promise<DoctorCheck>;
  brewHopperPath(signal?: AbortSignal): Promise<string | undefined>;
  manualHopperPaths(signal?: AbortSignal): Promise<readonly string[]>;
  providerInspections?(
    signal?: AbortSignal,
  ): Promise<readonly DoctorProviderInspection[]>;
  installationPaths?(signal?: AbortSignal): Promise<readonly string[]>;
  installedSkillIdentity?(
    clientIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<InstalledSkillIdentity | undefined>;
  close?(): Promise<string | undefined>;
  clientRegistrations?(
    signal?: AbortSignal,
  ): Promise<readonly ClientRegistrationStatus[]>;
  ilspyCmdVersion?(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

/** Structured result returned by the read-only doctor workflow. */
export interface DoctorReport {
  readonly healthy: boolean;
  readonly environment_healthy: boolean;
  readonly scope: DoctorScopeReport;
  readonly scope_checks: readonly DoctorCheck[];
  readonly informational_checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
  readonly checks: readonly DoctorCheck[];
  readonly identity?: DoctorIdentity;
  readonly execution?: DoctorExecutionReport;
}

/** Caller-selected readiness boundary; omitted values retain audit semantics. */
export interface DoctorScope {
  readonly clients?: readonly string[];
  readonly skillClients?: readonly string[];
  readonly providers?: readonly string[];
  readonly skill?: boolean;
}

/** Installed-package, skill, client, and runtime identity observations. */
interface DoctorIdentity {
  readonly cli_package_version: string;
  readonly expected_skill_version: string;
  readonly sdk: typeof SDK_IDENTITY;
  readonly catalog: typeof CATALOG_IDENTITY;
  readonly live_server: {
    readonly state: "unknown";
    readonly remediation: string;
  };
  readonly installations: {
    readonly paths: readonly string[];
    readonly state: "single" | "multiple" | "unknown";
  };
  readonly skill: {
    readonly installed_version: string | null;
    readonly installed_tool_count: number | null;
    readonly state: "aligned" | "stale" | "missing" | "unknown";
    readonly remediation: string | null;
  };
  readonly registrations: readonly ClientRegistrationStatus[];
  readonly observations?: {
    readonly registrations: "completed" | "incomplete";
    readonly skill: "completed" | "incomplete";
    readonly installations: "completed" | "incomplete";
  };
}

/**
 * Check requirements and an optional target without mutating the host.
 * Every failed check includes remediation suitable for either the one-shot CLI
 * or an agent consuming the structured result.
 */
export const runDoctor = async (
  target?: string,
  selectedHost?: DoctorHost,
  requestedScope?: DoctorScope,
  executionOptions?: DoctorExecutionOptions,
): Promise<DoctorReport> =>
  selectedHost === undefined
    ? runDoctorOwned(
        target,
        systemDoctorHost(),
        requestedScope,
        executionOptions,
      )
    : inspectDoctorWithExecution(
        target,
        selectedHost,
        requestedScope,
        executionOptions,
      );

/** Inspect with a host whose lifetime belongs to this operation. */
export const runDoctorOwned = async (
  target: string | undefined,
  host: DoctorHost,
  requestedScope?: DoctorScope,
  executionOptions?: DoctorExecutionOptions,
): Promise<DoctorReport> => {
  let report: DoctorReport;
  try {
    report = await inspectDoctorWithExecution(
      target,
      host,
      requestedScope,
      executionOptions,
    );
  } catch (cause: unknown) {
    const cleanup = await closeDoctorHost(host);
    if (cleanup !== undefined)
      throw new AggregateError(
        [cause, new Error(cleanup)],
        "Doctor failed and its resource cleanup remains incomplete.",
        { cause },
      );
    throw cause;
  }
  const cleanup = await closeDoctorHost(host);
  return cleanup === undefined
    ? report
    : doctorReportWithCleanup(report, cleanup);
};

const inspectDoctorWithExecution = async (
  target: string | undefined,
  host: DoctorHost,
  requestedScope: DoctorScope | undefined,
  options: DoctorExecutionOptions | undefined,
): Promise<DoctorReport> => {
  const execution =
    options === undefined ? undefined : new DoctorExecution(options);
  try {
    return await inspectDoctor(target, host, requestedScope, execution);
  } finally {
    execution?.close();
  }
};

export interface DoctorReadiness {
  readonly blockerChecks: readonly DoctorCheck[];
  readonly optionalChecks: readonly DoctorCheck[];
}
const reportReadiness = new WeakMap<DoctorReport, DoctorReadiness>();
/** Aggregation-owned applicability without changing the legacy serialized report. */
export const getDoctorReadiness = (report: DoctorReport): DoctorReadiness =>
  reportReadiness.get(report) ?? {
    blockerChecks: report.healthy
      ? []
      : report.scope_checks.filter(({ ok }) => !ok),
    optionalChecks: report.healthy
      ? report.checks.filter(({ ok }) => !ok)
      : report.informational_checks.filter(({ ok }) => !ok),
  };

const inspectDoctor = async (
  target: string | undefined,
  host: DoctorHost,
  requestedScope?: DoctorScope,
  execution?: DoctorExecution,
): Promise<DoctorReport> => {
  const scope = normalizeDoctorScope(requestedScope, target);
  const earlyIdentity =
    execution?.bounded !== true
      ? undefined
      : await collectDoctorIdentity(host, scope, execution);
  const {
    checks: diagnosticChecks,
    hopperPath,
    providerInspections,
  } = await collectDoctorDiagnostics(target, host, execution);
  const identity =
    earlyIdentity ?? (await collectDoctorIdentity(host, scope, execution));
  const checks = [...diagnosticChecks, ...identity.checks];
  const providers = {
    hopperAvailable:
      hopperPath !== undefined &&
      checks
        .filter(({ name }) => name.startsWith("hopper"))
        .every(({ ok }) => ok),
    hopperConfigured: host.configuredHopperPath !== undefined,
    providerInspections,
  };
  const environmentHealthy = doctorHealthy(checks, providers);
  const scoped = scopeDoctorChecks({
    checks,
    registrations: identity.registrations,
    skillState: identity.skillState,
    providers,
    scope,
  });
  const report: DoctorReport = {
    healthy: scope.mode === "audit-wide" ? environmentHealthy : scoped.healthy,
    environment_healthy: environmentHealthy,
    scope,
    scope_checks: scope.mode === "audit-wide" ? checks : scoped.scopeChecks,
    informational_checks:
      scope.mode === "audit-wide" ? [] : scoped.informationalChecks,
    ...(hopperPath === undefined ? {} : { hopperPath }),
    ...(providerInspections === undefined ? {} : { providerInspections }),
    checks,
    ...(identity.value === undefined ? {} : { identity: identity.value }),
    ...(execution === undefined ||
    (execution.report().complete && execution.report().deadline_ms === null)
      ? {}
      : { execution: execution.report() }),
  };
  const blockers =
    scope.mode === "explicit"
      ? report.scope_checks.filter(({ ok }) => !ok)
      : doctorBlockingChecks(checks, providers);
  reportReadiness.set(report, {
    blockerChecks: blockers,
    optionalChecks: checks.filter(
      (candidate) => !candidate.ok && !blockers.includes(candidate),
    ),
  });
  return report;
};

const closeDoctorHost = async (
  host: DoctorHost,
): Promise<string | undefined> => {
  try {
    return await host.close?.();
  } catch (cause: unknown) {
    return `Doctor host cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
};

const doctorReportWithCleanup = (
  report: DoctorReport,
  detail: string,
): DoctorReport => {
  const check: DoctorCheck = {
    name: "doctor-resource-cleanup",
    ok: false,
    classification: "config_drift",
    detail,
    remediation: "Resolve the reported cleanup failure, then rerun rea doctor.",
  };
  const updated: DoctorReport = {
    ...report,
    healthy: false,
    environment_healthy: false,
    checks: [...report.checks, check],
    scope_checks: [...report.scope_checks, check],
  };
  reportReadiness.set(updated, {
    ...getDoctorReadiness(report),
    blockerChecks: [...getDoctorReadiness(report).blockerChecks, check],
  });
  return updated;
};

const collectDoctorIdentity = async (
  host: DoctorHost,
  scope: DoctorScopeReport,
  execution?: DoctorExecution,
): Promise<{
  readonly checks: readonly DoctorCheck[];
  readonly value: DoctorIdentity;
  readonly registrations: readonly ClientRegistrationStatus[];
  readonly skillState: "aligned" | "missing" | "stale";
}> => {
  const incomplete: DoctorCheck[] = [];
  const probe = async <Value>(
    name: string,
    operation: () => Promise<Value>,
  ): Promise<Value | undefined> => {
    if (execution === undefined) return operation();
    const result = await execution.probe(name, operation);
    if (result.ok) return result.value;
    incomplete.push(result.check);
    return undefined;
  };
  // Establish selected registrations before optional installation-path discovery.
  const registrationResult = await probe(
    "registration:inspection",
    () => host.clientRegistrations?.(execution?.signal) ?? Promise.resolve([]),
  );
  const registrations = registrationResult ?? [];
  if (registrationResult === undefined)
    incomplete.push(
      ...scope.clients.map((client) => ({
        ...incomplete[incomplete.length - 1]!,
        name: `registration:${client}`,
      })),
    );
  const skillClientIds =
    scope.skill_clients ??
    (scope.mode === "audit-wide"
      ? registrations.map(({ client }) => client)
      : scope.clients);
  const installedSkillIdentity = await probe(
    "skill:identity",
    () =>
      host.installedSkillIdentity?.(skillClientIds, execution?.signal) ??
      Promise.resolve(undefined),
  );
  const skillInspected = !incomplete.some(
    ({ name }) => name === "skill:identity",
  );
  const installationPaths =
    (await probe(
      "installation:paths",
      () => host.installationPaths?.(execution?.signal) ?? Promise.resolve([]),
    )) ?? [];
  const skillAligned = skillIdentityAligned(installedSkillIdentity);
  return {
    registrations,
    skillState:
      installedSkillIdentity === undefined
        ? "missing"
        : skillAligned
          ? "aligned"
          : "stale",
    checks: [
      ...incomplete,
      ...(skillAligned || !skillInspected
        ? []
        : [skillIdentityCheck(installedSkillIdentity)]),
      ...registrations
        .filter(
          (registration): registration is UnhealthyClientRegistrationStatus =>
            registration.state !== "aligned" && registration.state !== "manual",
        )
        .map(registrationCheck),
    ],
    value: {
      cli_package_version: PRODUCT_IDENTITY.packageVersion,
      expected_skill_version: PRODUCT_IDENTITY.skillVersion,
      sdk: SDK_IDENTITY,
      catalog: CATALOG_IDENTITY,
      live_server: {
        state: "unknown",
        remediation:
          "Call binary_session in the active client to inspect the running server identity.",
      },
      installations: {
        paths: installationPaths,
        state: incomplete.some(({ name }) => name === "installation:paths")
          ? "unknown"
          : installationState(installationPaths),
      },
      skill: {
        installed_version: installedSkillIdentity?.version ?? null,
        installed_tool_count: installedSkillIdentity?.toolCount ?? null,
        state: !skillInspected
          ? "unknown"
          : installedSkillIdentity === undefined
            ? "missing"
            : skillAligned
              ? "aligned"
              : "stale",
        remediation: !skillInspected
          ? "Rerun diagnosis to establish skill identity."
          : skillAligned
            ? null
            : "Run rea setup to update the installed REA skill.",
      },
      registrations,
      ...(incomplete.length === 0
        ? {}
        : {
            observations: {
              registrations:
                registrationResult === undefined
                  ? ("incomplete" as const)
                  : ("completed" as const),
              skill: skillInspected
                ? ("completed" as const)
                : ("incomplete" as const),
              installations: incomplete.some(
                ({ name }) => name === "installation:paths",
              )
                ? ("incomplete" as const)
                : ("completed" as const),
            },
          }),
    },
  };
};

const skillIdentityAligned = (
  identity: InstalledSkillIdentity | undefined,
): boolean =>
  identity?.version === PRODUCT_IDENTITY.skillVersion &&
  identity.toolCount === CATALOG_IDENTITY.counts.mcp_tools &&
  identity.canonical;

const skillIdentityCheck = (
  identity: InstalledSkillIdentity | undefined,
): DoctorCheck => ({
  name: "skill:identity",
  ok: false,
  classification: "config_drift",
  detail:
    identity === undefined
      ? "Installed REA skill identity is missing."
      : "Installed REA skill identity is stale.",
  remediation: "Run rea setup to update the installed REA skill.",
});

const registrationCheck = (
  registration: UnhealthyClientRegistrationStatus,
): DoctorCheck => ({
  name: `registration:${registration.client}`,
  ok: false,
  classification: "config_drift",
  detail: registration.config_path,
  remediation: registration.remediation,
});

const installationState = (
  paths: readonly string[],
): DoctorIdentity["installations"]["state"] =>
  paths.length === 0 ? "unknown" : paths.length === 1 ? "single" : "multiple";

/** Optional outer-adapter diagnostics composed without reversing dependencies. */
export interface SystemDoctorHostOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFileOutput?: typeof execFileOutput;
  readonly providerInspections?: (
    signal?: AbortSignal,
  ) => Promise<readonly DoctorProviderInspection[]>;
  readonly linuxDemoRuntimeCheck?: (
    signal?: AbortSignal,
  ) => Promise<DoctorCheck>;
}

/** Create diagnostics backed by the current process and host commands. */
export const systemDoctorHost = (
  options: SystemDoctorHostOptions = {},
): DoctorHost => {
  const resources = new ArtifactResourceScope();
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const environment = options.environment ?? process.env;
  const hostExecFileOutput = options.execFileOutput ?? execFileOutput;
  const homeDirectory = homeDirectoryFromEnvironment(environment, platform);
  const commandEnvironment = { env: environment };
  return {
    platform,
    architecture,
    runtime: javaScriptRuntime(process.versions),
    homeDirectory,
    ...(environment.HOPPER_LAUNCHER_PATH === undefined
      ? {}
      : { configuredHopperPath: environment.HOPPER_LAUNCHER_PATH }),
    ...(environment.REA_ILSPY_CMD_PATH === undefined
      ? {}
      : { configuredIlspyCmdPath: environment.REA_ILSPY_CMD_PATH }),
    macosVersion: (signal) =>
      readMacosVersion(hostExecFileOutput, {
        ...commandEnvironment,
        ...(signal === undefined
          ? {}
          : { signal, stopSignal: "SIGTERM" as const }),
      }),
    linuxDistribution: readLinuxDistribution,
    async validTarget(path) {
      return (
        await parseBinaryTarget(path, {
          cwd: process.cwd(),
          hostArchitecture: architecture,
        })
      ).ok;
    },
    async inspectTarget(path) {
      const result = await parseBinaryTarget(path, {
        cwd: process.cwd(),
        hostArchitecture: architecture,
      });
      if (result.ok)
        return {
          name: "target",
          ok: true,
          classification: "healthy",
          detail: path,
        };
      const error = result.error;
      const targetError =
        error instanceof BinaryTargetError ? error : undefined;
      return {
        name: "target",
        ok: false,
        classification:
          targetError?.constraint !== undefined
            ? "unsupported_target"
            : "config_drift",
        detail: path,
        details: {
          reason: targetError?.reason ?? error.message,
          ...(targetError?.constraint === undefined
            ? {}
            : { constraint: targetError.constraint }),
        },
        remediation: analysisErrorRemediationAction(error),
      };
    },
    executable: (path, signal) =>
      executableAvailable(path, platform, hostExecFileOutput, {
        ...commandEnvironment,
        ...(signal === undefined
          ? {}
          : { signal, stopSignal: "SIGTERM" as const }),
      }),
    linuxDemoRuntimeCheck:
      options.linuxDemoRuntimeCheck ?? uncomposedLinuxDemoRuntimeCheck,
    supportedLinuxHopper: linuxHopperBinarySupported,
    async brewHopperPath(signal) {
      return probeHomebrew(async (command) => {
        let caskroom: string;
        try {
          // Without a cask argument, `--caskroom` does not load Homebrew's
          // cask API, so doctor writes no Homebrew cache files.
          caskroom = (
            await hostExecFileOutput(command, ["--caskroom"], {
              ...commandEnvironment,
              ...(signal === undefined
                ? {}
                : { signal, stopSignal: "SIGTERM" as const }),
            })
          ).stdout.trim();
        } catch (cause: unknown) {
          // best-effort cleanup: optional Homebrew probing; absence means uninstalled.
          void cause;
          return undefined;
        }
        const appdir = await installedCaskAppdir(
          caskroom,
          "hopper-disassembler",
          homeDirectory,
        );
        return appdir === undefined
          ? undefined
          : join(appdir, "Hopper Disassembler.app/Contents/MacOS/hopper");
      });
    },
    manualHopperPaths: () => manualHopperPaths(homeDirectory),
    ...(options.providerInspections === undefined
      ? {}
      : { providerInspections: options.providerInspections }),
    async ilspyCmdVersion(path, signal) {
      try {
        await access(path, constants.X_OK);
        return firstIlspyVersionLine(
          (
            await hostExecFileOutput(path, ["--version"], {
              timeout: 10_000,
              ...(signal === undefined
                ? {}
                : { signal, stopSignal: "SIGTERM" as const }),
              ...commandEnvironment,
            })
          ).stdout,
        );
      } catch (cause: unknown) {
        // best-effort cleanup: optional version probing; failure means unavailable.
        void cause;
        return undefined;
      }
    },
    async installationPaths(signal) {
      try {
        const command = platform === "win32" ? "where" : "which";
        const arguments_ = platform === "win32" ? ["rea"] : ["-a", "rea"];
        return uniqueLines(
          (
            await hostExecFileOutput(command, arguments_, {
              ...commandEnvironment,
              ...(signal === undefined
                ? {}
                : { signal, stopSignal: "SIGTERM" as const }),
            })
          ).stdout,
        );
      } catch (cause: unknown) {
        // best-effort cleanup: optional path probing; failure means none found.
        void cause;
        return [];
      }
    },
    installedSkillIdentity: (clientIds) =>
      readInstalledSkillIdentity(
        homeDirectory,
        clientIds,
        environment,
        platform,
        resources,
      ),
    close: async () => {
      try {
        await resources.close();
        return undefined;
      } catch (cause: unknown) {
        return `Doctor resource cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    },
    clientRegistrations: () =>
      readClientRegistrationStatuses(homeDirectory, undefined, {
        platform,
        environment,
        resources,
      }),
  };
};

const readMacosVersion = async (
  run: typeof execFileOutput,
  options: Parameters<typeof execFileOutput>[2],
): Promise<string | undefined> => {
  try {
    return (await run("sw_vers", ["-productVersion"], options)).stdout.trim();
  } catch (cause: unknown) {
    // best-effort cleanup: optional OS version probing; failure means unknown.
    void cause;
    return undefined;
  }
};

const executableAvailable = async (
  path: string,
  platform: NodeJS.Platform,
  run: typeof execFileOutput,
  options: Parameters<typeof execFileOutput>[2],
): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) return false;
    if (platform !== "linux") return true;
    const linked = await run("ldd", [path], options);
    return linuxSharedLibrariesAvailable(`${linked.stdout}\n${linked.stderr}`);
  } catch (cause: unknown) {
    // best-effort cleanup: optional executable probing; failure means unavailable.
    void cause;
    return false;
  }
};

const uncomposedLinuxDemoRuntimeCheck = (): Promise<DoctorCheck> =>
  Promise.resolve({
    name: "hopper-demo-runtime",
    ok: false,
    classification: "config_drift",
    detail: "Linux Hopper private-display diagnostics were not composed",
    remediation: "Run rea doctor through the production CLI adapter.",
  });

const manualHopperPaths = async (home: string): Promise<readonly string[]> => {
  const paths: string[] = [];
  for (const root of ["/Applications", join(home, "Applications")]) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Hopper.*\.app$/i.test(entry.name))
          paths.push(join(root, entry.name, "Contents/MacOS/hopper"));
      }
    } catch (cause: unknown) {
      // A missing or unreadable optional application directory is not fatal.
      void cause;
    }
  }
  return paths;
};

const uniqueLines = (value: string): string[] => [
  ...new Set(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ),
];

const firstIlspyVersionLine = (value: string): string | undefined =>
  uniqueLines(value).find((line) => line.startsWith("ilspycmd:"));
