(** T1/T2: validate, compile, and admit a real bytecode artifact.
    The worker is not started past the driver's refusal. *)

module C = Ocagent_harness.Step_compile
module S = Ocagent_harness.Store
module M = Step_manifest

let fail fmt = Printf.ksprintf failwith fmt

let () =
  match Array.to_list Sys.argv with
  | [ _; "--grandchild"; path ] ->
      let pid = Unix.getpid () in
      let pgid = C.getpgid pid in
      let oc = open_out path in
      Printf.fprintf oc "%d %d\n" pid pgid;
      close_out oc;
      if Unix.fork () = 0 then Unix.sleep 30;
      exit 0
  | _ -> ()

let read_all path =
  let ic = open_in_bin path in
  let buf = Buffer.create 64 in
  let bytes = Bytes.create 64 in
  Fun.protect ~finally:(fun () -> close_in ic) (fun () ->
      let rec go () =
        match input ic bytes 0 64 with
        | 0 -> Buffer.contents buf
        | n ->
            Buffer.add_subbytes buf bytes 0 n;
            go ()
      in
      go ())

let alive pid = Sys.file_exists ("/proc/" ^ string_of_int pid)

let helper =
  {
    C.name = "Helper";
    source = "let valid material body =\n  let xs = [| material |] in\n  Array.set xs 0 body;\n  String.equal (Array.get xs 0) body\n";
    interface_ = "val valid : string -> string -> bool\n";
  }

let step =
  {|open Step_api

module Step : STEP = struct
  let run () =
    match Input.get "material", Input.get "fetch_url" with
    | Some material, Some url -> (
        match Net.get url with
        | Ok r when r.status = 200 && Helper.valid material r.body -> Done "validated"
        | Ok _ -> Partial "validation failed"
        | Error (Net.Approval_rejected reason) -> Done reason
        | Error (Net.Denied reason) -> Done reason)
    | _ -> Partial "missing fixed input"
end
|}

let fresh () =
  let dir = Filename.temp_dir "ocagent-admit" "" in
  Filename.concat dir "snapshot.json"

let compile_ok () =
  match C.compile ~source:step ~modules:[ helper ] ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ] with
  | Ok artifact -> artifact
  | Error err -> fail "compile %s" (C.describe err)

let vnum () =
  let ic = Unix.open_process_args_in "ocamlc" [| "ocamlc"; "-vnum" |] in
  Fun.protect ~finally:(fun () -> ignore (Unix.close_process_in ic)) (fun () -> String.trim (input_line ic))

