# OCAGENT

两套 OCaml 5 effect harness，浏览器里只演示第一套的协议。

- [`ocaml/`](ocaml/) — journal replay。continuation 存不进去，恢复靠 JSONL 重放。
- [`dsh-ocaml/`](dsh-ocaml/) — Eio 沙箱、预算、高危审批、mock 评测，以及 Fiber actor。子 fiber 不继承 handler，`Spawn` 拉起时把栈装回去。裸 fiber 会丢掉 handler，这是回归测试，不是意外。
- [`protocol/`](protocol/) — 两边共用的 effect / profile 对照表，不跑 handler。

下表是 [`protocol/lib/ocagent_protocol.ml`](protocol/lib/ocagent_protocol.ml) 的摘要。没写上的组合就是没有 handler。

| effect | profile | handler |
|---|---|---|
| Llm, Tool, Ask_human, Now, Fresh_id | Dev, Eval, Prod | journal 记录；world 执行。Eval 没有 policy / compact |
| Compact | Dev, Prod | compact。Eval 没有 |
| Fetch | Prod | journal 记录后，只在沙箱里执行一次 |
| Fetch | Dev, Eval | journal 会记，world 拒绝 |
| AskLLM, CallTool, SandboxExec | Evaluation, DryRun, Production | mock / dry-run / eio。DryRun 和 Production 的审批汇是自动拒绝 |
| Fetch, Web_search | Evaluation, DryRun | 离线 handler，不访问网络 |
| Fetch | Production | curl，只允许 http/https |
| Web_search | Production | 有 `XAI_API_KEY` 才打 xAI，否则明确说没配置 |
| Spawn, Supervise | actor | 子 fiber 里重装整套 handler |

`test_model_replay_chain` 是同进程里的重放模型：`exit_process` 不启动新进程，JSONL 只在内存里往返，Fetch 默认返回固定字符串。它证明的是日志分支，不是磁盘或网络。

`test_process_recover` 跨过进程边界。快照是带版本、校验和的完整文件：临时文件 fsync 之后才改名，锁文件不会被一起换掉。批准只走 `Store.commit_decision`：同一次决定再写一次不改记录，冲突决定和拿 Llm 记录去批准都会被拒绝。旧 attempt 写不进去。进程 B 向本机 HTTP 计数服务发 Fetch，计数在响应发出前落盘。进程 C 重放时 HTTP 和模型计数都不再增加。在 provider 已确认、Done 还没提交时 SIGKILL，下次打开会把这条 `Manual_only` 记成 Unknown，不再请求。这还不是工作台里的可恢复执行，浏览器那条路径仍是 legacy。


`Harness.run` 仍是内存演示，没有执行者锁，也不写这套快照。`Durable.run` 才走磁盘：先非阻塞领取执行者，再在 Store 锁里 prepare / commit。外部调用固定是 `Manual_only`。`Read_retryable` 目前只保证编码能往返，不会自动重试。没有 Step 的快照仍是 `OCAGENT 2`；`OCAGENT 1` 直接拒绝。`OCAGENT 3` 只在 `Store.admit_step` 创建，保存 Step manifest 和 SHA-256 执行指纹。重复接纳不改 revision，换源码是 `Admission_conflict`，第二个 Step 直接拒绝，已有 V2 不会被改成 V3。这一步还没有隔离 worker，不能把 P0-B 当成已经能跑 Step。浏览器里的工作台还是 legacy。





```sh
eval $(opam env --switch=5.3.0)
dune runtest --root .
```

`src/` 是浏览器里的 journal harness 演示。验收以 `dune runtest` 为准。

## Sending email through Gmail（用站长的 Gmail 发信）

The deployed site (`https://ocagent.grok.me`) is the TanStack Start app in
`src/`, running as Node functions on Vercel. It can send mail **as the owner's
Gmail account** through the Gmail API (`users.messages.send`) with an OAuth2
refresh token. Google's official Node client (`@googleapis/gmail`) does the
token refresh and the API call; the OCaml harnesses are not involved.

Code: `src/lib/mail/gmail.ts` (validation, MIME, `sendGmail()`),
`src/lib/mail/google-transport.ts` (the Google call),
`src/lib/mail/endpoint.ts` + `src/routes/api/mail/send.ts` (HTTP endpoint).
Tests: `src/lib/mail/gmail.test.ts`, `scripts/gmail-oauth-token.test.mjs`.

