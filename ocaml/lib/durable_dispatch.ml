(** One prepare/provider/commit path for the old durable runner and the step worker. *)

type outcome =
  | Value of Json.t
  | Suspended

type failure =
  | Store of Store.error
  | In_flight
  | Raised of exn

let dispatch ~path executor request ~after_prepare ~provider =
  match Store.prepare_operation executor request with
  | Error err -> Error (Store err)
  | Ok (Store.Replay json) -> Ok (Value json)
  | Ok Store.Awaiting_approval -> Ok Suspended
  | Ok Store.In_flight -> Error In_flight
  | Ok (Store.Execute issued) -> (
      (try after_prepare () with exn -> raise exn);
      match provider () with
      | exception exn -> Error (Raised exn)
      | value -> (
          match Store.commit_result path issued value with
          | Error err -> Error (Store err)
          | Ok () -> Ok (Value value)))
