(* Linked last. No coordinator channel in this batch, so the saved program
   stops before Step.run and does not open a socket or the store. *)
let () = exit 2
