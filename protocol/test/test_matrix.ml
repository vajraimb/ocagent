let fail msg = failwith msg

let () =
  let need tree name =
    match Ocagent_protocol.covered tree name with
    | [] -> fail ("missing " ^ name)
    | rows ->
        List.iter
          (fun row -> if row.Ocagent_protocol.handler = "" then fail ("empty handler " ^ name))
          rows
  in
  List.iter (need Ocagent_protocol.Ocagent) [ "Llm"; "Tool"; "Ask_human"; "Fetch"; "Compact" ];
  List.iter (need Ocagent_protocol.Dsh) [ "AskLLM"; "Fetch"; "AskApproval"; "Spawn" ];
  let fetch = Ocagent_protocol.covered Ocagent_protocol.Ocagent "Fetch" in
  if not (List.exists (fun row -> row.Ocagent_protocol.profile = "Prod") fetch) then fail "prod fetch";
  print_endline "matrix ok"
