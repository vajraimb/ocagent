type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

module type STEP = sig
  val run : unit -> reply
end

let table : (string, string) Hashtbl.t = Hashtbl.create 16

let install pairs =
  Hashtbl.clear table;
  List.iter (fun (key, value) -> Hashtbl.replace table key value) pairs

module Input = struct
  let get key = Hashtbl.find_opt table key
end

module Net = struct
  type response = { status : int; body : string }
  type error =
    | Approval_rejected of string
    | Denied of string

  let get _url = Error (Denied "not dispatched")
end

module Trace = struct
  let note _message = ()
end
