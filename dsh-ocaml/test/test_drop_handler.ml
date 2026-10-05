(** A raw Eio fiber does not see the parent's effect handlers. *)

open Core.Effects

let fail fmt = Printf.ksprintf failwith fmt

let () =
  Eio_main.run @@ fun _env ->
    let seen = ref "missing" in
    Eio.Switch.run @@ fun sw ->
      let parent () =
        Eio.Fiber.fork ~sw (fun () ->
            match
              (try
                 ignore
                   (Effect.perform (AskApproval { action = "delete"; risk_level = "HIGH" }) : bool);
                 Ok ()
               with
               | Effect.Unhandled _ -> Error "dropped"
               | exn -> Error (Printexc.to_string exn))
            with
            | Ok () -> seen := "inherited"
            | Error reason -> seen := reason);
        Eio.Fiber.yield ()
      in
      Effect.Deep.try_with parent ()
        {
          effc =
            (fun (type a) (e : a Effect.t) ->
              match e with
              | AskApproval _ ->
                  Some
                    (fun (k : (a, _) Effect.Deep.continuation) ->
                      Effect.Deep.continue k true)
              | _ -> None);
        };
    if !seen <> "dropped" then fail "子 fiber 看到了父 handler：%s" !seen;
    print_endline "dsh drop-handler ok"
