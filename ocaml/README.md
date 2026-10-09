# ocagent-harness

OCaml 5 effect harness. Agent 代码只 `perform`。Dev、Eval、Prod 是三套 handler。崩溃之后重放日志，不保存 continuation。

```ocaml
type _ Effect.t +=
  | Llm        : llm_request -> llm_response Effect.t
  | Tool       : tool_call   -> tool_result Effect.t
  | Ask_human  : approval    -> decision Effect.t
  | Checkpoint : string      -> unit Effect.t
  | Compact    : msg list    -> msg list Effect.t
  | Now        : float Effect.t
  | Fresh_id   : string Effect.t
  | Fetch      : fetch_request -> fetch_reply Effect.t
```

栈从内到外：`trace → verify → budget → policy → compact → journal → world → strict`。最里层先看见 effect，要执行时再向外 `perform` 一次。`with_strict` 把没人接的 effect 收成 `Harness_error`。子 fiber 不继承这套栈。`test_drop_handler` 检查裸 fork 得到 Unhandled，`Harness.spawn` 在子 fiber 里重装之后才接得住。

哪个 profile 装了哪个 handler，以仓库根上的 [`protocol/`](../protocol/) 为准。Eval 没有 policy 和 compact。`Fetch` 的请求字节由 `protocol` 的 codec 决定，和 `dsh-ocaml` 的 GET 请求是同一串。Prod 里若没有安装 `World.fetch`，世界只返回固定字符串；`test_process_recover` 才把这个钩子接到本机 HTTP。


日志是 JSONL。每条 effect 先写 `Pending` 和幂等键，做完写 `Done`。`Unknown` 表示结果不清楚：重放既不把旧值当答案，也不再执行一次。截断的尾部整份拒绝。相同的迟到结果可以忽略；不同的结果不能覆盖已经 `Done` 的一行。`Ask_human` 在进程还活着时可以 `continue` 一次；进程要退出就 `discontinue`，把决定写回那一行，下次从头重放。

```sh
eval $(opam env --switch=5.3.0)
dune runtest
dune exec ./bin/demo.exe
```

仓库根上的 `src/` 是同一套协议的浏览器工作台，给没有 OCaml runtime 的预览用。这里的 `.ml` 才是实现。

## 工作台里的循环：谁负责什么

网页工作台跑的循环是 **`assets/ocaml/bin/ocagent.ml`**——一份 OCaml 源码，由随包的字节码顶层以脚本方式执行（`ocamlrun ocaml ocagent.ml <job> <result>`），所以改它不需要编译器。它只是一个薄执行器：

