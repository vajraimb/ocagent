(** The agent only performs. It does not call Unix, Random, or any SDK.
    [Fun.protect] releases the probe on a normal return or on [discontinue].
    A dropped continuation (kill -9) does not run it. *)

let version = "swe-agent@0.1"

type published =
  | Skipped
  | Yes
  | Rejected

type result = {
  ok : bool;
  attempts : int;
  stamp : string;
  now : float;
  published : published;
  diagnostics : string list;
}

let system = "你是一个只通过 effect 行动的 OCaml 补丁 agent。"

let swe ~probe prompt =
  Fun.protect ~finally:(fun () -> probe := true) @@ fun () ->
  let stamp = Effect.perform Proto.Fresh_id in
  let now = Effect.perform Proto.Now in
  Effect.perform (Proto.Checkpoint "start");
  let history =
    ref
      [ { Proto.role = "system"; content = system }; { Proto.role = "user"; content = prompt } ]
  in
  let plan =
    Effect.perform (Proto.Llm { purpose = "plan"; messages = !history })
  in
  history := !history @ [ { Proto.role = "assistant"; content = plan.text } ];
  let read =
    Effect.perform
      (Proto.Tool
         {
           call_id = "read-math";
           name = "read_file";
           args = Json.Assoc [ ("path", Json.String World.math_path) ];
         })
  in
  history := !history @ [ { Proto.role = "tool"; content = read.output } ];
  let diagnostics = ref [] in
  let attempts = ref 0 in
  let ok = ref false in
  while !attempts < 3 && not !ok do
    attempts := !attempts + 1;
    let purpose = if !attempts = 1 then "patch" else "retry" in
    let note = match !diagnostics with [] -> "写补丁" | ds -> String.concat "\n" ds in
    let reply =
      Effect.perform
        (Proto.Llm
           {
             purpose;
             messages = !history @ [ { Proto.role = "user"; content = note } ];
           })
    in
    let args =
      match reply.tool with
      | Some (_, args) -> args
      | None ->
          Json.Assoc
            [ ("path", Json.String World.math_path); ("content", Json.String reply.text) ]
    in
    let wrote =
      Effect.perform
        (Proto.Tool
           { call_id = Printf.sprintf "patch-%d" !attempts; name = "apply_patch"; args })
    in
    diagnostics := wrote.diagnostics;
    if wrote.ok then ok := true else history := !history @ [ { Proto.role = "tool"; content = wrote.output } ]
  done;
  let published =
    if Proto.contains prompt "发布" then
      let shell =
        Effect.perform
          (Proto.Tool
             {
               call_id = "publish";
               name = "shell";
               args = Json.Assoc [ ("cmd", Json.String "dune build && publish") ];
             })
      in
      if shell.ok then Yes else Rejected
    else Skipped
  in
  Effect.perform (Proto.Checkpoint "done");
  { ok = !ok; attempts = !attempts; stamp; now; published; diagnostics = !diagnostics }
