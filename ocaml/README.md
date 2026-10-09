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

网页工作台跑的是 `assets/ocaml/bin/ocagent`（bytecode，源码 `agent.ml`，需要 OCaml 5.3 才能重新编译，沙箱里没有编译器）。它只是一个薄执行器：

- **二进制**：按轮次读模型回复，抽出 `ocaml` 代码块交给 `runStep`，收集 `Trace.note`，判断"模型答完了 / 轮数到了"。它看不到工作区文件，也不管时间。
- **Node（`src/lib/agent/run.ts`）**：拥有每轮的 prompt 上下文（文件清单、上一步的返回、编译失败的代码、计划勾选状态、剩余时间）、时间预算与分段（`OCAGENT_RUN_BUDGET_MS`）、跨实例的停止标志、把过程写进数据库的进度日志，以及**收尾前核对**：写过文件的运行第一次 `Done` 会被改成 `Continue` 再给一轮，让模型读回文件或算一个已知值核对；核对过的 `Done` 原样放行。
- **Step API 里的 `Plan`**（`ocaml-run.ts` 的前导）：`Plan.set [...]` / `Plan.tick n "结果"` 只是写进 effect 日志的两行，由 Node 解析成清单、附回下一轮提示并推给页面；二进制对它一无所知。
- **Step API 里的 `Memory`**：同样只是 effect 日志（`Memory.remember "…"` / `Memory.forget n`）。Node 把它们合并进工作区的 `notes`（数据库 `desks.notes`），之后这个工作区的每一个任务的提示都带【记住的】；页面的「它记住的」可以删。
- **Step API 里的 `Json`、`Files.replace` / `append`、`Net.post`**：`Json.get / items / keys` 是前导里的纯 OCaml 解析器（会跳过 `Net.get` 返回开头的 HTTP 行），让"请求 → 取字段 → 再请求"在一步里做完；`Files.replace path 旧 新` 做局部修改而不是整份重写；`Net.post` 走桥接的 `net_post`（`net.ts` 的 `postPublic`，JSON 体按 JSON 发，不跟随跳转）。桥接给步骤的 Net / Search 返回最多 16k 字，提示里只显示头尾。
- **桥接的临时文件**：步骤里每次桥接调用用 `ocagent_…in` 临时文件传参，用完即删；`isScratchFile` 再把早先漏进工作区的 `ocagentXXXX.in(.out)` 过滤掉。
- **对话与笔记的边界**：二进制的 journal / memory 是**一个任务**的笔记和续跑点——新任务从空开始（`startRun` 传空 journal），之前的任务以【之前的对话】（最近几次的任务与回答，`historyFor`）附在提示里。
- **数据库（`migrations/0002_desks_runs.sql`、`store.server.ts`）**：工作区文件 / harness / 模块 / journal 和每次运行的事件是持久的；浏览器只拿一个工作区 id，刷新或换设备都能接回去。

因此调整"什么时候停、每轮给模型看什么、一段最多跑多久"改 `run.ts` 即可，不需要重编 `agent.ml`。重编二进制时请保持它的 stdin/stdout 帧格式不变（`ok\n<kind>\n…` / `fail\n…`）。
