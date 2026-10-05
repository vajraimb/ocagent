(** A child fiber does not keep the parent's handlers. A bare fork must
    surface Unhandled. Harness.spawn must install the profile again. *)

module H = Ocagent_harness.Harness
module P = Ocagent_harness.Proto

let fail msg = failwith msg

let () =
  let raw =
    match
      H.scheduler (fun () ->
          ignore
            (Effect.Deep.try_with
               (fun () ->
                 Effect.perform (H.Fork (fun () -> ignore (Effect.perform P.Now : float))))
               ()
               {
                 effc =
                   (fun (type a) (e : a Effect.t) ->
                     match e with
                     | P.Now ->
                         Some
                           (fun (k : (a, _) Effect.Deep.continuation) ->
                             Effect.Deep.continue k 0.)
                     | _ -> None);
               }))
    with
    | () -> "inherited"
    | exception Effect.Unhandled _ -> "dropped"
  in
  if raw <> "dropped" then fail ("裸 fork 不应继承 handler，实际 " ^ raw);
  let installed = ref "missing" in
  let profile thunk =
    ignore
      (Effect.Deep.try_with thunk ()
         {
           effc =
             (fun (type a) (e : a Effect.t) ->
               match e with
               | P.Now ->
                   Some
                     (fun (k : (a, _) Effect.Deep.continuation) ->
                       Effect.Deep.continue k 1.)
               | _ -> None);
         })
  in
  H.scheduler (fun () ->
      H.spawn profile (fun () ->
          let n = Effect.perform P.Now in
          installed := if n = 1. then "installed" else "wrong"));
  if !installed <> "installed" then fail ("spawn 没有重装 handler：" ^ !installed);
  print_endline "drop-handler ok"
