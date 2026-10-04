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
```

栈从内到外：`trace → verify → budget → policy → compact → journal → world → strict`。最里层先看见 effect，要执行时再向外 `perform` 一次。`with_strict` 把没人接的 effect 收成 `Harness_error`。子 fiber 不继承这套栈，`Harness.spawn` 会在子 fiber 里重装。

日志是 JSONL。每条 effect 先写 `Pending` 和幂等键，做完写 `Done`。重放时序号对上、请求哈希一致就直接返回记录；哈希变了就报 `Nondeterminism`。`Ask_human` 在进程还活着时可以 `continue` 一次；进程要退出就 `discontinue`，把决定写回那一行，下次从头重放。

```sh
eval $(opam env --switch=5.3.0)
dune runtest
dune exec ./bin/demo.exe
```

仓库根上的 `src/` 是同一套协议的浏览器工作台，给没有 OCaml runtime 的预览用。这里的 `.ml` 才是实现。
