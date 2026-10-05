module P = Ocagent_protocol.Policy

let fail fmt = Printf.ksprintf failwith fmt

let round p =
  match P.of_name (P.name p) with
  | Ok got when got = p -> ()
  | Ok got -> fail "%s decoded as %s" (P.name p) (P.name got)
  | Error msg -> fail "%s rejected: %s" (P.name p) msg

let () =
  List.iter round
    [
      P.Workspace_transactional;
      P.Provider_idempotent;
      P.Reconcile;
      P.Manual_only;
      P.Read_retryable 0;
      P.Read_retryable 1;
      P.Read_retryable 3;
      P.Read_retryable 9;
      P.Read_retryable 12;
      P.Read_retryable 20;
      P.Read_retryable 100;
    ];
  (match P.of_name "Read_retryable:12" with
  | Ok (P.Read_retryable 12) -> ()
  | Ok other -> fail "12 became %s" (P.name other)
  | Error msg -> fail "12 rejected: %s" msg);
  List.iter
    (fun bad ->
      match P.of_name bad with
      | Error _ -> ()
      | Ok p -> fail "accepted %S as %s" bad (P.name p))
    [ ""; "nope"; "Read_retryable:"; "Read_retryable:-1"; "Read_retryable:+1"; "Read_retryable:101"; "Read_retryable:01"; "Read_retryable:1x"; "Read_retryable: 1"; " Read_retryable:1" ];
  print_endline "policy ok"
