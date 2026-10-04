# OCAGENT

两套 OCaml 5 effect harness，浏览器里只演示第一套的协议。

- [`ocaml/`](ocaml/) — journal replay。continuation 存不进去，恢复靠 JSONL 重放。
- [`dsh-ocaml/`](dsh-ocaml/) — Eio 沙箱、预算、高危审批、mock 评测，以及 Fiber actor / OTP 监督树。子 fiber 不继承 handler，拉起时把栈装回去。

```sh
cd ocaml && eval $(opam env --switch=5.3.0) && dune runtest
cd dsh-ocaml && eval $(opam env --switch=5.3.0) && dune runtest
```

`src/` 是浏览器里的 journal harness 演示。验收以各自的 `dune runtest` 为准。
