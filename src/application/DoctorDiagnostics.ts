import type { DoctorExecution } from "./DoctorExecution.js";
import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import { linuxHopperLauncherPath } from "./LinuxHopper.js";
import type {
  DoctorCheck,
  DoctorHost,
  DoctorProviderInspection,
} from "./Doctor.js";

const DEFAULT_HOPPER =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const SYSTEM_LINUX_HOPPER = "/opt/hopper/bin/Hopper";

/** Ordered environment diagnostics consumed by the Doctor report assembler. */
export interface DoctorDiagnostics {
  readonly checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
}

/** Collect host, provider, and optional-target diagnostics without mutation. */
export const collectDoctorDiagnostics = async (
  target: string | undefined,
  host: DoctorHost,
  execution?: DoctorExecution,
): Promise<DoctorDiagnostics> => {
  const checks: DoctorCheck[] = [nodeCheck(host)];
  const probe = async <Value>(
    name: string,
    operation: () => Promise<Value>,
  ): Promise<Value | undefined> => {
    if (execution === undefined) return operation();
    const result = await execution.probe(name, operation);
    if (result.ok) return result.value;
    checks.push(result.check);
    return undefined;
  };
  const add = (check: DoctorCheck | undefined): void => {
    if (check !== undefined) checks.push(check);
  };
  // In bounded mode establish required target admission before optional probes.
  if (execution?.bounded === true && target !== undefined)
    add(
      await probe("target", () =>
        optionalTargetCheck(target, host, execution.signal),
      ),
    );
  add(await probe("host", () => hostCheck(host, execution?.signal)));
  const beforeHopper = checks.length;
  const hopperPath = await probe("hopper", () =>
    findHopper(host, execution?.signal),
  );
  if (checks.length === beforeHopper)
    checks.push(hopperCheck(host, hopperPath));
  if (host.platform === "linux" && hopperPath !== undefined)
    add(
      await probe("hopper-version", () =>
        optionalHopperVersionCheck(host, hopperPath, execution?.signal),
      ),
    );
  const providerInspections = await probe(
    "provider:inspection",
    () =>
      host.providerInspections?.(execution?.signal) ??
      Promise.resolve(undefined),
  );
  if (providerInspections !== undefined)
    checks.push(...providerInspections.flatMap(providerDoctorChecks));
  if (host.configuredIlspyCmdPath !== undefined)
    add(
      await probe("ilspycmd", () =>
        optionalIlspyCheck(host, execution?.signal),
      ),
    );
  if (host.platform === "linux" && hopperPath !== undefined)
    add(
      await probe("hopper-demo-runtime", () =>
        optionalHopperDemoCheck(host, hopperPath, execution?.signal),
      ),
    );
  if (execution?.bounded !== true)
    add(
      await probe("target", () =>
        optionalTargetCheck(target, host, execution?.signal),
      ),
    );

  return {
    checks,
    ...(hopperPath === undefined ? {} : { hopperPath }),
    ...(providerInspections === undefined ? {} : { providerInspections }),
  };
};

/** Evaluate core health while treating unconfigured providers as optional. */
export const doctorHealthy = (
  checks: readonly DoctorCheck[],
  providers: {
    readonly hopperAvailable: boolean;
    readonly hopperConfigured: boolean;
    readonly providerInspections:
      | readonly DoctorProviderInspection[]
      | undefined;
  },
): boolean => {
  if (providers.providerInspections === undefined)
    return checks.every(({ ok }) => ok);
  const providerChecks = checks.filter(
    ({ name }) =>
      name.startsWith("hopper") ||
      providers.providerInspections?.some((inspection) =>
        providerCheckName(inspection.id, name),
      ) === true,
  );
  const coreHealthy = checks
    .filter((candidate) => !providerChecks.includes(candidate))
    .every(({ ok }) => ok);
  const configuredProvidersHealthy = providerChecks
    .filter(({ name }) => {
      if (name.startsWith("hopper")) return providers.hopperConfigured;
      return providers.providerInspections?.some(
        (inspection) =>
          inspection.configured && providerCheckName(inspection.id, name),
      );
    })
    .every(({ ok }) => ok);
  return (
    coreHealthy &&
    configuredProvidersHealthy &&
    (providers.hopperAvailable ||
      providers.providerInspections.some(({ available }) => available))
  );
};

