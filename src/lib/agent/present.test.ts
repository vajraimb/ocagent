import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRawDump, presentAnswer, rewriteStep } from "./present.ts";

const SHANGHAI = `HTTP 200 api.open-meteo.com
{"latitude":31.247803,"longitude":121.5,"current_units":{"time":"iso8601","temperature_2m":"°C","weather_code":"wmo code"},"current":{"time":"2026-10-07T08:30","interval":900,"temperature_2m":19.5,"weather_code":1}}`;

function frame(kind: string, text: string, effects: string): string {
  const block = (value: string) => `${Buffer.byteLength(value)}\n${value}\n`;
  return `ok\n${kind}\n${block(text)}${block("")}${block(effects)}0\n`;
}

function readText(raw: string): string {
  const buf = Buffer.from(raw, "utf8");
  let i = 0;
  const line = () => {
    const j = buf.indexOf(0x0a, i);
    const end = j < 0 ? buf.length : j;
    const s = buf.toString("utf8", i, end);
    i = j < 0 ? buf.length : j + 1;
    return s;
  };
  line();
  return { kind: line(), text: (() => { const n = Number(line()); const s = buf.toString("utf8", i, i + n); return s; })() }.text;
}

describe("present a finished answer", () => {
  it("turns a weather dump into one sentence", () => {
    assert.equal(isRawDump(SHANGHAI), true);
    assert.equal(presentAnswer("搜索今天上海的天气", SHANGHAI), "上海现在大约 19.5°C，大部晴朗（08:30）。");
  });

  it("uses the daily range when the forecast has one", () => {
    const daily = '{"daily":{"temperature_2m_min":[8.2],"temperature_2m_max":[23],"weather_code":[2]}}';
    assert.equal(presentAnswer("搜索今天上海的天气", daily), "上海今天大约 8.2–23°C，多云。");
  });

  it("leaves a sentence the model already wrote", () => {
    const said = "上海今天多云，大约 19°C。";
    assert.equal(presentAnswer("搜索今天上海的天气", said), said);
  });

  it("reads the number even when the model left the temperature blank", () => {
    const yungang = `云冈今天多云，大约 °C。
Net.get\turl\tOk HTTP 200 api.open-meteo.com
{"latitude":40.105446,"longitude":113.19328,"current_units":{"temperature_2m":"°C","weather_code":"wmo code"},"current":{"time":"2026-10-07T08:45","temperature_2m":11.6,"weather_code":0}}`;
    assert.equal(presentAnswer("搜索今天云冈的天气", yungang), "云冈现在大约 11.6°C，晴（08:45）。");
  });
});

describe("reject an answer that never saw the number", () => {
  const effects = `Net.get\turl\tOk HTTP 200 api.open-meteo.com {"latitude":40.1,"current_units":{"temperature_2m":"°C"},"current":{"time":"2026-10-07T08:45","temperature_2m":11.6,"weather_code":0}}`;

  it("does not finish in the same step that fetched the weather", () => {
    const next = rewriteStep(frame("done", "云冈今天多云，大约 °C。", effects), "搜索今天云冈的天气", 0);
    assert.equal(next.usedRedirect, true);
    assert.match(next.raw, /^ok\ncontinue\n/);
    assert.match(next.raw, /【结果】/);
    assert.match(next.raw, /11\.6/);
  });

  it("keeps going when the step already continued", () => {
    const next = rewriteStep(frame("continue", "已取到正文", effects), "搜索今天云冈的天气", 0);
    assert.equal(next.usedRedirect, false);
    assert.match(next.raw, /^ok\ncontinue\n/);
    assert.match(next.raw, /11\.6/);
  });

  it("sends a non-weather guess back once, with the number visible", () => {
    const price = "Net.get\turl\tOk HTTP 200 shop.example 价格 42 元";
    const next = rewriteStep(frame("done", "大概不便宜。", price), "查一下价格", 0);
    assert.equal(next.usedRedirect, true);
    assert.match(next.raw, /^ok\ncontinue\n/);
    assert.match(next.raw, /【结果】/);
    assert.match(next.raw, /42/);
  });

  it("keeps continuing through a later fetch instead of stopping after one", () => {
    const price = "Net.get\turl\tOk HTTP 200 shop.example 价格 42 元";
    const next = rewriteStep(frame("done", "大概不便宜。", price), "查一下价格", 2);
    assert.equal(next.usedRedirect, true);
    assert.match(next.raw, /^ok\ncontinue\n/);
  });

  it("shows every tool result from the same step", () => {
    const both = [
      "Search.query\tq\tOk 上海 19.5",
      "Net.get\turl\tOk HTTP 200 api.example 湿度 70",
    ].join("\n");
    const next = rewriteStep(frame("done", "查完了。", both), "查天气和湿度", 0);
    assert.match(next.raw, /19\.5/);
    assert.match(next.raw, /70/);
  });

  it("stops after three fetches that still skip the number", () => {
    const price = "Net.get\turl\tOk HTTP 200 shop.example 价格 42 元";
    const next = rewriteStep(frame("done", "大概不便宜。", price), "查一下价格", 3);
    assert.equal(next.usedRedirect, false);
    assert.match(readText(next.raw), /42/);
    assert.doesNotMatch(readText(next.raw), /不便宜/);
  });
});
