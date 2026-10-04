(** Handler stack, inner to outer: budget, approval, tools, sandbox, search, net, trajectory, llm, approval sink.
    Search and net sit outside the tool router, so a tool that [perform]s [Web_search] or [Fetch] is handled.
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

let execute ~sink ~llm ~search ~net ~sandbox ~fs ~on_event ~max_steps ~max_tokens agent_entry =
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
                    net (fun () ->
                        search (fun () ->
                            sandbox (fun () ->
                                Harness.Sandbox.with_tools ~fs (fun () ->
                                    Harness.Approval.with_risk_approval (fun () ->
                                        Harness.Budget.with_budget ~max_steps ~max_tokens agent_entry)))))))))
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
            ~search:Harness.Search.with_offline ~net:Harness.Net.with_offline
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
          ~search:Harness.Search.with_offline ~net:Harness.Net.with_offline
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
            let xai = Option.value (Sys.getenv_opt "XAI_API_KEY") ~default:"" in
            let model = Option.value (Sys.getenv_opt "XAI_MODEL") ~default:"grok-4.7" in
            let api_key = Option.value (Sys.getenv_opt "DSH_API_KEY") ~default:"" in
            let host = Option.value (Sys.getenv_opt "DSH_API_HOST") ~default:"127.0.0.1" in
            let port =
              match Sys.getenv_opt "DSH_API_PORT" with
              | Some text -> int_of_string text
              | None -> 8080
            in
            let llm =
              if xai <> "" then
                Harness.Llm_provider.with_https_chat ~mgr ~endpoint:"https://api.x.ai/v1/chat/completions" ~model
                  ~api_key:xai
              else if api_key = "" then
                Harness.Llm_provider.with_mock_llm
                  [ TextResponse "未配置 XAI_API_KEY。Fetch 仍可访问 http/https，搜索不会假装有结果。" ]
              else
                Harness.Llm_provider.with_deepseek_http ~net ~model:"deepseek-v4" ~host ~port
                  ~path:"/chat/completions" ~api_key
            in
            let search =
              if xai = "" then Harness.Search.with_unconfigured else Harness.Search.with_xai ~mgr ~api_key:xai ~model
            in
            execute ~sink:Harness.Approval.with_auto_deny ~llm ~search ~net:(Harness.Net.with_fetch ~mgr)
              ~sandbox:(Harness.Sandbox.with_eio_sandbox ~clock ~cwd:root ~mgr)
              ~fs:(Harness.Sandbox.eio_fs root) ~on_event ~max_steps ~max_tokens agent_entry)
  in
  (outcome, mock)

type actor_outcome = {
  value : string;
  events : trajectory_event list;
  crashes : (string * string) list;
}

let run_actors ~env ?(responses = []) ?(approvals = []) ?(max_steps = 16) ?(max_tokens = 8000) ~agent_entry
    () =
  ignore env;
  Eio.Switch.run @@ fun sw ->
  let events = ref [] in
  let mock = Harness.Sandbox.empty_mock () in
  let record ev = events := ev :: !events in
  let world = Harness.Actor.create ~on_event:record () in
  let fs = Harness.Sandbox.mock_fs mock in
  let rec stack : 'a. sw:Eio.Switch.t -> self_id:string -> (unit -> 'a) -> 'a =
   fun ~sw ~self_id f ->
    Harness.Approval.with_scripted approvals (fun () ->
        Harness.Llm_provider.with_mock_llm responses (fun () ->
            Harness.Trajectory.with_trajectory ~on_event:record (fun () ->
                Harness.Net.with_offline (fun () ->
                    Harness.Search.with_offline (fun () ->
                        Harness.Sandbox.with_mock_sandbox mock (fun () ->
                            Harness.Sandbox.with_tools ~fs (fun () ->
                                Harness.Approval.with_risk_approval (fun () ->
                                    Harness.Budget.with_budget ~max_steps ~max_tokens (fun () ->
                                        Harness.Actor.with_actor ~world ~sw ~self_id
                                          ~rerun:(fun ~sw ~self_id body -> stack ~sw ~self_id body)
                                          f)))))))))
  in
  let value = stack ~sw ~self_id:"root" agent_entry in
  ( { value; events = List.rev !events; crashes = List.rev !(world.crashes) }, mock )

