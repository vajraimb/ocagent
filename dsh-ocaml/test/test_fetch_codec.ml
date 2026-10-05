let () =
  let got = Core.Adapt.fetch_wire Core.Types.GET "http://127.0.0.1/spec" "" in
  let expect =
    Ocagent_protocol.Fetch.canonical
      (Ocagent_protocol.Fetch.of_parts ~meth:"GET" ~url:"http://127.0.0.1/spec" ~body:"")
  in
  if got <> expect then failwith got;
  print_endline "dsh fetch codec ok"
