(** One prepare/provider/commit path for the old durable runner and the step worker. *)

type outcome =
  | Value of Json.t
  | Suspended

type failure =
  | Store of Store.error
  | In_flight
  | Raised of exn

let dispatch ~path executor request ~after_prepare ~provider =
  match try Ok (Store.prepare_operation executor request) with exn -> Error (Raised exn) with
  | Error _ as err -> err
  | Ok (Error err) -> Error (Store err)
  | Ok (Ok (Store.Replay json)) -> Ok (Value json)
  | Ok (Ok Store.Awaiting_approval) -> Ok Suspended
  | Ok (Ok Store.In_flight) -> Error In_flight
  | Ok (Ok (Store.Execute issued)) -> (
      match try Ok (after_prepare ()) with exn -> Error (Raised exn) with
      | Error _ as err -> err
      | Ok () -> (
          match provider () with
          | exception exn -> Error (Raised exn)
          | value -> (
              match try Ok (Store.commit_result path issued value) with exn -> Error (Raised exn) with
              | Error _ as err -> err
              | Ok (Error err) -> Error (Store err)
              | Ok (Ok ()) -> Ok (Value value))))
