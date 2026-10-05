(** Trusted inside the worker image. User source is rejected if it names this module. *)

type response = { status : int; body : string }

type error =
  | Approval_rejected of string
  | Denied of string

type _ Effect.t += Net_get : string -> (response, error) result Effect.t

let table : (string, string) Hashtbl.t = Hashtbl.create 16

let install pairs =
  Hashtbl.clear table;
  List.iter (fun (key, value) -> Hashtbl.replace table key value) pairs

let input_get key = Hashtbl.find_opt table key

let trace_fn = ref (fun (_message : string) -> ())

let set_trace fn = trace_fn := fn

let trace message =
  let message = if String.length message > 1024 then String.sub message 0 1024 else message in
  !trace_fn message

let net_get url = Effect.perform (Net_get url)
