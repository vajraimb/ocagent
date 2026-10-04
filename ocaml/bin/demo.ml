(** Run the swe agent once under the eval profile and print the journal. *)

let () =
  let probe = ref false in
  let session =
    Ocagent_harness.Harness.run ~profile:Ocagent_harness.Harness.Eval ~run_id:"demo" ~probe
      (fun () ->
        Ocagent_harness.Agent.swe ~probe "把 src/math.ml 里的 add 改成加法")
  in
  let result = session.result in
  (match result.status with
  | Ocagent_harness.Harness.Done value ->
      Printf.printf "ok=%b attempts=%d stamp=%s published=%s\n" value.ok value.attempts value.stamp
        (match value.published with
        | Ocagent_harness.Agent.Skipped -> "skipped"
        | Ocagent_harness.Agent.Yes -> "yes"
        | Ocagent_harness.Agent.Rejected -> "rejected")
  | Ocagent_harness.Harness.Failed error ->
      Printf.printf "failed: %s\n" (Ocagent_harness.Harness.describe error)
  | Ocagent_harness.Harness.Suspended -> Printf.printf "suspended\n"
  | Ocagent_harness.Harness.Crashed { seq; window } ->
      Printf.printf "crashed seq=%d %s\n" seq window);
  print_endline (Ocagent_harness.Journal.to_jsonl result.journal)
