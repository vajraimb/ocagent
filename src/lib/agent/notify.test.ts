import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:net";
import { MAIL_UNSET, checkNotifyUrl, mailAddress, mailConfig, mailSubject, maskAddress, notifyAccepted, notifyKind, notifyName, notifyPayload, scheduleSummary, sendMail, sendNotify, type MailMessage } from "./notify.ts";

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

  it("takes an email address, bare or mailto:, and stores it as mailto:", () => {
    assert.deepEqual(checkNotifyUrl("Vajra@Gmail.com"), { ok: true, url: "mailto:Vajra@gmail.com" });
    assert.deepEqual(checkNotifyUrl("  mailto:me@example.org "), { ok: true, url: "mailto:me@example.org" });
    assert.equal(checkNotifyUrl("me@gmail").ok, false, "no dot in the domain");
    assert.match((checkNotifyUrl("mailto:not an address") as { error: string }).error, /邮箱地址不对/);
    assert.match((checkNotifyUrl("ftp://x.example/hook") as { error: string }).error, /邮箱地址，或 https/);
    assert.equal(notifyKind("mailto:me@gmail.com"), "email");
    assert.equal(notifyName("email"), "邮箱");
    assert.equal(mailAddress("mailto:me@gmail.com?subject=x"), "me@gmail.com");
    assert.equal(mailAddress("https://hooks.slack.com/x"), null);
  });

  it("reads the sending mailbox from the environment, Gmail by default, app password with or without spaces", () => {
    assert.equal(mailConfig({}), null);
    assert.equal(mailConfig({ NOTIFY_MAIL_USER: "me@gmail.com" }), null);
    assert.deepEqual(mailConfig({ NOTIFY_MAIL_USER: " me@gmail.com ", NOTIFY_MAIL_PASS: "abcd efgh ijkl mnop" }), { host: "smtp.gmail.com", port: 465, user: "me@gmail.com", pass: "abcdefghijklmnop" });
    assert.deepEqual(mailConfig({ NOTIFY_MAIL_USER: "u", NOTIFY_MAIL_PASS: "p", NOTIFY_MAIL_HOST: "smtp.example", NOTIFY_MAIL_PORT: "587" }), { host: "smtp.example", port: 587, user: "u", pass: "p" });
    assert.deepEqual(mailConfig({ NOTIFY_MAIL_USER: '"me@gmail.com"', NOTIFY_MAIL_PASS: "'abcd efgh ijkl mnop'\n" })?.pass, "abcdefghijklmnop", "quotes pasted around the values are dropped");
    assert.equal(mailConfig({ NOTIFY_MAIL_USER: '"me@gmail.com"', NOTIFY_MAIL_PASS: "p" })?.user, "me@gmail.com");
    assert.equal(maskAddress("vajra@gmail.com"), "va…@gmail.com");
    assert.equal(maskAddress("a@b.co"), "a…@b.co");
  });

  it("mails the text with the first line as the subject; without a mailbox it says what to configure", async () => {
    const sent: MailMessage[] = [];
    const config = { host: "h", port: 465, user: "me@gmail.com", pass: "p" };
    const text = "【定时任务】每天 08:00 · 做完了\n任务：查天气\n结果：晴";
    assert.deepEqual(await sendMail("you@gmail.com", text, config, async (message) => void sent.push(message)), { ok: true, where: "邮箱" });
    assert.deepEqual(sent, [{ from: "me@gmail.com", to: "you@gmail.com", subject: "【定时任务】每天 08:00 · 做完了 · ocagent", text }]);
    assert.equal(mailSubject("x".repeat(100)).length, 80 + " · ocagent".length);
    assert.equal(mailSubject("【测试】ocagent 的通知已接通"), "【测试】ocagent 的通知已接通");
    const unset = await sendMail("you@gmail.com", text, null);
    assert.deepEqual(unset, { ok: false, where: "邮箱", error: MAIL_UNSET });
    assert.match(MAIL_UNSET, /NOTIFY_MAIL_USER/);
    const failWith = async (message: string) => {
      const sent = await sendMail("you@gmail.com", text, config, async () => {
        throw Object.assign(new Error(message), { code: "EAUTH" });
      });
      return sent.ok ? "" : sent.error;
    };
    const wrongPassword = await failWith("Invalid login: 535-5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials");
    assert.match(wrongPassword, /me…@gmail\.com/, "names the configured sender so a wrong NOTIFY_MAIL_USER is visible");
    assert.match(wrongPassword, /在这个账号里生成/);
    assert.match(await failWith("Invalid login: 534-5.7.9 Application-specific password required. Learn more at https://support.google.com/mail/?p=InvalidSecondFactor"), /登录密码，不是应用专用密码/);
    assert.match(await failWith("Invalid login: 534-5.7.14 <https://accounts.google.com/signin/continue> Please log in via your web browser and then try again."), /先在浏览器里登录一次/);
    assert.match(await failWith("Invalid login: 535 5.7.1 Authentication failed"), /不接受发件账号/);
    assert.match((await sendNotify("mailto:you@gmail.com", text)).ok ? "" : (await sendNotify("mailto:you@gmail.com", text) as { error: string }).error, /发件邮箱/, "sendNotify routes mailto: to mail and reports the unset mailbox");
  });

  it("speaks SMTP for real against a local server: AUTH, the recipient and the body arrive", async () => {
    const lines: string[] = [];
    let data = "";
    const server = createServer((socket) => {
      socket.write("220 qa.local ESMTP\r\n");
      let inData = false;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let at: number;
        while ((at = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 OK queued\r\n");
            } else data += `${line}\n`;
            continue;
          }
          lines.push(line);
          const verb = line.split(" ")[0]?.toUpperCase();
          if (verb === "EHLO") socket.write("250-qa.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (verb === "AUTH") socket.write("235 ok\r\n");
          else if (verb === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 OK\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const result = await sendMail("you@gmail.com", "标题行\n正文第二行", { host: "127.0.0.1", port, user: "me@gmail.com", pass: "abcdefghijklmnop" });
      assert.deepEqual(result, { ok: true, where: "邮箱" });
      const auth = lines.find((line) => /^AUTH PLAIN/i.test(line)) ?? "";
      assert.equal(Buffer.from(auth.split(" ")[2] ?? "", "base64").toString("utf8"), "\0me@gmail.com\0abcdefghijklmnop");
      assert.ok(lines.some((line) => /^RCPT TO:<you@gmail.com>/i.test(line)), lines.join(" | "));
      assert.match(data, /^Subject: =\?UTF-8\?Q\?=E6=A0=87=E9=A2=98=E8=A1=8C/m, "the subject is the first line, MIME-encoded");
      const body = data.split("\n\n")[1] ?? "";
      assert.equal(Buffer.from(body.trim(), "base64").toString("utf8"), "标题行\n正文第二行");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
