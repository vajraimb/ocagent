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

M1–M3 are the single-fiber handler stack. M4 adds actors.

A new `Eio.Fiber` does not inherit effect handlers. `Spawn` and `Supervise` install the same stack again inside the child, then the child blocks on an `Eio.Stream` mailbox (`Send` / `Receive` / `Self`). Restart policy is on the supervisor, not the clock: `One_for_one`, `One_for_all`, `Rest_for_one`, and `max_restarts`. Past the budget the child raises `Restart_limit` and the parent supervisor sees a normal crash. Mailboxes survive a restart, so a message sent before the next `Receive` is kept. Evaluation still gives every attempt its own copy of the scripted model responses, and the trajectory has no timestamps.
