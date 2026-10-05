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
