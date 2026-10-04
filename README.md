# OCAGENT

OCaml 5 的 effect harness，在 [`ocaml/`](ocaml/)。

Agent 只 `perform`。环境是 handler 栈。进程崩了以后靠 JSONL 日志重放，continuation 存不进去，也只能恢复一次。

```sh
cd ocaml
eval $(opam env --switch=5.3.0)
dune runtest
```

`src/` 是浏览器里的同一套协议演示。验收以 `ocaml/test/test_harness.ml` 为准。