/** Failed checks that participate in the existing audit health policy. */
export const doctorBlockingChecks = (
  checks: readonly DoctorCheck[],
  providers: {
    readonly hopperAvailable: boolean;
    readonly hopperConfigured: boolean;
    readonly providerInspections:
      | readonly DoctorProviderInspection[]
      | undefined;
  },
): readonly DoctorCheck[] => {
  if (providers.providerInspections === undefined)
    return checks.filter(({ ok }) => !ok);
  const available =
    providers.hopperAvailable ||
    providers.providerInspections.some(({ available }) => available);
  return checks.filter(({ name, ok }) => {
    if (ok) return false;
    if (name.startsWith("hopper"))
      return providers.hopperConfigured || !available;
    const provider = providers.providerInspections?.find(({ id }) =>
      providerCheckName(id, name),
    );
    return provider === undefined || provider.configured || !available;
  });
};

/** Bun passes when its reported Node.js compatibility version is supported. */
const nodeCheck = ({ runtime }: DoctorHost): DoctorCheck => {
  const failure = {
    remediation: `Install ${SUPPORTED_NODE_VERSION_PROSE}.`,
    classification: "missing_dependency",
  } as const;
  if (runtime.id === "node")
    return {
      ...check(
        "node",
        supportsNodeVersion(runtime.version),
        runtime.version,
        failure,
      ),
      details: { runtime: "node", version: runtime.version },
    };
  return {
    ...check(
      "node",
      supportsNodeVersion(runtime.nodeCompatibilityVersion),
      `Bun ${runtime.version} (Node.js ${runtime.nodeCompatibilityVersion} compatibility)`,
      failure,
    ),
    details: {
      runtime: "bun",
      version: runtime.version,
      node_compatibility_version: runtime.nodeCompatibilityVersion,
    },
  };
};

const hostCheck = async (
  host: DoctorHost,
  signal?: AbortSignal,
): Promise<DoctorCheck> => {
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion(signal) : undefined;
  const linuxDistribution =
    host.platform === "linux"
      ? await host.linuxDistribution(signal)
      : undefined;
  const supported =
    (host.platform === "darwin" && parseMajor(macosVersion) >= 12) ||
    (host.platform === "linux" && linuxDistribution?.supported === true) ||
    (host.platform === "win32" && host.architecture === "x64");
  const detail =
    macosVersion ??
    (linuxDistribution === undefined
      ? `${host.platform} ${host.architecture}`
      : `${linuxDistribution.id} ${linuxDistribution.versionId ?? "unknown"}`);
  return check("host", supported, detail, {
    remediation:
      "REA supports macOS 12+, Ubuntu 24.04+, Fedora 41+, Nobara 44+, 64-bit Arch Linux, CachyOS, Omarchy, and the experimental Windows x64 Ghidra P0 boundary.",
    classification: "unsupported_host",
  });
};

const findHopper = async (
  host: DoctorHost,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const candidates =
    host.configuredHopperPath === undefined
      ? [
          DEFAULT_HOPPER,
          SYSTEM_LINUX_HOPPER,
          linuxHopperLauncherPath(host.homeDirectory),
          ...(await host.manualHopperPaths(signal)),
        ]
      : [host.configuredHopperPath];
  const hopperPath = await firstExecutable(host, candidates, signal);
  if (hopperPath !== undefined || host.configuredHopperPath !== undefined)
    return hopperPath;
  const brewCandidate = await host.brewHopperPath(signal);
  return firstExecutable(
    host,
    brewCandidate === undefined ? [] : [brewCandidate],
    signal,
  );
};

