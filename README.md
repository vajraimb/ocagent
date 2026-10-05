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

`test_chain` 覆盖一条链路：读材料、模型给出方案、请求审批、进程退出、新进程从 JSONL 恢复、在沙箱里执行 Fetch、完成。恢复时已记录的 Llm 不再进入 world；Fetch 只执行一次；再跑一遍时 world 日志为空。

`test_faults` 覆盖：结果标成 Unknown 时不重做、审批回调来第二次被拒绝、审批参数变了就报 Nondeterminism 且不执行 Fetch、旧 worker 的不同结果不能覆盖 Done、JSONL 尾部截断被拒绝。

这些测试没有覆盖多进程选举，也没有覆盖「副作用也许已经发生、但日志仍是 Pending」的自动补救。Pending 仍会再执行一次。

```sh
eval $(opam env --switch=5.3.0)
dune runtest --root .
```

`src/` 是浏览器里的 journal harness 演示。验收以 `dune runtest` 为准。
