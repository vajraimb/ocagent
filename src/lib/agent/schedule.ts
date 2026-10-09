// Daily schedules a desk keeps: "every day at HH:MM in this time zone, give
// the desk this task". The step API registers them (Schedule.daily) as effect
// lines; the server stores them and starts a run when one is due. Pure
// helpers live here so both the loop and the page can use them.

export const DEFAULT_TZ = "Asia/Shanghai";
export const MAX_SCHEDULES = 5;
export const MAX_SCHEDULE_TASK = 300;
const DAY_MS = 86_400_000;

export type ScheduleSpec = { time: string; tz: string; task: string };

const TIME = /^(\d{1,2}):(\d{2})$/;

/** Parses "08:00" / "8:30 Asia/Tokyo" into a clock time and a zone; null when it is not one. */
export function parseWhen(raw: string): { time: string; tz: string } | null {
  const [first = "", ...rest] = raw.trim().split(/\s+/);
  const match = TIME.exec(first);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const tz = rest.join(" ") || DEFAULT_TZ;
  if (!validZone(tz)) return null;
  return { time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`, tz };
}

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function partsIn(tz: string, ms: number): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const got: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== "literal") got[part.type] = Number(part.value);
  return { y: got.year ?? 1970, m: got.month ?? 1, d: got.day ?? 1, h: got.hour ?? 0, mi: got.minute ?? 0, s: got.second ?? 0 };
}

// What the zone adds to UTC at this instant.
function offsetAt(tz: string, ms: number): number {
  const p = partsIn(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The next instant strictly after `fromMs` when the zone's wall clock reads `time`. */
export function nextOccurrence(time: string, tz: string, fromMs: number): number {
  const match = TIME.exec(time);
  const hours = Number(match?.[1] ?? 0);
  const minutes = Number(match?.[2] ?? 0);
  for (let day = 0; day <= 2; day += 1) {
    const local = partsIn(tz, fromMs + day * DAY_MS);
    const wall = Date.UTC(local.y, local.m - 1, local.d, hours, minutes, 0);
    // Two passes settle the offset across a DST change on that day; a time
    // the clocks skip over falls on the first pass, an hour on.
    const first = wall - offsetAt(tz, wall);
    const second = wall - offsetAt(tz, first);
    const read = partsIn(tz, second);
    const instant = read.h === hours && read.mi === minutes ? second : first;
    if (instant > fromMs) return instant;
  }
  return fromMs + DAY_MS;
}

/** "每天 08:00（北京时间）" or "每天 08:00（Asia/Tokyo）". */
export function describeWhen(time: string, tz: string): string {
  return `每天 ${time}（${tz === DEFAULT_TZ ? "北京时间" : tz}）`;
}

/** A short local time stamp for the page, in the schedule's own zone. */
export function stampIn(ms: number, tz: string): string {
  const p = partsIn(tz, ms);
  return `${p.m}月${p.d}日 ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** Schedule effects a step logged, in order. */
export type ScheduleChange = { kind: "daily"; spec: ScheduleSpec } | { kind: "cancel"; n: number };

export function isScheduleEffect(tool: string): boolean {
  return tool === "Schedule.daily" || tool === "Schedule.cancel";
}

export function scheduleChanges(effects: { tool: string; detail: string; output: string }[]): ScheduleChange[] {
  const changes: ScheduleChange[] = [];
  for (const effect of effects) {
    if (effect.tool === "Schedule.daily" && effect.output.startsWith("Ok")) {
      const when = parseWhen(effect.detail);
      const task = effect.output.replace(/^Ok\s?/, "").trim().slice(0, MAX_SCHEDULE_TASK);
      if (when && task) changes.push({ kind: "daily", spec: { ...when, task } });
    } else if (effect.tool === "Schedule.cancel") {
      const n = Number(effect.detail);
      if (Number.isInteger(n) && n >= 1) changes.push({ kind: "cancel", n });
    }
  }
  return changes;
}

// A task that asks for something to happen on a schedule.
const CLOCKED = "(早上|上午|中午|下午|晚上|凌晨|\\d{1,2}\\s*[点:：时]|整点|准时|自动|帮我|给我|提醒|推送|发|跑|执行|汇总|更新|同步|检查|抓|查)";
const SCHEDULED = new RegExp(`定时|到点|到时候自动|每(天|日|周|月|小时|分钟|隔\\s*\\S{1,6})\\s*(都\\s*)?${CLOCKED}|\\bcron\\b|schedule`, "i");

export function asksForSchedule(task: string): boolean {
  return SCHEDULED.test(task);
}
