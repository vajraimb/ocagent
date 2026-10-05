type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

module type STEP = sig
  val run : unit -> reply
end

module Input = struct
  let get = Step_bridge.input_get
end

module Net = struct
  type response = Step_bridge.response = { status : int; body : string }

  type error = Step_bridge.error =
    | Approval_rejected of string
    | Denied of string

  let get = Step_bridge.net_get
end

module Trace = struct
  let note = Step_bridge.trace
end
