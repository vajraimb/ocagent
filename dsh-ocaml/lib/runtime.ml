(** Handler stack, inner to outer: budget, approval, tools, sandbox, trajectory, llm, approval sink.
    Trajectory sits outside the sandbox so a sandbox [perform EmitTrajectory] is recorded.
    The spec's [|>] chain does not type-check: each handler returns ['a], not a thunk. *)

open Core.Types

type harness_mode =
  | Production
  | DryRun
  | Evaluation of string

type outcome = {
  value : string;
  events : trajectory_event list;
}

let save_trajectory ~cwd path events =
  match Harness.Sandbox.safe_relative path with
  | Error _ -> ()
  | Ok path ->
      let target = Eio.Path.(cwd / path) in
      Eio.Path.save ~create:(`Or_truncate 0o644) target (Harness.Trajectory.events_json events)

let execute ~sink ~llm ~sandbox ~fs ~on_event ~max_steps ~max_tokens agent_entry =
  let events = ref [] in
  let record ev =
    events := ev :: !events;
    on_event ev
  in
  let value =
    Fun.protect
      ~finally:(fun () -> ())
      (fun () ->
        sink (fun () ->
            llm (fun () ->
                Harness.Trajectory.with_trajectory ~on_event:record (fun () ->
                    sandbox (fun () ->
                        Harness.Sandbox.with_tools ~fs (fun () ->
                            Harness.Approval.with_risk_approval (fun () ->
                                Harness.Budget.with_budget ~max_steps ~max_tokens agent_entry)))))))
  in
  { value; events = List.rev !events }

let run_harness ~env ?(responses = []) ?(approvals = []) ?(max_steps = 16) ?(max_tokens = 8000)
    ?(on_event = fun _ -> ()) ~mode ~agent_entry () =
  let cwd = Eio.Stdenv.cwd env in
  let mock = Harness.Sandbox.empty_mock () in
  let outcome =
    match mode with
    | Evaluation path ->
        let out =
          execute ~sink:(Harness.Approval.with_scripted approvals)
            ~llm:(Harness.Llm_provider.with_mock_llm responses)
            ~sandbox:(Harness.Sandbox.with_mock_sandbox mock)
            ~fs:(Harness.Sandbox.mock_fs mock) ~on_event ~max_steps ~max_tokens agent_entry
        in
        save_trajectory ~cwd path out.events;
        out
    | DryRun ->
        execute ~sink:Harness.Approval.with_auto_deny
          ~llm:
            (Harness.Llm_provider.with_mock_llm
               [
                 ToolCallResponse [ { id = "dry"; name = "delete_file"; args_json = "notes.txt" } ];
                 TextResponse "dry-run：高危操作已拒绝，未执行。";
               ])
          ~sandbox:Harness.Sandbox.with_dry_run_sandbox
          ~fs:
            {
              read = (fun _ -> Ok "dry-run");
              write = (fun _ -> Ok "dry-run");
              delete = (fun _ -> Ok "dry-run");
            }
          ~on_event ~max_steps ~max_tokens agent_entry
    | Production ->
        let clock = Eio.Stdenv.clock env in
        let mgr = Eio.Stdenv.process_mgr env in
        let net = Eio.Stdenv.net env in
        Eio.Path.with_subtree cwd (fun root ->
            let api_key = Option.value (Sys.getenv_opt "DSH_API_KEY") ~default:"" in
            let host = Option.value (Sys.getenv_opt "DSH_API_HOST") ~default:"127.0.0.1" in
            let port =
              match Sys.getenv_opt "DSH_API_PORT" with
              | Some text -> int_of_string text
              | None -> 8080
            in
            let llm =
              if api_key = "" then
                Harness.Llm_provider.with_mock_llm
                  [ TextResponse "未配置 DSH_API_KEY。生产 HTTP 客户端只连明文 http，不假装能打 HTTPS。" ]
              else
                Harness.Llm_provider.with_deepseek_http ~net ~model:"deepseek-v4" ~host ~port
                  ~path:"/chat/completions" ~api_key
            in
            execute ~sink:Harness.Approval.with_auto_deny ~llm
              ~sandbox:(Harness.Sandbox.with_eio_sandbox ~clock ~cwd:root ~mgr)
              ~fs:(Harness.Sandbox.eio_fs root) ~on_event ~max_steps ~max_tokens agent_entry)
  in
  (outcome, mock)