const firstExecutable = async (
  host: DoctorHost,
  candidates: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> => {
  for (const candidate of new Set(candidates))
    if (await host.executable(candidate, signal)) return candidate;
  return undefined;
};

const hopperCheck = (
  host: DoctorHost,
  hopperPath: string | undefined,
): DoctorCheck =>
  check(
    "hopper",
    hopperPath !== undefined,
    hopperPath ?? host.configuredHopperPath,
    {
      remediation:
        host.configuredHopperPath === undefined
          ? "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH."
          : "Unset or update HOPPER_LAUNCHER_PATH to an executable Hopper launcher.",
      classification:
        host.configuredHopperPath === undefined
          ? "missing_analysis_engine"
          : "config_drift",
    },
  );

const optionalHopperVersionCheck = async (
  host: DoctorHost,
  hopperPath: string | undefined,
  signal?: AbortSignal,
): Promise<DoctorCheck | undefined> => {
  if (host.platform !== "linux" || hopperPath === undefined) return undefined;
  return check(
    "hopper-version",
    await host.supportedLinuxHopper(hopperPath, signal),
    hopperPath,
    {
      remediation: unsupportedHopperRemediation(
        host.configuredHopperPath === hopperPath,
      ),
      classification: "config_drift",
    },
  );
};

const optionalHopperDemoCheck = async (
  host: DoctorHost,
  hopperPath: string | undefined,
  signal?: AbortSignal,
): Promise<DoctorCheck | undefined> =>
  host.platform !== "linux" || hopperPath === undefined
    ? undefined
    : host.linuxDemoRuntimeCheck(signal);

const optionalIlspyCheck = async (
  host: DoctorHost,
  signal?: AbortSignal,
): Promise<DoctorCheck | undefined> => {
  if (host.configuredIlspyCmdPath === undefined) return undefined;
  const version = await host.ilspyCmdVersion?.(
    host.configuredIlspyCmdPath,
    signal,
  );
  return check(
    "ilspycmd",
    version !== undefined,
    version === undefined
      ? host.configuredIlspyCmdPath
      : `${host.configuredIlspyCmdPath} (${version})`,
    {
      remediation:
        "Unset REA_ILSPY_CMD_PATH or point it at a runnable ilspycmd executable.",
      classification: "config_drift",
    },
  );
};

const optionalTargetCheck = async (
  target: string | undefined,
  host: DoctorHost,
  signal?: AbortSignal,
): Promise<DoctorCheck | undefined> =>
  target === undefined
    ? undefined
    : host.inspectTarget !== undefined
      ? host.inspectTarget(target, signal)
      : check("target", await host.validTarget(target, signal), target, {
          remediation: "Supply a readable local app or program path.",
          classification: "config_drift",
        });

const check = (
  name: string,
  ok: boolean,
  detail: string | undefined,
  failure: {
    readonly remediation: string;
    readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  },
): DoctorCheck => ({
  name,
  ok,
  classification: ok ? "healthy" : failure.classification,
  ...(detail === undefined ? {} : { detail }),
  ...(ok ? {} : { remediation: failure.remediation }),
});

const providerDoctorChecks = (
  inspection: DoctorProviderInspection,
): readonly DoctorCheck[] =>
  inspection.checks.map((candidate) => ({
    name:
      candidate.name === "configuration"
        ? inspection.id
        : `${inspection.id}-${candidate.name}`,
    ok: candidate.ok,
    classification: candidate.ok ? "healthy" : candidate.classification,
    detail: candidate.detail,
    ...(candidate.remediation === null
      ? {}
      : { remediation: candidate.remediation }),
  }));

const unsupportedHopperRemediation = (configured: boolean): string =>
  configured
    ? "Unset or update HOPPER_LAUNCHER_PATH, install the Hopper build supported by this REA release, or update REA."
    : "Install the Hopper build supported by this REA release, or update REA for a newer Hopper build.";

const parseMajor = (version: string | undefined): number =>
  Number.parseInt(version?.split(".")[0] ?? "0", 10);

const providerCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
