open Core.Types

let agent prompt () =
  Core.Agent.react ~model:"deepseek-v4"
    ~messages:[ { Core.Types.role = User; content = prompt } ]
    ()

let print_events events =
  List.iter
    (fun ev -> print_endline (Harness.Trajectory.describe ev))
    events

let shorten text =
  let text = String.trim text in
  if String.length text <= 500 then text else String.sub text 0 500 ^ "…"

let usage () =
  prerr_endline "usage: main.exe eval | dry-run | sandbox | actors | fetch URL | search QUERY";
  exit 2

let () =
  let args = match Array.to_list Sys.argv with _ :: rest -> rest | [] -> [] in
  Eio_main.run @@ fun env ->
  match args with
  | "fetch" :: [] | "search" :: [] -> usage ()
  | "fetch" :: url :: _ ->
      let mgr = Eio.Stdenv.process_mgr env in
      let reply =
        Harness.Net.with_fetch ~mgr (fun () ->
            Effect.perform (Core.Effects.Fetch { meth = GET; url; body = "" }))
      in
      (match reply with
      | Ok { status; body } ->
          Printf.printf "HTTP %d\n%s\n" status (shorten body);
          if status < 200 || status >= 300 then exit 1
      | Error text ->
          prerr_endline text;
          exit 1)
  | "search" :: query ->
      let query = String.concat " " query in
      let api_key = Option.value (Sys.getenv_opt "XAI_API_KEY") ~default:"" in
      let model = Option.value (Sys.getenv_opt "XAI_MODEL") ~default:"grok-4.7" in
      let mgr = Eio.Stdenv.process_mgr env in
      let answer =
        Harness.Search.with_xai ~mgr ~api_key ~model (fun () ->
            Effect.perform (Core.Effects.Web_search { query; limit = 5 }))
      in
      (match answer with
      | Ok found ->
          print_endline (shorten found.text);
          List.iter (fun hit -> Printf.printf "- %s\n  %s\n" hit.title hit.url) found.hits
      | Error text ->
          prerr_endline text;
          exit 1)
  | "dry-run" :: _ ->
      let outcome, _ =
        Dsh_ocaml.Runtime.run_harness ~env ~mode:Dsh_ocaml.Runtime.DryRun ~agent_entry:(agent "删掉 notes.txt")
          ()
      in
      print_endline outcome.value;
      print_events outcome.events
  | "sandbox" :: _ ->
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
  | "actors" :: _ ->
      let report, mock =
        Dsh_ocaml.Runtime.run_actors ~env
          ~responses:
            [
              ToolCallResponse [ { id = "1"; name = "shell"; args_json = "echo from-worker" } ];
              TextResponse "worker ok";
            ]
          ~agent_entry:(fun () ->
            ignore
              (Effect.perform
                 (Core.Effects.Spawn
                    {
                      name = "worker";
                      max_restarts = 1;
                      body =
                        (fun () ->
                          let text =
                            Core.Agent.react ~model:"deepseek-v4"
                              ~messages:[ { role = User; content = "work" } ]
                              ()
                          in
                          Effect.perform (Core.Effects.Send { to_ = "root"; body = text }));
                    }));
            (Effect.perform Core.Effects.Receive).body)
          ()
      in
      Printf.printf "%s\ncommands: %s\n" report.value (String.concat " | " (List.rev mock.commands));
      print_events report.events
  | _ ->
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
