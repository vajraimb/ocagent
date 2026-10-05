(** Map this tree's Fetch onto the shared request codec. *)

let fetch_wire url =
  Ocagent_protocol.Fetch.canonical (Ocagent_protocol.Fetch.of_parts ~meth:"GET" ~url ~body:"")
