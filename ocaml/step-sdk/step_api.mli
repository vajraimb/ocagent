type reply =
  | Continue of string
  | Done of string
  | Ask of string
  | Partial of string

module type STEP = sig
  val run : unit -> reply
end

module Input : sig
  val get : string -> string option
end

module Net : sig
  type response = { status : int; body : string }
  type error =
    | Approval_rejected of string
    | Denied of string

  val get : string -> (response, error) result
end

module Trace : sig
  val note : string -> unit
end
