let fail msg = failwith msg

let contains hay needle =
  let n = String.length hay and m = String.length needle in
  let rec loop i = i + m <= n && (String.sub hay i m = needle || loop (i + 1)) in
  m = 0 || loop 0

let () =
  let nasty =
    Ocagent_protocol.Fetch.canonical
      (Ocagent_protocol.Fetch.of_parts ~meth:"GET" ~url:"a\t\x00\"中" ~body:"x\\y")
  in
  if Ocagent_protocol.Fetch.has_raw_control nasty then fail "控制字符没有被转义";
  if not (contains nasty "\\u0009") then fail "tab";
  if not (contains nasty "\\u0000") then fail "nul";
  if not (contains nasty "中") then fail "中文";
  if not (contains nasty {|{"body":|}) then fail "键顺序";
  if not (Ocagent_protocol.Fetch.has_raw_control "\t") then fail "原始 tab 应被拒绝";
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
