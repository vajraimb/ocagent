let agent prompt () =
  Core.Agent.react ~model:"deepseek-v4"
    ~messages:[ { Core.Types.role = User; content = prompt } ]
    ()

let print_events events =
  List.iter
    (fun ev -> print_endline (Harness.Trajectory.describe ev))
    events

let () =
  let mode = match Array.to_list Sys.argv with _ :: arg :: _ -> arg | _ -> "eval" in
  Eio_main.run @@ fun env ->
  match mode with
  | "dry-run" ->
      let outcome, _ =
        Dsh_ocaml.Runtime.run_harness ~env ~mode:Dsh_ocaml.Runtime.DryRun ~agent_entry:(agent "删掉 notes.txt")
          ()
      in
      print_endline outcome.value;
      print_events outcome.events
  | "sandbox" ->
      let cwd = Eio.Stdenv.cwd env in
      let work = Eio.Path.(cwd / "dsh-sandbox-demo") in
      Eio.Path.mkdirs ~perm:0o700 ~exists_ok:true work;
      Eio.Path.with_subtree work (fun root ->
          Eio.Path.save ~create:(`Or_truncate 0o644) Eio.Path.(root / "note.txt") "inside";
          let clock = Eio.Stdenv.clock env in
          let mgr = Eio.Stdenv.process_mgr env in
          let ran =
            Harness.Trajectory.with_trajectory ~on_event:(fun _ -> ()) (fun () ->
                Harness.Sandbox.with_eio_sandbox ~clock ~cwd:root ~mgr (fun () ->
                    Effect.perform
                      (Core.Effects.SandboxExec { cmd = "echo hello"; timeout_sec = 2. })))
          in
          let escaped =
            Harness.Trajectory.with_trajectory ~on_event:(fun _ -> ()) (fun () ->
                Harness.Sandbox.with_eio_sandbox ~clock ~cwd:root ~mgr (fun () ->
                    Effect.perform
                      (Core.Effects.SandboxExec { cmd = "cat ../note.txt"; timeout_sec = 2. })))
          in
          Printf.printf "echo -> %s\n"
            (match ran with Ok text -> String.trim text | Error text -> "error: " ^ text);
          Printf.printf "escape -> %s\n"
            (match escaped with Ok text -> "UNEXPECTED " ^ text | Error text -> text))
  | "eval" | _ ->
      let responses =
        [
          Core.Types.ToolCallResponse
            [ { id = "1"; name = "shell"; args_json = "echo hello" } ];
          TextResponse "done";
        ]
      in
      let outcome, mock =
        Dsh_ocaml.Runtime.run_harness ~env ~mode:(Evaluation "dsh-eval.jsonl") ~responses
          ~agent_entry:(agent "打个招呼") ()
      in
      Printf.printf "%s\ncommands: %s\n" outcome.value (String.concat " | " (List.rev mock.commands));
      print_events outcome.events
