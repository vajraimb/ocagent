open Effect
open Effect.Deep
open Core.Effects

exception Budget_exceeded of string

let tokens messages =
  List.fold_left (fun n (m : Core.Types.message) -> n + String.length m.content) 0 messages / 4

let with_budget ~max_steps ~max_tokens f =
  let steps = ref 0 in
  let gate k then_ =
    incr steps;
    if !steps > max_steps then
      discontinue k (Budget_exceeded (Printf.sprintf "steps %d/%d" !steps max_steps))
    else then_ ()
  in
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | AskLLM { messages; model } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let used = tokens messages in
                  if used > max_tokens then
                    discontinue k (Budget_exceeded (Printf.sprintf "tokens %d/%d" used max_tokens))
                  else gate k (fun () -> continue k (perform (AskLLM { messages; model }))))
          | CallTool { name; args_json } ->
              Some
                (fun (k : (b, _) continuation) ->
                  gate k (fun () -> continue k (perform (CallTool { name; args_json }))))
          | _ -> None);
    }
