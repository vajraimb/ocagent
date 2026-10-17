import assert from "node:assert/strict";
import { test } from "node:test";
import { asksForSchedule, describeWhen, nextOccurrence, parseWhen, scheduleChanges, stampIn } from "./schedule.ts";

test("parseWhen reads a clock time with an optional zone and rejects the rest", () => {
  assert.deepEqual(parseWhen("08:00"), { time: "08:00", tz: "Asia/Shanghai" });
  assert.deepEqual(parseWhen(" 8:30 "), { time: "08:30", tz: "Asia/Shanghai" });
  assert.deepEqual(parseWhen("23:59 Asia/Tokyo"), { time: "23:59", tz: "Asia/Tokyo" });
  assert.equal(parseWhen("24:00"), null);
  assert.equal(parseWhen("08:60"), null);
  assert.equal(parseWhen("早上八点"), null);
  assert.equal(parseWhen("08:00 Mars/Olympus"), null);
  assert.equal(parseWhen(""), null);
});

test("nextOccurrence is the next wall-clock time in the zone, strictly after now", () => {
  // 2026-03-01 00:00 UTC is 08:00 in Shanghai: the next 08:00 is the day after.
  const at = Date.UTC(2026, 2, 1, 0, 0, 0);
  assert.equal(nextOccurrence("08:00", "Asia/Shanghai", at), at + 86_400_000);
  assert.equal(nextOccurrence("08:00", "Asia/Shanghai", at - 1), at);
  assert.equal(nextOccurrence("08:01", "Asia/Shanghai", at), at + 60_000);
  // Tokyo is an hour ahead of Shanghai: 08:00 Tokyo = 23:00 UTC the day before.
  assert.equal(nextOccurrence("08:00", "Asia/Tokyo", at), Date.UTC(2026, 2, 1, 23, 0, 0));
  // Across a DST change: 02:30 New York on the spring-forward day is skipped; the schedule fires an hour on, at 03:30 EDT, not at 01:30.
  const before = Date.UTC(2026, 2, 8, 6, 0, 0); // 01:00 EST on 2026-03-08
  const next = nextOccurrence("02:30", "America/New_York", before);
  assert.equal(new Date(next).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.equal(stampIn(next, "America/New_York"), "3月8日 03:30");
  // The day after, 02:30 EDT is a real time again.
  assert.equal(stampIn(nextOccurrence("02:30", "America/New_York", next), "America/New_York"), "3月9日 02:30");
});

test("describeWhen and stampIn speak the schedule's zone", () => {
  assert.equal(describeWhen("08:00", "Asia/Shanghai"), "每天 08:00（北京时间）");
  assert.equal(describeWhen("08:00", "Asia/Tokyo"), "每天 08:00（Asia/Tokyo）");
  assert.equal(stampIn(Date.UTC(2026, 2, 1, 0, 5, 0), "Asia/Shanghai"), "3月1日 08:05");
});

test("scheduleChanges reads Ok registrations and cancels, in order, and skips errors", () => {
  const changes = scheduleChanges([
    { tool: "Schedule.daily", detail: "08:00", output: "Ok 查天气" },
    { tool: "Schedule.daily", detail: "25:00", output: "Error 时间要写成 08:00" },
    { tool: "Schedule.cancel", detail: "2", output: "" },
    { tool: "Schedule.daily", detail: "21:30 Asia/Tokyo", output: "Ok 整理笔记" },
    { tool: "Files.write_file", detail: "a.md", output: "Ok" },
  ]);
  assert.deepEqual(changes, [
    { kind: "daily", spec: { time: "08:00", tz: "Asia/Shanghai", task: "查天气" } },
    { kind: "cancel", n: 2 },
    { kind: "daily", spec: { time: "21:30", tz: "Asia/Tokyo", task: "整理笔记" } },
  ]);
});

test("asksForSchedule: a time or an action every day/week, or 定时, not a passing 每天", () => {
  assert.ok(asksForSchedule("定时北京时间每天早上8点把这5个城市天气预报汇总"));
  assert.ok(asksForSchedule("每天帮我查一次汇率"));
  assert.ok(asksForSchedule("每天 9 点汇总前一天销量"));
  assert.ok(asksForSchedule("schedule a daily digest"));
  assert.ok(!asksForSchedule("写一首关于每天早起的诗"));
  assert.ok(!asksForSchedule("每天的天气都不一样，查一下今天的"));
});