let () =
  let expected = vnum () in
  Unix.putenv "OCAMLLIB" "/no/such/ocagent-lib";
  Unix.putenv "OCAMLPATH" "/no/such/ocagent-path";
  let channel =
    {|open Step_api
module Step : STEP = struct
  let run () =
    let buf = Buffer.create 8 in
    Buffer.add_channel buf stdin 1;
    Done (Buffer.contents buf)
end
|}
  in
  (match C.compile ~source:channel ~modules:[] ~input:[] with
  | Error (C.Rejected msg) when String.starts_with ~prefix:"forbidden value" msg -> ()
  | Ok _ -> fail "channel operation was compiled"
  | Error err -> fail "channel %s" (C.describe err));
  let standard_in =
    {|open Step_api
module Step : STEP = struct
  let run () = ignore Stdlib.stdin; Done "x"
end
|}
  in
  (match C.compile ~source:standard_in ~modules:[] ~input:[] with
  | Error (C.Rejected msg) when String.starts_with ~prefix:"forbidden value" msg -> ()
  | Ok _ -> fail "stdin was compiled"
  | Error err -> fail "stdin %s" (C.describe err));
  let reject_unsafe name source =
    match C.compile ~source ~modules:[] ~input:[] with
    | Error (C.Rejected msg) when String.starts_with ~prefix:"forbidden value" msg -> ()
    | Ok _ -> fail "%s was compiled" name
    | Error err -> fail "%s %s" name (C.describe err)
  in
  reject_unsafe "qualified"
    {|open Step_api
module Step : STEP = struct
  let run () = ignore (Stdlib.Array.unsafe_set [| 0 |] 0 1); Done "x"
end
|};
  reject_unsafe "alias"
    {|open Step_api
module A = Array
module Step : STEP = struct
  let run () = ignore (A.unsafe_get [| 0 |] 0); Done "x"
end
|};
  reject_unsafe "open"
    {|open Step_api
module Step : STEP = struct
  open Array
  let run () = ignore (unsafe_get [| 0 |] 0); Done "x"
end
|};
  reject_unsafe "higher-order"
    {|open Step_api
module Step : STEP = struct
  let call f = f [| 0 |] 0
  let run () = ignore (call Array.unsafe_get); Done "x"
end
|};
  let huge_source = String.make 262145 'a' in
  let huge_compile = fresh () in
  let t0 = Unix.gettimeofday () in
  (match
     C.submit ~path:huge_compile ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" ~source:huge_source ~modules:[]
       ~input:[]
   with
  | Error (C.Rejected "too big") -> ()
  | Ok _ -> fail "oversized source reached compilation"
  | Error err -> fail "oversized compile %s" (C.describe err));
  if Unix.gettimeofday () -. t0 > 2. then fail "oversized source was parsed";
  if Sys.file_exists huge_compile then fail "oversized source created a snapshot";
  let quoted = String.make 129 '(' in
  let commented =
    Printf.sprintf
      {|open Step_api
module Step : STEP = struct
  let run () =
    let text = "%s" in
    (* %s *)
    ignore text;
    Done "x"
end
|}
      quoted quoted
  in
  (match C.compile ~source:commented ~modules:[] ~input:[ ("notes", quoted) ] with
  | Ok _ -> ()
  | Error err -> fail "quoted parens %s" (C.describe err));
  let rec begun n = if n = 0 then "Done \"x\"" else "begin " ^ begun (n - 1) ^ " end" in
  let deep =
    "open Step_api\nmodule Step : STEP = struct\n let run () = " ^ begun 40 ^ "\nend\n"
  in
  (match C.compile ~source:deep ~modules:[] ~input:[] with
  | Ok _ -> ()
  | Error (C.Rejected _ | C.Unavailable _) -> ()
  | Error err -> fail "deep %s" (C.describe err));
  let step_state events =
    let rec go state count = function
      | [] -> state, count
      | event :: rest -> (
          let state, action = C.collector_step state event in
          match action with
          | C.Reap -> go state (count + 1) rest
          | C.Failed "collector" -> fail "collector reaped twice"
          | _ -> go state count rest)
    in
    go { C.reaped = None; eof = false; length = 0 } 0 events
  in
  let _, reaps = step_state [ C.Would_block; C.Reaped (Unix.WEXITED 0); C.Pipe_eof ] in
  if reaps <> 1 then fail "reap count %d" reaps;
  let state, _ = step_state [ C.Pipe_eof; C.Reaped (Unix.WEXITED 0) ] in
  if (not state.C.eof) || state.reaped = None then fail "eof-first state";
  let state, _ = step_state [ C.Reaped (Unix.WEXITED 0); C.Output 3; C.Pipe_eof ] in
  if state.C.length <> 3 || state.reaped = None then fail "exit-first dropped output";
  let _, action = C.collector_step { C.reaped = None; eof = false; length = max_int / 2 } (C.Output 262144) in
  (match action with C.Failed "compiler output" -> () | _ -> fail "output limit was accepted");
  let sleep_started = Unix.gettimeofday () in
  let sleep_pid, sleep_pgid, sleep_result = C.command ~timeout:0.4 [| "/bin/sleep"; "30" |] in
  (match sleep_result with
  | Ok _ -> fail "sleeping command returned"
  | Error _ -> if Unix.gettimeofday () -. sleep_started > 2. then fail "probe wait exceeded the deadline");
  if alive sleep_pid || alive sleep_pgid then fail "timed-out process is still running";
  let hand = Filename.temp_file "ocagent-hand" "" in
  let hold_started = Unix.gettimeofday () in
  let _, _, hold = C.command ~timeout:0.4 [| Sys.argv.(0); "--grandchild"; hand |] in
  (match hold with Ok _ -> fail "grandchild returned" | Error _ -> ());
  if Unix.gettimeofday () -. hold_started > 2. then fail "grandchild held the pipe";
  let hand_text = read_all hand in
  let child_pid, child_pgid =
    Scanf.sscanf hand_text "%d %d" (fun pid pgid -> (pid, pgid))
  in
  if alive child_pid || alive child_pgid then fail "grandchild process group is still running";
  Unix.unlink hand;
  let fault_path = fresh () in
  let fault name setup =
    match
      C.submit_fault setup ~path:fault_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" ~source:step ~modules:[ helper ]
        ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
    with
    | Error (C.Unavailable msg) ->
        if Sys.file_exists fault_path then fail "%s wrote a snapshot" name;
        if msg = "" then fail "%s had an empty status" name
    | Ok _ -> fail "%s executed" name
    | Error err -> fail "%s %s" name (C.describe err)
  in
  fault "rlimit" C.Rlimit;
  fault "fd" C.Descriptors;
  fault "isolation" C.Isolation;
  let tools =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
    | Ok tools -> tools
    | Error err -> fail "hold %s" (C.describe err)
  in
  let sentinel = Filename.temp_file "ocagent-sentinel" "" in
  let oc = open_out sentinel in
  output_string oc "secret";
  close_out oc;
  let host_secret = read_all sentinel in
  if host_secret <> "secret" then fail "host sentinel unreadable";
  let listen = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.bind listen (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen listen 1;
  let port = match Unix.getsockname listen with Unix.ADDR_INET (_, port) -> port | _ -> fail "port" in
  let client = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.connect client (Unix.ADDR_INET (Unix.inet_addr_loopback, port));
  let accepted, _ = Unix.accept ~cloexec:true listen in
  ignore (Unix.write accepted (Bytes.of_string "ok") 0 2);
  Unix.close accepted;
  Unix.close client;
  (match C.probe_isolation tools ~sentinel ~port with
  | Ok () -> ()
  | Error err -> fail "isolation %s" (C.describe err));
  let waiting, _, _ = Unix.select [ listen ] [] [] 0.2 in
  if waiting <> [] then fail "isolated probe reached the listener";
  Unix.close listen;
  Unix.unlink sentinel;
  let saved_path = Sys.getenv "PATH" in
  let saved_cwd = Sys.getcwd () in
  let prefix = Filename.temp_dir "ocagent-prefix" "" in
  let bindir = Filename.concat prefix "bin" in
  Unix.mkdir bindir 0o700;
  let find_on path name =
    let rec go = function
      | [] -> fail "missing %s" name
      | dir :: rest ->
          let candidate = Filename.concat dir name in
          if Sys.file_exists candidate then candidate else go rest
    in
    go (String.split_on_char ':' path)
  in
  let real_ocamlc = Unix.realpath (find_on saved_path "ocamlc") in
  let real_ocamlrun = Unix.realpath (Filename.concat (Filename.dirname real_ocamlc) "ocamlrun") in
  Unix.symlink real_ocamlc (Filename.concat bindir "ocamlc");
  Unix.symlink real_ocamlrun (Filename.concat bindir "ocamlrun");
  Sys.chdir prefix;
  Unix.putenv "PATH" "bin";
  let pinned =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
    | Ok tools -> tools
    | Error err -> fail "relative toolchain %s" (C.describe err)
  in
  Unix.unlink (Filename.concat bindir "ocamlc");
  let oc = open_out (Filename.concat bindir "ocamlc") in
  output_string oc "not-a-compiler";
  close_out oc;
  Sys.chdir saved_cwd;
  Unix.putenv "PATH" saved_path;
  (match C.compile_with ~setup_fault:None ~deadline:(Unix.gettimeofday () +. 20.) pinned ~source:step ~modules:[ helper ] ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ] with
  | Ok _ -> ()
  | Error err -> fail "snapshot compile %s" (C.describe err));
  C.release pinned;
  C.release tools;
  if not (C.toolchain_acceptable ~compiler:"5.3.0" ~runtime:"5.3.0") then fail "supported pair rejected";
  if C.toolchain_acceptable ~compiler:"5.3.0" ~runtime:"5.4.0" then fail "mismatched pair accepted";
  if C.toolchain_acceptable ~compiler:"4.14.2" ~runtime:"4.14.2" then fail "old pair accepted";
  let absent = fresh () in
  (match C.compile ~source:"let run () = 1\n" ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "type error was compiled"
  | Error err -> fail "type error %s" (C.describe err));
  if Sys.file_exists absent then fail "rejected compile created a snapshot";
  let init =
    {|open Step_api
module Step : STEP = struct
  let warm = Input.get "material"
  let run () = Partial "no"
end
|}
  in
  (match C.compile ~source:init ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "initialization was compiled"
  | Error err -> fail "init %s" (C.describe err));
  let unix_alias =
    {|open Step_api
module U = Unix
module Step : STEP = struct
  let run () = ignore (U.gettimeofday ()); Done "x"
end
|}
  in
  (match C.compile ~source:unix_alias ~modules:[] ~input:[] with
  | Error (C.Rejected msg) when String.starts_with ~prefix:"forbidden module" msg -> ()
  | Error (C.Rejected msg) -> fail "alias rejected as %s" msg
  | Ok _ -> fail "Unix alias was compiled"
  | Error err -> fail "alias %s" (C.describe err));
  let higher =
    {|open Step_api
module Step : STEP = struct
  let call f = f ()
  let run () = ignore (call Unix.gettimeofday); Done "x"
end
|}
  in
  (match C.compile ~source:higher ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "higher-order Unix was compiled"
  | Error err -> fail "higher %s" (C.describe err));
  let extension = "[%%not_supported]\n" in
  (match C.compile ~source:extension ~modules:[] ~input:[] with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "extension was compiled"
  | Error err -> fail "extension %s" (C.describe err));
  let artifact = compile_ok () in
  let path = fresh () in
  let manifest =
    match C.admit ~path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" artifact with
    | Ok manifest -> manifest
    | Error err -> fail "admit %s" (C.describe err)
  in
  let compiler_id, runtime_id =
    match C.toolchain () with
    | Ok ids -> ids
    | Error err -> fail "toolchain %s" (C.describe err)
  in
  if manifest.compiler_id <> compiler_id || manifest.runtime_id <> runtime_id then fail "toolchain id was not bound";
  if not (String.starts_with ~prefix:("ocamlc " ^ expected ^ " manifest ") compiler_id) then
    fail "compiler id %s does not use probed %s" compiler_id expected;
  if not (String.starts_with ~prefix:("ocamlrun " ^ expected ^ " manifest ") runtime_id) then
    fail "runtime id %s does not use probed %s" runtime_id expected;
  let bytes =
    match S.read_blob ~path ~hash:manifest.artifact_hash ~kind:S.Artifact with
    | Ok bytes -> bytes
    | Error err -> fail "read artifact %s" (S.describe err)
  in
  if bytes = "" || (not (String.starts_with ~prefix:"#!" bytes)) || not (String.exists (fun c -> c = 'C') bytes) then
    fail "artifact is not bytecode";
  if M.sha256 bytes <> manifest.artifact_hash then fail "artifact hash does not match the stored bytes";
  let worker = Filename.temp_file "ocagent-worker" "" in
  let oc = open_out_bin worker in
  output_string oc bytes;
  close_out oc;
  let pid = Unix.create_process "ocamlrun" [| "ocamlrun"; worker |] Unix.stdin Unix.stdout Unix.stderr in
  let _, status = Unix.waitpid [] pid in
  Unix.unlink worker;
  (match status with
  | Unix.WEXITED 2 -> ()
  | _ -> fail "bytecode did not stop before Step.run");
  let before = S.file_bytes path in
  let epoch = (match S.read_snapshot path with Ok snap -> snap.epoch | Error err -> fail "snap %s" (S.describe err)) in
  (match S.preflight ~path ~execution_hash:manifest.execution_hash ~compiler_id ~runtime_id with
  | Ok S.Ready -> ()
  | Ok (S.Stored _) -> fail "prepared step looked completed"
  | Error err -> fail "preflight %s" (S.describe err));
  let blob = S.read_blob ~path ~hash:manifest.artifact_hash ~kind:S.Artifact in
  let blob_path =
    match blob with
    | Ok _ ->
        let dir = Filename.concat (Filename.dirname path) "step-blobs" in
        Filename.concat dir manifest.artifact_hash
    | Error err -> fail "blob %s" (S.describe err)
  in
  Unix.unlink blob_path;
  (match S.preflight ~path ~execution_hash:manifest.execution_hash ~compiler_id ~runtime_id with
  | Error S.Artifact_missing -> ()
  | Ok _ -> fail "missing artifact was ready"
  | Error err -> fail "missing %s" (S.describe err));
  if S.file_bytes path <> before then fail "missing artifact rewrote the snapshot";
  let epoch2 = match S.read_snapshot path with Ok snap -> snap.epoch | Error err -> fail "snap2 %s" (S.describe err) in
  if epoch2 <> epoch then fail "missing artifact changed the epoch";
  let huge = String.make 262145 'a' in
  let huge_path = fresh () in
  let bundle =
    {
      M.source = huge;
      modules = [];
      compiler_id = "ocamlc";
      runtime_id = "ocamlrun";
      sdk = "sdk";
      driver = "driver";
      artifact = "artifact-bytes";
      base_workspace = "";
      input_context = "{}";
      capability_grant = "net";
      policy_version = "p";
    }
  in
  (match S.admit_step ~path:huge_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" bundle with
  | Error (S.Protocol "too big") -> ()
  | Ok _ -> fail "oversized source was admitted"
  | Error err -> fail "oversize %s" (S.describe err));
  if Sys.file_exists huge_path then fail "oversized source wrote a snapshot";
  let shared = String.make 300000 'x' in
  let shared_path = fresh () in
  (match
     S.admit_step ~path:shared_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm"
       { bundle with M.source = shared; artifact = shared }
   with
  | Error (S.Protocol "too big") -> ()
  | Ok _ -> fail "source reused the artifact size limit"
  | Error err -> fail "shared size %s" (S.describe err));
  if Sys.file_exists shared_path then fail "shared source wrote a snapshot";
  let binary = String.make 300000 '\x00' in
  let binary_path = fresh () in
  (match
     S.admit_step ~path:binary_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm"
       { bundle with M.source = "let run () = Done \"ok\"\n"; artifact = binary }
   with
  | Ok manifest ->
      let stored =
        match S.read_blob ~path:binary_path ~hash:manifest.artifact_hash ~kind:S.Artifact with
        | Ok stored -> stored
        | Error err -> fail "binary read %s" (S.describe err)
      in
      if stored <> binary then fail "binary artifact was not stored whole";
      let workspace = M.sha256 "ws" in
      (match
         S.with_step_executor ~path:binary_path ~execution_hash:manifest.execution_hash (fun ex ->
             S.complete_step ex ~cursor:0 ~reply:(M.Done "done") ~workspace_hash:workspace)
       with
      | Ok (S.Resumed ()) -> ()
      | Ok (S.Stored_completion _) -> fail "first completion looked stored"
      | Error err -> fail "complete %s" (S.describe err));
      let blob_path = Filename.concat (Filename.concat (Filename.dirname binary_path) "step-blobs") manifest.artifact_hash in
      Unix.unlink blob_path;
      let closed = S.file_bytes binary_path in
      (match S.preflight ~path:binary_path ~execution_hash:manifest.execution_hash ~compiler_id:"gone" ~runtime_id:"gone" with
      | Ok (S.Stored { reply = M.Done "done"; workspace = got }) when got = workspace -> ()
      | Ok _ -> fail "completed query changed the reply"
      | Error err -> fail "completed query %s" (S.describe err));
      if S.file_bytes binary_path <> closed then fail "completed query wrote the snapshot"
  | Error err -> fail "binary admit %s" (S.describe err));
  print_endline "step compile ok"
