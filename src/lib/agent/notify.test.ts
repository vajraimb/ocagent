import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkNotifyUrl, notifyAccepted, notifyKind, notifyPayload, scheduleSummary } from "./notify.ts";

describe("notify", () => {
  it("tells the chat tools apart by host and shapes the body each expects", () => {
    assert.equal(notifyKind("https://open.feishu.cn/open-apis/bot/v2/hook/abc"), "feishu");
    assert.equal(notifyKind("https://open.larksuite.com/open-apis/bot/v2/hook/abc"), "feishu");
    assert.equal(notifyKind("https://oapi.dingtalk.com/robot/send?access_token=x"), "dingtalk");
    assert.equal(notifyKind("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"), "wecom");
    assert.equal(notifyKind("https://hooks.slack.com/services/T/B/x"), "slack");
    assert.equal(notifyKind("https://discord.com/api/webhooks/1/x"), "discord");
    assert.equal(notifyKind("https://example.com/hook"), "generic");
    assert.equal(notifyKind("not a url"), "generic");
    assert.deepEqual(notifyPayload("feishu", "hi"), { msg_type: "text", content: { text: "hi" } });
    assert.deepEqual(notifyPayload("dingtalk", "hi"), { msgtype: "text", text: { content: "hi" } });
    assert.deepEqual(notifyPayload("wecom", "hi"), { msgtype: "text", text: { content: "hi" } });
    assert.deepEqual(notifyPayload("slack", "hi"), { text: "hi" });
    assert.deepEqual(notifyPayload("discord", "hi"), { content: "hi" });
    const long = notifyPayload("slack", "x".repeat(2_000)) as { text: string };
    assert.equal(long.text.length, 1_500);
    assert.ok(long.text.endsWith("…"));
  });

  it("accepts only public http(s) addresses, and blank to clear", () => {
    assert.deepEqual(checkNotifyUrl(""), { ok: true, url: "" });
    assert.equal(checkNotifyUrl(" https://hooks.slack.com/services/T/B/x ").ok, true);
    assert.equal(checkNotifyUrl("ftp://x.example").ok, false);
    assert.equal(checkNotifyUrl("http://127.0.0.1:8080/hook").ok, false);
    assert.equal(checkNotifyUrl("hello").ok, false);
  });

  it("reads a refusal out of a 200 reply, since 飞书 / 钉钉 / 企业微信 answer that way", () => {
    assert.deepEqual(notifyAccepted(200, '{"code":0,"msg":"success"}'), { ok: true });
    assert.deepEqual(notifyAccepted(200, '{"StatusCode":0,"StatusMessage":"success"}'), { ok: true });
    assert.deepEqual(notifyAccepted(200, '{"errcode":0,"errmsg":"ok"}'), { ok: true });
    assert.deepEqual(notifyAccepted(200, "ok"), { ok: true });
    assert.deepEqual(notifyAccepted(204, ""), { ok: true });
    const refused = notifyAccepted(200, '{"errcode":310000,"errmsg":"keywords not in content"}');
    assert.ok(!refused.ok && /310000/.test(refused.error) && /keywords/.test(refused.error));
    const bad = notifyAccepted(400, '{"code":19001,"msg":"param invalid: incoming webhook access token invalid"}');
    assert.ok(!bad.ok && /19001/.test(bad.error));
    const down = notifyAccepted(503, "Service Unavailable");
    assert.ok(!down.ok && /HTTP 503/.test(down.error));
  });

  it("summarises a finished scheduled run in a few lines", () => {
    const text = scheduleSummary({ when: "每天 08:00（北京时间）", task: "查 5 个城市天气，写进 weather/today.md", status: "done", answer: "今天最热的是新加坡 31°C。", link: "https://app.example/?desk=desk-1" });
    assert.equal(text, "【定时任务】每天 08:00（北京时间） · 做完了\n任务：查 5 个城市天气，写进 weather/today.md\n结果：今天最热的是新加坡 31°C。\n工作区：https://app.example/?desk=desk-1");
    assert.match(scheduleSummary({ when: "每天", task: "t", status: "failed", answer: "", link: "" }), /没做成/);
  });
});