### Secrets (set these in the deployment, never in the repo)

| Variable | What it is |
|---|---|
| `GMAIL_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | Its client secret |
| `GMAIL_REFRESH_TOKEN` | Refresh token for the sending account, scope `gmail.send` only |
| `GMAIL_SENDER` | The Gmail address that approved the token, e.g. `shunjie.bi@gmail.com`; used as `From` |
| `OCAGENT_MAIL_TOKEN` | Optional. ≥ 24 random chars; enables `POST /api/mail/send` for the owner's automations. Unset = endpoint answers 404 |

Where: Vercel → Project → **Settings → Environment Variables** (Production, and
Preview if wanted), then redeploy. `.env.example` lists the same names with
placeholders. Do not create a `.env` in this workspace.

### One-time setup for the owner

1. **Google Cloud project.** Open <https://console.cloud.google.com/>, create or
   pick a project.
2. **Enable the Gmail API.** APIs & Services → Library → "Gmail API" → Enable.
3. **OAuth consent screen.** APIs & Services → OAuth consent screen → User type
   *External* → fill app name + your email. Add the scope
   `https://www.googleapis.com/auth/gmail.send`. Under *Test users* add the
   sending address (`shunjie.bi@gmail.com`). Leaving the app in *Testing* is
   fine for one owner account; note Google expires testing refresh tokens after
   7 days unless the app is set to *In production* (click **Publish app**; a
   `gmail.send`-only app for your own account does not need verification to
   keep working, you will just see an "unverified app" warning once).
4. **OAuth client.** APIs & Services → Credentials → Create credentials →
   OAuth client ID → Application type **Desktop app**. Copy the client ID and
   secret. (Desktop type is what lets the helper below receive the redirect on
   `127.0.0.1` without registering a redirect URI.)
5. **Mint the refresh token** on your own computer (Node 22+, repo checked out):

   ```sh
   GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… node scripts/gmail-oauth-token.mjs
   ```

   Open the printed URL **signed in as the sending Gmail account**, approve
   "Send email on your behalf", and the script prints `GMAIL_REFRESH_TOKEN=…`.
   It requests `access_type=offline&prompt=consent`, so a refresh token is
   returned every run. If you ever need to rotate it, revoke the app at
   <https://myaccount.google.com/permissions> and run the script again.
6. **Put the five values into Vercel** (table above), generate
   `OCAGENT_MAIL_TOKEN` with `openssl rand -hex 32`, redeploy.
7. **Verify without sending:**

   ```sh
   curl -H "Authorization: Bearer $OCAGENT_MAIL_TOKEN" https://ocagent.grok.me/api/mail/send
   # → {"ok":true,"gmail":true,"sender":"shunjie.bi@gmail.com","missing":[]}
   ```

### Sending

From server code (server functions, loaders, the agent's Node side):

```ts
import { sendGmail } from "@/lib/mail/gmail";

const result = await sendGmail({
  to: "friend@example.com",           // or string[] (max 10)
  subject: "Weekly digest",
  text: "Plain-text body (required)",
  html: "<p>Optional HTML alternative</p>",
});
if (!result.ok) console.error(result.code, result.message); // not_configured | invalid_request | send_failed
```

Over HTTP, for the owner's own scripts and automations:

```sh
curl -X POST https://ocagent.grok.me/api/mail/send \
  -H "Authorization: Bearer $OCAGENT_MAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"friend@example.com","subject":"Hello","text":"Sent by ocagent."}'
# → {"ok":true,"id":"<gmail message id>","threadId":"…"}
```

Status codes: `200` sent · `400` invalid body · `401` wrong/missing bearer ·
`404` endpoint disabled (no `OCAGENT_MAIL_TOKEN`) · `503` Gmail secrets missing
· `502` Gmail rejected the send (message explains which secret to re-check).
Bodies are capped at 512 KB and 10 recipients; the subject is header-injection
safe. Nothing in the browser UI can trigger a send, and the agent's LLM steps
have no `Mail` tool yet — adding one should go through an approval effect, not
run unattended.
