module M = Step_manifest

let fail fmt = Printf.ksprintf failwith fmt

let bundle source modules =
  {
    M.source;
    modules;
    compiler_id = "ocaml-5.3.0";
    runtime_id = "ocaml-5.3.0";
    sdk = "sdk-v1";
    driver = "driver-v1";
    artifact = "artifact-bytes";
    base_workspace = "materials";
    input_context = "ctx";
    capability_grant = "files,net.get";
    policy_version = "p0b-1";
  }

let mod_a =
  { M.name = "Helper"; source = "let answer = 1\n"; interface_ = "val answer : int\n"; artifact = "cmx-a" }

let () =
  if M.sha256 "" <> "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" then fail "sha256 empty";
  if M.sha256 "abc" <> "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" then fail "sha256 abc";
  let built =
    match M.build ~run_id:"run" ~step_id:"0" ~step_seq:0 (bundle "let run () = Done \"ok\"\n" [ mod_a ]) with
    | Ok m -> m
    | Error e -> fail "build %s" (M.describe e)
  in
  let record =
    { M.admission_key = "adm"; manifest = built; state = M.Prepared; reply = None; final_workspace = None; error = None }
  in
  let text = M.canonical_record record in
  (match M.parse_record text with
  | Ok got when got.manifest.execution_hash = built.execution_hash && got.manifest.step_seq = 0 -> ()
  | Ok _ -> fail "round trip changed the hash"
  | Error e -> fail "parse %s" (M.describe e));
  let reordered = "{ \"z\": 1, \"a\": [2, 1] }" in
  let reordered_b = "{\"a\":[2,1],\"z\":1}" in
  (match (M.parse reordered, M.parse reordered_b) with
  | Ok a, Ok b when M.canonical a = M.canonical b -> ()
  | Ok a, Ok b -> fail "key order %s vs %s" (M.canonical a) (M.canonical b)
  | _ -> fail "reordered parse");
  (match (M.parse "{\"a\":[1,2]}", M.parse "{\"a\":[2,1]}") with
  | Ok a, Ok b when M.canonical a <> M.canonical b -> ()
  | _ -> fail "array order was ignored");
  List.iter
    (fun bad ->
      match M.parse bad with
      | Error _ -> ()
      | Ok _ -> fail "accepted %S" bad)
    [
      "{\"a\":1,\"a\":2}";
      "1.5";
      "9007199254740992";
      "-9007199254740992";
      "01";
      "+1";
      "{\"a\":1,}";
    ];
  let tricky = "中\t\"\x00" in
  let encoded = M.canonical (M.String tricky) in
  (match M.parse encoded with
  | Ok (M.String got) when got = tricky -> ()
  | Ok _ -> fail "control round trip changed %S" encoded
  | Error e -> fail "control %s (%s)" (M.describe e) encoded);
  let other =
    match M.build ~run_id:"run" ~step_id:"0" ~step_seq:0 (bundle "let run () = Done \"no\"\n" [ mod_a ]) with
    | Ok m -> m
    | Error e -> fail "other %s" (M.describe e)
  in
  if other.execution_hash = built.execution_hash then fail "source change did not change the hash";
  let swapped_mods =
    match
      M.build ~run_id:"run" ~step_id:"0" ~step_seq:0
        (bundle "let run () = Done \"ok\"\n"
           [
             mod_a;
             { M.name = "Other"; source = "let x = 2\n"; interface_ = "val x : int\n"; artifact = "cmx-b" };
           ])
    with
    | Ok m -> m
    | Error e -> fail "mods %s" (M.describe e)
  in
  let reversed =
    match
      M.build ~run_id:"run" ~step_id:"0" ~step_seq:0
        (bundle "let run () = Done \"ok\"\n"
           [
             { M.name = "Other"; source = "let x = 2\n"; interface_ = "val x : int\n"; artifact = "cmx-b" };
             mod_a;
           ])
    with
    | Ok m -> m
    | Error e -> fail "rev %s" (M.describe e)
  in
  if swapped_mods.execution_hash = reversed.execution_hash then fail "module order was ignored";
  (match M.build ~run_id:"run" ~step_id:"0" ~step_seq:0 (bundle "x" [ { mod_a with name = "../Secret" } ]) with
  | Error (M.Bad_module _) -> ()
  | Ok _ -> fail "path escape accepted"
  | Error e -> fail "escape %s" (M.describe e));
  print_endline "step manifest ok"
