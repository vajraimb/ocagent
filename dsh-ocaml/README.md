# dsh-ocaml

OCaml 5.3 effect harness. The agent only `perform`s. Approval, budget, trajectory, sandbox and the model client are handlers.

```
budget → risk approval → tool router → sandbox → trajectory → llm → approval sink
```

Trajectory sits outside the sandbox, so a sandbox `EmitTrajectory` is recorded. The spec's `|>` chain does not type-check: each handler returns `'a`, not a thunk.

| Mode | What it does |
|---|---|
| `Evaluation path` | Scripted model and approvals, mock sandbox, JSONL trajectory at `path`. No clock, so the file is byte-stable. |
| `DryRun` | Auto-deny. Dangerous tools return `Error "用户拒绝了该高危操作"` and nothing is executed. |
| `Production` | Eio subtree of the process cwd, plus shell policy that rejects `..` and absolute paths. `Fetch` uses curl for http and https. `Web_search` calls `https://api.x.ai/v1/responses` when `XAI_API_KEY` is set. Plaintext `AskLLM` remains only for `DSH_API_KEY` pointed at a loopback chat server. |

HTTP to the model is no longer plaintext-only. `Fetch` and `AskLLM` over HTTPS go through curl (`--proto =http,https`). The bearer token is written to a `0600` curl config and removed afterwards. There is still no OCaml TLS stack in this switch.

Search is an effect, same as the other capabilities. Evaluation and dry-run install an offline handler, so tests do not touch the network.

```ocaml
Eio_main.run @@ fun env ->
  let mgr = Eio.Stdenv.process_mgr env in
  let api_key = Sys.getenv "XAI_API_KEY" in
  Harness.Net.with_fetch ~mgr (fun () ->
    Harness.Search.with_xai ~mgr ~api_key ~model:"grok-4.7" (fun () ->
      let page =
        Effect.perform
          (Core.Effects.Fetch { meth = GET; url = "https://ocaml.org/"; body = "" })
      in
      let found =
        Effect.perform (Core.Effects.Web_search { query = "OCaml Eio"; limit = 5 })
      in
      ignore (page, found)))
```

```sh
dune exec ./bin/main.exe fetch https://ocaml.org/
dune exec ./bin/main.exe search OCaml Eio
```

The agent can also call them as tools: `fetch` and `search` / `web_search`. A search spends an xAI request. Without `XAI_API_KEY` the handler returns an error instead of inventing hits.


Dangerous tools are `delete_file` and `deploy`. An approval re-performs `CallTool` outside the approval handler, so a yes does not loop. A no does not touch the file.

```sh
cd dsh-ocaml
eval $(opam env --switch=5.3.0)
dune runtest
dune exec ./bin/main.exe eval
dune exec ./bin/main.exe dry-run
dune exec ./bin/main.exe sandbox
dune exec ./bin/main.exe actors
```

M1–M3 是单 fiber 的 handler 栈。M4 加了 actor。

新的 `Eio.Fiber` 不继承 effect handler。`test_drop_handler` 在父 fiber 里装了 `AskApproval`，子 fiber 直接 `perform`，得到的是 Unhandled。`Spawn` 和 `Supervise` 会在子 fiber 里把整套栈再装一次，然后子 fiber 才在 `Eio.Stream` 邮箱上阻塞（`Send` / `Receive` / `Self`）。监督策略在 supervisor 上，不在时钟上：`One_for_one`、`One_for_all`、`Rest_for_one`，以及 `max_restarts`。超过预算后子 fiber 抛 `Restart_limit`，父 supervisor 看到的是一次普通崩溃。邮箱在重启后还在，所以下一次 `Receive` 之前发出的消息会留下。评测里每一次尝试仍有自己的一份脚本化模型回答，轨迹里没有时间戳。

各 profile 的 handler 对照在仓库根的 [`protocol/`](../protocol/)。`Fetch` 的请求字节也走那里的 codec，和 `ocaml/` 的 GET 是同一串。Evaluation 和 DryRun 的 `Fetch` / `Web_search` 是离线 handler。


