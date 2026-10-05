(** Map this tree's Fetch onto the shared request codec. *)

open Types

let meth_name = function
  | GET -> "GET"
  | POST -> "POST"

let fetch_wire meth url body =
  Ocagent_protocol.Fetch.canonical (Ocagent_protocol.Fetch.of_parts ~meth:(meth_name meth) ~url ~body)
