open Effect
open Effect.Deep
open Core.Effects
open Core.Types

let dangerous = [ "delete_file"; "deploy" ]

let with_risk_approval ?(dangerous_tools = dangerous) f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | CallTool { name; args_json } when List.mem name dangerous_tools ->
              Some
                (fun (k : (b, _) continuation) ->
                  let action =
                    Printf.sprintf "允许执行高危工具 %s 及其参数 [%s]?" name args_json
                  in
                  perform (EmitTrajectory (ApprovalRequested action));
                  let approved = perform (AskApproval { action; risk_level = "HIGH" }) in
                  if approved then continue k (perform (CallTool { name; args_json }))
                  else continue k (Error "用户拒绝了该高危操作"))
          | _ -> None);
    }

let with_scripted (decisions : bool list) f =
  let queue = ref decisions in
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskApproval _ ->
              Some
                (fun (k : (b, _) continuation) ->
                  match !queue with
                  | [] -> continue k false
                  | bit :: rest ->
                      queue := rest;
                      continue k bit)
          | _ -> None);
    }

let with_auto_deny f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskApproval _ -> Some (fun (k : (b, _) continuation) -> continue k false)
          | _ -> None);
    }