- **循环脚本**：每轮把"任务 + 自己的 Trace 笔记 + 上一次编译错误"交给 Node 当提示（Node 再加上指令和其余上下文），拿回模型回复，抽出 `ocaml` 代码块交给 `runStep`，把这一步的 effect 日志折进 journal。它**从不自己判断任务做没做完**：只在交回来的一步说 Done / Ask / Partial、同一步原样重复、或模型连续三轮不给代码时结束。它看不到工作区文件，不管时间，不装 harness，不改 modules。桥接只有两个调用：`model` 和 `ocaml`。
- **Node（`src/lib/agent/run.ts`）**：拥有每轮的 prompt 上下文（文件清单、上一步的返回、编译失败的代码、计划勾选状态、剩余时间）、时间预算与分段（`OCAGENT_RUN_BUDGET_MS`）、跨实例的停止标志、把过程写进数据库的进度日志，以及**收尾前核对**：写过文件的运行第一次 `Done` 会被改成 `Continue` 再给一轮；同一步里有 `Check.*` 断言且全部通过（或读回了写出的文件）的 `Done` 直接放行；有断言没通过的 `Done` 也会被拦回去（最多再一次），提示里列出没通过的几条并让模型先修（或 `Files.restore`）；再拦不住的，答案末尾会标出哪几条没通过。
- **预算的边界**：一段的预算（默认 70 秒）到点时，正在飞的模型调用或步骤不会被当场杀掉，而是再给 `BUDGET_GRACE_MS`（30 秒）跑完，这一轮的步骤照常执行，下一次要模型时才暂停（`budgetHit`）；剩余时间不足 `MIN_ROUND_MS`（20 秒，短预算下取预算的 1/3）就不再开新一轮。宽限也用完才真的切断，这时的 `model_error` 事件带 `budget: true`，页面显示「这一段时间用完了，这轮没等到回复」而不是「模型没有回应」，下一段的提示是【上一轮没跑完】。每轮的首末事件时间差显示在时间线的收尾行上（「继续下一轮 · 38 秒」）。
- **Step API 里的 `Check`**：`Check.that cond "说明"`、`Check.equal 期望 实际 "说明"`、`Check.contains "path" "内容"`，都返回 bool 并写一行 effect（`通过` / `没通过：…`），时间线上以绿盾 / 红盾显示。
- **Step API 里的 `Files.restore`**：退回任务开始时的版本。`runStep` 在一个文件**第一次**被改时记下它改前的内容（`hooks.onOrigin`，存在运行行的 `plan.origin`，总量封顶 256 KB），下一步起把这些原件放进步骤目录的 `ocagent_origin/`（不存在的文件记在 `ocagent_origin_absent`），`restore` 就是从那里复制回来或删掉。
- **占位符检测（`missingInput`）**：任务里有「我的名字 / 城市 / 生日 …」而答案或这步写出的文件里出现占位（`<名字>`、`your_name`、`某某`、`XXX`、"改成参数"……），且笔记、之前的对话、任务本身都没提供这件事，`Done` 会被改写成 `Ask`（`patchFrame`），时间线上多一行「结果里用了占位……改成问你」，运行以「等你回答」结束，用户下一句话按原有的 Ask 续接逻辑处理。
- **服务器端续跑**：一段因时间用完而暂停、且这一段有进展时（`carriesOn`，最多 `MAX_SEGMENTS = 10` 段），`runSegment` 结束前通过 `drive.server.ts` 向自己的公网地址 `POST /api/agent/continue`（Vercel 上用 `waitUntil` 保活），由 `driveNextSegment` 以一条原子更新 `claimSegment`（`where status='paused' and segment=…`）认领下一段。页面不再自己接力，只轮询观看；`pollRun` 在本实例的段结束后改读数据库行，所以别的实例在跑也看得到；若约 8 秒内没人接（`CARRY_GRACE_MS`），页面才自己调 `continueRun`——谁先认领谁跑，另一个只会看到「在跑」。第 10/10 段的每轮提示换成收尾版（`promptContext`：先 `Trace.note` 记下做到哪、`Plan.tick` 打勾，再 Done / Partial，不开新活）；暂停的答案由 `pauseNote` 补上下文——自动接着做（第 k/10 段）、到上限先停（笔记和计划里有进度，「接着做」再续一段，或拆成新任务）、还是这一段没做出任何事所以不自动续。到上限后用户点「接着做」仍可一段一段续。
- **装 harness** 只有一条路：步骤里的 `Harness.load / install / unload`，走 `ocaml-run.ts` 的桥接，由 Node 验证、编译、记录（`onModule` / `onUnload`），运行结果里的 modules 由 `mergeModules` 合出。
- **Step API 里的 `Plan`**（`ocaml-run.ts` 的前导）：`Plan.set [...]` / `Plan.tick n "结果"` 只是写进 effect 日志的两行，由 Node 解析成清单、附回下一轮提示并推给页面；循环脚本对它一无所知。
- **Step API 里的 `Memory`**：同样只是 effect 日志（`Memory.remember "…"` / `Memory.forget n`）。Node 把它们合并进工作区的 `notes`（数据库 `desks.notes`），之后这个工作区的每一个任务的提示都带【记住的】；页面的「它记住的」可以删。
- **Step API 里的 `Schedule`**（`schedule.ts`、`migrations/0004_schedules.sql`）：`Schedule.daily "08:00" "要做的事"`（默认北京时间，可写 `"08:00 Asia/Tokyo"`）/ `Schedule.cancel n` 也只是 effect 日志，前导里只校验时间格式和任务长度。Node 把 `Ok` 的登记变成 `schedule` 事件（页面上「定下了：每天 08:00」），段结束后 `applyScheduleEvents` 写进 `schedules` 表（每个工作区最多 5 条，同时间同任务不重复），之后每轮提示都带【定时任务】清单。到点由 `runDueSchedules` 启动一次 `trigger='schedule'` 的运行（提示里多一段【这是定时任务】，不问用户问题），`claimSchedule` 用一条 `where next_at = 到期时间` 的更新把它挪到下一天，所以日 cron（`vercel.json`：`0 0 * * *` UTC = 08:00 北京）、有人打开工作区时的唤醒（`drive.server.ts` 的 `kickSchedules`，每实例每分钟至多一次）和外部 ping（`GET/POST /api/agent/cron`，设了 `CRON_SECRET` 要带 Bearer）同时来也只跑一次。Hobby 计划的 cron 一天只准一次，所以不是 08:00 北京时间的任务要靠有人打开页面或外部 ping 才会准点；页面在下次到点后和回到前台时会重新读工作区，把定时跑出来的运行接进对话。任务要定时而这一次没有登记的 `Done` 会被 `beyondReach` 改成 Partial 并说明；提醒、后台常驻、私聊仍然做不到，Done 会被同样改写；「发消息」只有真的 `Notify.send` 成功才算做成。
- **Step API 里的 `Json`、`Files.replace` / `append`、`Net.post`**：`Json.get / items / keys` 是前导里的纯 OCaml 解析器（会跳过 `Net.get` 返回开头的 HTTP 行），让"请求 → 取字段 → 再请求"在一步里做完；`Files.replace path 旧 新` 做局部修改而不是整份重写；`Net.post` 走桥接的 `net_post`（`net.ts` 的 `postPublic`，JSON 体按 JSON 发，不跟随跳转）。`Net.get` 的网页正文按约 4000 字一页给（`PAGE_CHARS`，末尾注明「第 1/9 页 … Net.page url 2 看下一页」），`Net.page url n` 走桥接的 `net_page`，从十分钟内的页面缓存里翻页而不重新请求（`net.ts` 的 `Fetched` 缓存，24 条）；API 数据超长时末尾注明被截断。桥接给步骤的 Net / Search 返回最多 16k 字，提示里只显示头尾。
- **桥接的临时文件**：步骤里每次桥接调用用 `ocagent_…in` 临时文件传参，用完即删；`isScratchFile` 再把早先漏进工作区的 `ocagentXXXX.in(.out)` 过滤掉。
- **对话与笔记的边界**：循环的 journal / memory 是**一个任务**的笔记和续跑点——新任务从空开始（`startRun` 传空 journal），之前的任务以【之前的对话】（最近几次的任务与回答，`historyFor`）附在提示里。
- **Step API 里的 `Notify`**（`notify.ts`、`migrations/0005_desk_notify.sql`）：工作区面板的「通知」填一个 webhook 地址（飞书 / 钉钉 / 企业微信 / Slack / Discord，按主机名识别并组装各自的消息体，`checkNotifyUrl` 走和 `Net` 一样的公网校验，可「发一条试试」），存进 `desks.notify_url`。步骤里 `Notify.send "文字"` 走桥接的 `notify`：没填地址返回 `Error`，对方不收（飞书 / 钉钉 / 企业微信 200 里带 code）也算失败并带原因；成功 / 失败都是 `notify` 事件（不是 effect 行），时间线显示「发到了飞书」或「没发到飞书 · 原因」，收起时脚注有一枚「已发到…」的标签。定时任务的运行**彻底**结束（done / failed / 到上限的 paused，不含自动续跑）时，`runSegment.finish` 自动把 `scheduleSummary`（时间 · 结论 · 结果前 600 字 · 工作区链接）发到这个地址，事件带 `auto: true`。页面另外记住看过的运行（`localStorage` 的 `SEEN_KEY`），没看过的定时结果在对话上方有一条横幅、气泡旁有「新」标。
- **工作区文件的预览**（`markdown.ts`、`file-preview.tsx`）：Markdown 解析成树后用 React 渲染（不走 innerHTML），SVG / HTML 放进 `sandbox=""` 的 iframe 并先剥掉 `<script>` 和 `on*=` 属性，CSV 画成表格，JSON 缩进显示；每种都可以切回源码。上传的 SVG 当文本保存，不再被当图片压缩。
- **数据库（`migrations/0002_desks_runs.sql`、`store.server.ts`）**：工作区文件 / harness / 模块 / journal 和每次运行的事件是持久的；浏览器只拿一个工作区 id，刷新或换设备都能接回去。

以前这里是一个预编译的字节码 `ocagent`（源码 `agent.ml`），带着一套早期的工具调用和"按任务里的词挑 `.ml` 装成 harness"的逻辑：写出新 `.ml` 就自己结束（答案 `已写下 X.ml`）、任务提到 "harness" 又没挑到文件就在答案后补 `没有加载成 harness。`。沙箱里没有编译器，这些行为只能在 Node 侧绕；现在二进制、旧源码和那些绕法都删掉了，循环就是上面这份脚本。

早期的 `durable-run.tsx` / `durable-api.ts` / `durable.server.ts` / `budget.ts` 那一簇"持久网关"已经没有任何引用，也删掉了。

因此调整"什么时候停、每轮给模型看什么、一段最多跑多久"改 `run.ts`；改循环本身改 `ocagent.ml`，保持 job / result 文件格式和步骤帧格式不变（`ok\n<kind>\n…` / `fail\n…`），`run-loop.test.ts` 里有用真实运行时跑它的测试。
