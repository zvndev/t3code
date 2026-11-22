import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";

export {
  localSnoozeDate,
  localSnoozeTime,
  pickSnoozePreset,
  resolveCustomSnooze,
  resolveSnoozePreset,
  resolveSnoozePresets,
  snoozePresetId,
  snoozeWakeLabel,
  type CustomSnoozeInput,
  type SnoozePreset,
} from "@t3tools/shared/snooze";

interface SettlementRunLike {
  readonly turnId?: unknown;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

/**
 * Failed starts and stale shells from older servers can leave user messages unadopted.
 * Bound the pending window so those threads can eventually settle.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export function hasQueuedTurnStart(
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
  if (shell.latestUserMessageAt == null) return false;
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingUserInputAt?: string | null;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly pendingGuestMessageCount?: number;
}

function pendingQuestionAt(shell: ThreadSnoozeShell): string | null {
  const request = shell.source?.pendingRuntimeRequest;
  return (
    shell.pendingUserInputAt ??
    (request?.kind === "user_input" ? DateTime.formatIso(request.createdAt) : null)
  );
}

/**
 * Only a request for the user or a fresh failure ends a snooze early. Completed runs never do:
 * a snoozed long-running thread keeps waking itself for background work and stays hidden
 * until its timer.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  const request = shell.source?.pendingRuntimeRequest;
  if (shell.hasPendingApprovals || (request != null && request.kind !== "user_input")) return true;
  const questionAt = pendingQuestionAt(shell);
  // Snoozing an existing question means "ask me later". Only a new question
  // wakes it early; missing or invalid timestamps keep the request visible.
  if (
    (shell.hasPendingUserInput || request?.kind === "user_input") &&
    (shell.snoozedAt == null ||
      questionAt == null ||
      !(Date.parse(questionAt) <= Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  if (shell.pendingSubagentRequest != null) return true;
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return true;
  const failedAt = failureEdgeAt(shell);
  return (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  );
}

// V2 runtime.updatedAt includes metadata writes, not just failures.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed") {
    return latestRun.completedAt ?? null;
  }
  return runtime.updatedAt ?? null;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
    | "source"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals) return false;
  const request = shell.source?.pendingRuntimeRequest;
  if (request != null && request.kind !== "user_input") return false;
  if (shell.pendingSubagentRequest != null) return false;
  // A waiting guest message would wake it at once.
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    const failedAt = failureEdgeAt(shell);
    const questionAt = pendingQuestionAt(shell);
    const freshFailure =
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt));
    const freshQuestion =
      questionAt != null &&
      shell.snoozedAt != null &&
      Date.parse(questionAt) > Date.parse(shell.snoozedAt);
    if (freshFailure && (!freshQuestion || Date.parse(failedAt) >= Date.parse(questionAt))) {
      return failedAt;
    }
    if (freshQuestion) return questionAt;
    const runtime = shell.runtime ?? shell.session ?? null;
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}

/**
 * Whether the latest run failed after the user last saw the thread. Only the run dates the
 * failure, since the shell's updatedAt also moves on renames. A failed run without a
 * completion time, from older data, is dated by its start.
 */
export function hasUnseenRunFailure(
  thread: Pick<EnvironmentThreadShell, "latestRun"> & {
    readonly lastVisitedAt?: string | null | undefined;
  },
): boolean {
  const run = thread.latestRun;
  if (run?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const failedAtMs = Date.parse(run.completedAt ?? run.startedAt ?? run.requestedAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(failedAtMs) || Number.isNaN(lastVisitedAtMs)) return true;
  return failedAtMs > lastVisitedAtMs;
}
