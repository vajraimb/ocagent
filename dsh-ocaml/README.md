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
| `Production` | Eio subtree of the process cwd, plus shell policy that rejects `..` and absolute paths. HTTP only if `DSH_API_KEY` is set. |

HTTP is plaintext `POST` on `Eio.Net` (`DSH_API_HOST`, `DSH_API_PORT`, default `127.0.0.1:8080`, path `/chat/completions`). There is no TLS client, so this does not call `api.deepseek.com`. SSE `data:` lines are parsed. `stream` is sent as `false`.

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
