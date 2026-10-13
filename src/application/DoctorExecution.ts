import type { DoctorCheck } from "./Doctor.js";

import type { DoctorReportExecution } from "../contracts/doctorReportSchemas.js";
/** A deadline bounds probing; owned cleanup is awaited separately. */
export type DoctorExecutionReport = DoctorReportExecution;

/** Caller-selected execution controls, independent of presentation. */
export interface DoctorExecutionOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/** Run cooperative probes without abandoning promises or their resources. */
export class DoctorExecution {
  readonly controller = new AbortController();
  readonly #deadlineMs: number | undefined;
  readonly #timer: NodeJS.Timeout | undefined;
  readonly #external: AbortSignal | undefined;
  #reason: "deadline" | "cancelled" | null = null;
  #incomplete = false;

  constructor(options: DoctorExecutionOptions) {
    if (
      options.deadlineMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineMs) ||
        options.deadlineMs <= 0 ||
        options.deadlineMs > 2_147_483_647)
    )
      throw new RangeError(
        "Doctor deadline must be a positive timer-safe integer.",
      );
    this.#deadlineMs = options.deadlineMs;
    this.#external = options.signal;
    this.#external?.addEventListener("abort", this.#cancel, { once: true });
    if (this.#external?.aborted) this.#cancel();
    this.#timer =
      options.deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
            this.#reason ??= "deadline";
            this.controller.abort(new Error("Doctor deadline expired"));
          }, options.deadlineMs);
  }

  readonly #cancel = (): void => {
    this.#reason ??= "cancelled";
    this.controller.abort(this.#external?.reason);
  };

  get bounded(): boolean {
    return this.#deadlineMs !== undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async probe<Value>(
    name: string,
    operation: () => Promise<Value>,
  ): Promise<
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly check: DoctorCheck }
  > {
    const started = !this.signal.aborted;
    if (started) {
      try {
        const value = await operation();
        if (!this.signal.aborted) return { ok: true, value };
      } catch (cause: unknown) {
        if (!this.signal.aborted) throw cause;
      }
    }
    this.#incomplete = true;
    return {
      ok: false,
      check: {
        name,
        ok: false,
        classification: "diagnostic_incomplete",
        execution_status: !started
          ? "not_examined"
          : this.#reason === "deadline"
            ? "timed_out"
            : "cancelled",
        detail: !started
          ? "Not examined after diagnostic execution stopped."
          : "Probe interrupted; no readiness conclusion was inferred.",
        remediation:
          "Rerun rea doctor with a longer --deadline-ms or after resolving the interruption.",
      },
    };
  }

  report(): DoctorExecutionReport {
    return {
      complete: !this.#incomplete,
      stop_reason: this.#reason,
      deadline_ms: this.#deadlineMs ?? null,
    };
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#external?.removeEventListener("abort", this.#cancel);
  }
}
