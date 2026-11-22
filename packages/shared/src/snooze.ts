// @effect-diagnostics globalDate:off -- Snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from "@t3tools/contracts/settings";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const HOUR_MS = 60 * 60 * 1_000;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

export interface SnoozePresetOptions {
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

/** "In 3 hours", "In 90 minutes", "In 2 days": the largest unit that divides evenly. */
function snoozeDurationLabel(minutes: number, resolve: MFunctionType): string {
  if (minutes % (24 * 60) === 0) {
    return resolve(
      msg("{count, plural, one {In {count} day} other {In {count} days}}", {
        count: minutes / (24 * 60),
      }),
    );
  }
  if (minutes % 60 === 0) {
    return resolve(
      msg("{count, plural, one {In {count} hour} other {In {count} hours}}", {
        count: minutes / 60,
      }),
    );
  }
  return resolve(
    msg("{count, plural, one {In {count} minute} other {In {count} minutes}}", { count: minutes }),
  );
}

const WEEKDAY_LABELS = {
  sunday: msg("Sunday"),
  monday: msg("Monday"),
  tuesday: msg("Tuesday"),
  wednesday: msg("Wednesday"),
  thursday: msg("Thursday"),
  friday: msg("Friday"),
  saturday: msg("Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

const NEXT_WEEKDAY_LABELS = {
  sunday: msg("Next Sunday"),
  monday: msg("Next Monday"),
  tuesday: msg("Next Tuesday"),
  wednesday: msg("Next Wednesday"),
  thursday: msg("Next Thursday"),
  friday: msg("Next Friday"),
  saturday: msg("Next Saturday"),
} satisfies Record<keyof typeof WEEKDAY_INDEX, string>;

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(
  setting: SnoozePresetSetting,
  daysAhead: number,
  resolve: MFunctionType,
): string {
  if (setting.kind === "after") return snoozeDurationLabel(setting.minutes, resolve);
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12
      ? resolve(msg("This morning"))
      : hour < 17
        ? resolve(msg("This afternoon"))
        : resolve(msg("This evening"));
  }
  if (daysAhead === 1) return resolve(msg("Tomorrow"));
  if (setting.day === "monday") return resolve(msg("Next week"));
  if (setting.day === "today" || setting.day === "tomorrow") return "";
  return resolve(daysAhead === 7 ? NEXT_WEEKDAY_LABELS[setting.day] : WEEKDAY_LABELS[setting.day]);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
  resolve: MFunctionType = mFallback,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead, resolve);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && !(daysAhead > 1 && setting.day === "monday");
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  options: SnoozePresetOptions = {},
  resolve: MFunctionType = mFallback,
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return (
    (options.presets ?? DEFAULT_SNOOZE_PRESETS)
      .flatMap((setting) => resolveSnoozePreset(setting, now, options.formatTime, resolve) ?? [])
      // flatMap returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => wakeMinute(a) - wakeMinute(b))
      .filter((preset) => {
        if (seen.has(wakeMinute(preset))) return false;
        seen.add(wakeMinute(preset));
        return true;
      })
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly now: Date;
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
  readonly resolve?: MFunctionType;
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > input.now.getTime() ? original : undefined;
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (
    (setting && resolveSnoozePreset(setting, input.now, input.formatTime, input.resolve)) ?? ahead
  );
}

export function snoozeWakeLabel(
  snoozedUntil: string,
  options: { readonly now: string },
  resolve: MFunctionType = mFallback,
): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  const now = () => resolve(msg("now", { $context: "a snoozed thread wakes now" }));
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return now();
  if (wakeMs <= nowMs) return now();
  // Count clock minutes: callers pass a minute-floored or live `now`, and durations keep seconds.
  const minutes = Math.max(1, Math.floor(wakeMs / 60_000) - Math.floor(nowMs / 60_000));
  if (minutes < 60) return resolve(msg("{minutes}m", { minutes: String(minutes) }));
  if (minutes < 24 * 60) {
    return resolve(msg("{hours}h", { hours: String(Math.ceil(minutes / 60)) }));
  }
  return resolve(msg("{days}d", { days: String(Math.ceil(minutes / (24 * 60))) }));
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
