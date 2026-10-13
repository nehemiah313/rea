import { explicitBooleanArgumentError } from "./cli/explicitBooleanArguments.js";
const UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE =
  "Token windows cannot preserve structured output. Remove --token-limit/--token-offset and use --filter-output or command pagination.";

type StructuredOutputFormat = "json" | "jsonl" | "yaml";
const INCUR_OUTPUT_FORMATS = new Set(["toon", "json", "yaml", "md", "jsonl"]);

export type CliOutputArgumentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly format: StructuredOutputFormat;
      readonly code:
        | "UNSUPPORTED_OUTPUT_COMBINATION"
        | "INVALID_OUTPUT_FILTER"
        | "VALIDATION_ERROR";
      readonly message: string;
    };

interface ParsedCliOutputArguments {
  readonly filterOutput: string | undefined;
  readonly format: string;
  readonly fullOutput: boolean;
  readonly parseError: boolean;
  readonly tokenCount: boolean;
  readonly tokenWindow: boolean;
  readonly tokenLimit: number | undefined;
  readonly tokenOffset: number | undefined;
}

/** Read effective Incur output controls at the executable boundary. */
export const parseCliOutputArguments = (
  arguments_: readonly string[],
): ParsedCliOutputArguments => {
  let format: string = "toon";
  let filterOutput: string | undefined;
  let fullOutput = false;
  let tokenCount = false;
  let tokenLimit: number | undefined;
  let tokenOffset: number | undefined;
  const parsed = (parseError: boolean): ParsedCliOutputArguments => ({
    filterOutput,
    format,
    fullOutput,
    parseError,
    tokenCount,
    tokenWindow:
      !parseError && (tokenLimit !== undefined || tokenOffset !== undefined),
    tokenLimit: parseError ? undefined : tokenLimit,
    tokenOffset: parseError ? undefined : tokenOffset,
  });
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    // Incur scans builtins across `--` and accepts only spaced value forms.
    // Mirror those effective values at the executable output boundary.
    if (argument === "--json") {
      format = "json";
      continue;
    }
    if (argument === "--format") {
      const value = arguments_[index + 1];
      if (value) {
        // Incur stops parsing at an invalid format before applying any later
        // output controls. Let it report that malformed flag itself.
        if (!INCUR_OUTPUT_FORMATS.has(value)) return parsed(true);
        format = value;
        index += 1;
      }
      continue;
    }
    if (argument === "--filter-output") {
      if (arguments_[index + 1]) {
        filterOutput = arguments_[index + 1];
        index += 1;
      }
      continue;
    }
    if (argument === "--token-limit" || argument === "--token-offset") {
      const value = arguments_[index + 1];
      if (value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || value.trim() === "")
          return parsed(true);
        if (argument === "--token-limit") tokenLimit = numericValue;
        else tokenOffset = numericValue;
        index += 1;
      }
      continue;
    }
    if (argument === "--full-output") fullOutput = true;
    if (argument === "--token-count") tokenCount = true;
  }
  return parsed(false);
};

/** Reject slices that cannot advance within Incur's comma-delimited paths. */
const hasUnclosedFilterSlice = (expression: string): boolean => {
  let depth = 0;
  let unclosed = false;
  for (const character of expression) {
    if (character === "[") {
      depth += 1;
      unclosed = true;
    } else if (character === "]") {
      depth -= 1;
      // Incur consumes everything through the next closing bracket, including
      // nested opening brackets. Do not impose a different filter grammar.
      unclosed = false;
    } else if (character === "," && depth === 0 && unclosed) return true;
  }
  return unclosed;
};

/** Reject output controls that cannot safely produce a complete result. */
export const validateCliOutputArguments = (
  arguments_: readonly string[],
): CliOutputArgumentValidation => {
  const { filterOutput, format, parseError, tokenWindow } =
    parseCliOutputArguments(arguments_);
  if (parseError) return { ok: true };
  const doctorError = validateDoctorPresentationArguments(arguments_);
  if (doctorError !== undefined)
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "VALIDATION_ERROR",
      message: doctorError,
    };

  if (filterOutput !== undefined && hasUnclosedFilterSlice(filterOutput))
    return {
      ok: false,
      format: format === "yaml" || format === "jsonl" ? format : "json",
      code: "INVALID_OUTPUT_FILTER",
      message:
        "The --filter-output expression has a slice without a closing ]. Close the slice or remove --filter-output.",
    };
  if (
    tokenWindow &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return {
      ok: false,
      format,
      code: "UNSUPPORTED_OUTPUT_COMBINATION",
      message: UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE,
    };
  return { ok: true };
};

/** Preserve a complete document when Incur filters the entire result away. */
export const renderEmptyFilteredCliOutput = (
  arguments_: readonly string[],
): string | undefined => {
  const { filterOutput, format, parseError } =
    parseCliOutputArguments(arguments_);
  if (parseError) return undefined;
  if (
    filterOutput &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return "{}\n";
  return undefined;
};

/** Render one complete structured error before command execution. */
export const renderCliOutputArgumentError = (
  error: Exclude<CliOutputArgumentValidation, { readonly ok: true }>,
): string => {
  const value = {
    ok: false,
    error: { code: error.code, message: error.message },
  };
  if (error.format === "yaml")
    return `ok: false\nerror:\n  code: ${error.code}\n  message: ${JSON.stringify(error.message)}\n`;
  return `${JSON.stringify(value)}\n`;
};

/** Preserve raw boolean values before Incur's permissive string coercion. */
const validateDoctorPresentationArguments = (
  args: readonly string[],
): string | undefined => {
  const valued = new Set([
    "--format",
    "--filter-output",
    "--token-limit",
    "--token-offset",
    "--target",
    "--client",
    "--provider",
    "--deadline-ms",
  ]);
  const booleans = new Set(["summary", "failuresOnly", "human", "skill"]);
  let doctor = false;
  let human = false;
  let incompatible = false;
  const invalid = explicitBooleanArgumentError(args, booleans, valued);
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i]!;
    if (argument === "--help" || argument === "-h") return undefined;
    if (argument === "doctor") doctor = true;
    if (
      argument === "--json" ||
      argument === "--format" ||
      argument === "--full-output" ||
      argument === "--filter-output" ||
      argument === "--token-count" ||
      argument === "--token-limit" ||
      argument === "--token-offset"
    )
      incompatible = true;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const name = flag
      .slice(2)
      .replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
    if (booleans.has(name)) {
      const value = equals < 0 ? "true" : argument.slice(equals + 1);

      if (flag === "--human") human = value === "true";
    }
    if (argument === "--no-human") human = false;
    if (valued.has(argument)) i += 1;
  }
  if (!doctor) return undefined;
  return (
    invalid ??
    (human && incompatible
      ? "--human cannot be combined with formatting, filtering, envelope, or token-output options."
      : undefined)
  );
};
