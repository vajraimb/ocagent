function lastNumber(text: string, key: string): number | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*\\[?\\s*(-?\\d+(?:\\.\\d+)?)`, "g");
  let found: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found = value;
  }
  return found;
}

function lastClock(text: string): string {
  const pattern = /"time"\s*:\s*"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g;
  let clock = "";
  for (const match of text.matchAll(pattern)) clock = match[2] ?? "";
  return clock;
}

function sky(code: number | null): string {
  if (code === null) return "";
  if (code === 0) return "晴";
  if (code === 1) return "大部晴朗";
  if (code === 2) return "多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "有雾";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code >= 61 && code <= 67) return "下雨";
  if (code >= 71 && code <= 77) return "下雪";
  if (code >= 80 && code <= 82) return "阵雨";
  if (code >= 95 && code <= 99) return "雷雨";
  return "";
}

function fmt(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function placeOf(task: string): string {
  const cleaned = task
    .replace(/搜索|查询|查一下|帮我查|请查|今天|今日|现在|的天气|天气|怎么样|如何/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!cleaned || cleaned.length > 12) return "";
  return cleaned;
}

export function isRawDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (trimmed.startsWith("HTTP ") && trimmed.includes("{")) return true;
  return trimmed.length > 160 && (trimmed.includes('"latitude"') || trimmed.includes("temperature_2m"));
}

function sentence(task: string, text: string): string | null {
  const place = placeOf(task);
  const where = place || "当地";
  const condition = sky(lastNumber(text, "weather_code"));
  const conditionText = condition ? `，${condition}` : "";
  const low = lastNumber(text, "temperature_2m_min");
  const high = lastNumber(text, "temperature_2m_max");
  if (low !== null && high !== null) return `${where}今天大约 ${fmt(low)}–${fmt(high)}°C${conditionText}。`;
  const now = lastNumber(text, "temperature_2m");
  if (now === null) return null;
  const clock = lastClock(text);
  const when = clock ? `（${clock}）` : "";
  return `${where}现在大约 ${fmt(now)}°C${conditionText}${when}。`;
}

export function presentAnswer(task: string, answer: string): string {
  if (!isRawDump(answer)) return answer;
  return sentence(task, answer) ?? "拿到了原始数据，但没有整理成一句回答。";
}

const SKIPPED_KEY = new Set(["latitude", "longitude", "generationtime_ms", "utc_offset_seconds", "elevation", "interval"]);

function encodeBlock(text: string): string {
  const body = Buffer.from(text, "utf8");
  return `${body.length}\n${body.toString("utf8")}\n`;
}

function readFrame(raw: string): { kind: string; text: string; traces: string; effects: string; suffix: string } | null {
  if (!raw.startsWith("ok\n")) return null;
  const buf = Buffer.from(raw, "utf8");
  let i = 0;
  const line = () => {
    const j = buf.indexOf(0x0a, i);
    const end = j < 0 ? buf.length : j;
    const s = buf.toString("utf8", i, end);
    i = j < 0 ? buf.length : j + 1;
    return s;
  };
  const block = () => {
    const n = Number(line());
    if (!Number.isFinite(n) || n < 0 || i + n > buf.length) return null;
    const s = buf.toString("utf8", i, i + n);
    i += n;
    if (buf[i] === 0x0a) i += 1;
    return s;
  };
  line();
  const kind = line();
  const text = block();
  const traces = block();
  const effects = block();
  if (text === null || traces === null || effects === null) return null;
  return { kind, text, traces, effects, suffix: buf.toString("utf8", i) };
}

function writeFrame(frame: { kind: string; text: string; traces: string; effects: string; suffix: string }): string {
  return `ok\n${frame.kind}\n${encodeBlock(frame.text)}${encodeBlock(frame.traces)}${encodeBlock(frame.effects)}${frame.suffix}`;
}

function effectOutputs(effects: string): string[] {
  return effects
    .split("\n")
    .filter((line) => line.startsWith("Net.get\t") || line.startsWith("Search.query\t"))
    .map((line) => line.split("\t").slice(2).join("\t"));
}

function factNumbers(output: string): string[] {
  const found: string[] = [];
  const keyed = /"([A-Za-z0-9_]+)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
  for (const match of output.matchAll(keyed)) {
    if (!SKIPPED_KEY.has(match[1] ?? "")) found.push(match[2] ?? "");
  }
  if (found.length > 0) return [...new Set(found)];
  const body = output.replace(/^(?:Ok )?HTTP \d+ \S+\s*/, "");
  return [...new Set(body.match(/\d+(?:\.\d+)?/g) ?? [])].filter((item) => item.includes(".") || item.length >= 2).slice(0, 12);
}

function observation(effects: string): { note: string; numbers: string[] } | null {
  const outputs = effectOutputs(effects);
  if (outputs.length === 0) return null;
  const numbers: string[] = [];
  const parts: string[] = [];
  for (const output of outputs) {
    const facts = factNumbers(output);
    numbers.push(...facts);
    parts.push(facts.length > 0 ? facts.join(" ") : output.slice(0, 800) + (output.length > 1600 ? ` … ${output.slice(-800)}` : output.slice(800)));
  }
  const note = `【结果】这一步各次返回如下。结论里的数字必须来自这里。若下一次调用的参数还要靠这些返回值，可以再请求，然后继续 Continue： ${parts.join(" | ")}`;
  return { note, numbers: [...new Set(numbers)] };
}

function withNote(effects: string, note: string): string {
  if (effects.includes("【结果】")) return effects;
  const flat = note.replaceAll("\t", " ").replaceAll("\n", " ");
  const base = effects.replace(/\s*$/, "");
  return `${base}${base ? "\n" : ""}Trace.note\t\t${flat}`;
}

export function rewriteStep(raw: string, task: string, redirects: number): { raw: string; usedRedirect: boolean } {
  const frame = readFrame(raw);
  if (!frame) return { raw, usedRedirect: false };
  if (frame.kind !== "done" && frame.kind !== "partial" && frame.kind !== "continue") return { raw, usedRedirect: false };
  const seen = observation(frame.effects);
  if (!seen) return { raw, usedRedirect: false };
  const effects = withNote(frame.effects, seen.note);
  if (frame.kind === "continue") return { raw: writeFrame({ ...frame, effects }), usedRedirect: false };
  if (redirects < 3) return { raw: writeFrame({ ...frame, kind: "continue", effects }), usedRedirect: true };
  const weather = sentence(task, `${frame.text}\n${frame.effects}`);
  return { raw: writeFrame({ ...frame, kind: "done", text: weather ?? seen.note }), usedRedirect: false };
}

