(** T1/T2: validate, compile, and admit a real bytecode artifact.
    The worker is not started past the driver's refusal. *)

module C = Ocagent_harness.Step_compile
module S = Ocagent_harness.Store
module M = Step_manifest

let fail fmt = Printf.ksprintf failwith fmt

let () =
  let listed =
    "\tlinux-vdso.so.1 (0x01)\n\
     \tlibzstd.so.1 => /usr/lib/libzstd.so.1 (0x02)\n\
     \tlibc.so.6 => /usr/lib/libc.so.6 (0x03)\n\
     \t/lib64/ld-linux-x86-64.so.2 (0x04)\n\
     \tlibzstd.so.1 => /usr/lib/libzstd.so.1 (0x05)\n"
  in
  (match C.loader_dependencies listed with
  | Ok paths when List.length paths = 3 && List.assoc "libzstd.so.1" paths = "/usr/lib/libzstd.so.1" -> ()
  | _ -> fail "dynamic dependencies were not preserved");
  (match C.loader_dependencies "libmissing.so.1 => not found\n" with
  | Error (C.Unavailable _) -> ()
  | _ -> fail "unresolved dependency was accepted");
  (match C.loader_dependencies "libx.so => /first/libx.so (0x1)\nlibx.so => /second/libx.so (0x2)\n" with
  | Error (C.Unavailable _) -> ()
  | _ -> fail "conflicting dependency was accepted");
  let message = C.compiler_diagnostic "compiler execution exited 127: OK" "libzstd.so.1: cannot open shared object file\n" in
  if not (String.ends_with ~suffix:"libzstd.so.1: cannot open shared object file" message) then
    fail "loader stderr was lost";
  if String.length (C.compiler_diagnostic "exec" (String.make 1000 'x')) <> 506 then
    fail "compiler diagnostic was not bounded"

let () =
  match Array.to_list Sys.argv with
  | [ _; "--grandchild"; path ] ->
      let pid = Unix.getpid () in
      let pgid = C.getpgid pid in
      let oc = open_out path in
      Printf.fprintf oc "%d %d\n" pid pgid;
      close_out oc;
      if Unix.fork () = 0 then (
        let oc = open_out_gen [ Open_wronly; Open_append ] 0o600 path in
        Printf.fprintf oc "%d\n" (Unix.getpid ());
        close_out oc;
        Unix.sleep 30);
      exit 0
  | [ _; "--spam" ] ->
      output_string stdout (String.make 300000 'x');
      flush stdout;
      exit 0
  | [ _; "--byte-gate-cold" ] ->
      (* A fresh process with no compiler cannot acquire or clone a toolchain.
         Rejection must precede that stage, not merely finish within two seconds. *)
      Unix.putenv "PATH" "/no/such/ocagent-byte-gate-toolchain";
      let dir = Filename.temp_dir "ocagent-byte-gate" "" in
      let path = Filename.concat dir "snapshot.json" in
      let huge = String.make 262145 '(' in
      let small = "open Step_api\nmodule Step : STEP = struct let run () = Done \"x\" end\n" in
      let reject name source modules input =
        (match C.submit ~path ~run_id:"r" ~agent_version:"v" ~admission_key:"a" ~source ~modules ~input with
        | Error (C.Rejected "too big") -> ()
        | Error err -> fail "%s reached a later stage: %s" name (C.describe err)
        | Ok _ -> fail "%s was accepted" name);
        if Array.length (Sys.readdir dir) <> 0 then fail "%s wrote admission files" name
      in
      reject "source" huge [] [];
      reject "module source" small [ { C.name = "Helper"; source = huge; interface_ = "" } ] [];
      reject "interface" small [ { C.name = "Helper"; source = ""; interface_ = huge } ] [];
      reject "input key" small [] [ (huge, "") ];
      reject "input value" small [] [ ("k", huge) ];
      (match C.submit_hang ~budget:0. ~path ~run_id:"r" ~agent_version:"v" ~admission_key:"a"
               ~source:huge ~modules:[] ~input:[] with
      | Error (C.Rejected "too big") -> ()
      | _ -> fail "submit_hang bypassed the cheap gate");
      (* Positive control: a small request really does reach unavailable tools. *)
      (match C.compile ~source:small ~modules:[] ~input:[] with
      | Error (C.Unavailable "ocamlc") -> ()
      | _ -> fail "missing toolchain control");
      Unix.rmdir dir;
      print_endline "cold byte gate ok";
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

let proc_fields text =
  match String.rindex_opt text ')' with
  | None -> None
  | Some index -> (
      let rest = String.trim (String.sub text (index + 1) (String.length text - index - 1)) in
      match String.split_on_char ' ' rest with
      | state :: _ppid :: group :: _ -> Some (state, int_of_string group)
      | _ -> None)

let running pid =
  match proc_fields (try read_all ("/proc/" ^ string_of_int pid ^ "/stat") with _ -> "") with
  | Some ("Z", _) -> false
  | Some _ -> true
  | None -> false

let live_group_members pgid =
  Array.fold_left
    (fun count name ->
      match int_of_string_opt name with
      | None -> count
      | Some _ -> (
          try
            match proc_fields (read_all ("/proc/" ^ name ^ "/stat")) with
            | Some (state, group) when group = pgid && state <> "Z" -> count + 1
            | _ -> count
          with _ -> count))
    0
    (Sys.readdir "/proc")

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
  let gate = Unix.create_process Sys.argv.(0) [| Sys.argv.(0); "--byte-gate-cold" |]
      Unix.stdin Unix.stdout Unix.stderr in
  (match Unix.waitpid [] gate with
  | _, Unix.WEXITED 0 -> ()
  | _ -> fail "cold byte gate failed");
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
  (match
     C.submit ~path:huge_compile ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" ~source:huge_source ~modules:[]
       ~input:[]
   with
  | Error (C.Rejected "too big") -> ()
  | Ok _ -> fail "oversized source reached compilation"
  | Error err -> fail "oversized compile %s" (C.describe err));
  if Sys.file_exists huge_compile then fail "oversized source created a snapshot";
  (* Even direct callers with an already-held toolchain must not enter the
     validator. Its injected setup failure and expired deadline must not win. *)
  let tools =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 30.) with
    | Ok tools -> tools
    | Error err -> fail "gate toolchain %s" (C.describe err)
  in
  Fun.protect ~finally:(fun () -> C.release tools) (fun () ->
      match C.compile_with ~setup_fault:(Some C.Isolation) ~hang:true ~deadline:0. tools
              ~source:huge_source ~modules:[] ~input:[] with
      | Error (C.Rejected "too big") -> ()
      | _ -> fail "direct compile_with entered validation for oversized source");
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
  | Error err -> fail "deep %s" (C.describe err));
  let hang_path = fresh () in
  let hang_started = Unix.gettimeofday () in
  (match
     C.submit_hang ~budget:0.4 ~path:hang_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" ~source:step ~modules:[ helper ]
       ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
   with
  | Error (C.Rejected "compile timeout") when Unix.gettimeofday () -. hang_started < 2. && not (Sys.file_exists hang_path) -> ()
  | Ok _ -> fail "hung validator was admitted"
  | Error err -> fail "hang %s" (C.describe err));
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
  let spam_pid, _, spam = C.command ~timeout:2. [| Sys.argv.(0); "--spam" |] in
  (match spam with Error (C.Rejected "compiler output") -> () | Ok _ -> fail "spam was accepted" | Error err -> fail "spam %s" (C.describe err));
  if alive spam_pid then fail "spam process is still running";
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
  let child_pid, child_pgid, grandchild =
    Scanf.sscanf hand_text "%d %d\n%d" (fun pid pgid grand -> (pid, pgid, grand))
  in
  if alive child_pid || running grandchild || live_group_members child_pgid <> 0 then fail "grandchild process group is still running";
  Unix.unlink hand;
  let fault_path = fresh () in
  let fault name setup expect =
    match
      C.submit_fault setup ~path:fault_path ~run_id:"run" ~agent_version:"step-v3" ~admission_key:"adm" ~source:step ~modules:[ helper ]
        ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
    with
    | Error (C.Unavailable msg) when String.starts_with ~prefix:expect msg ->
        if Sys.file_exists fault_path then fail "%s wrote a snapshot" name
    | Ok _ -> fail "%s executed" name
    | Error err -> fail "%s %s" name (C.describe err)
  in
  fault "rlimit" C.Rlimit "rlimit 13";
  fault "fd" C.Descriptors "fd 13";
  fault "isolation" C.Isolation "snapshot_bind ";
  let tools =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
    | Ok tools -> tools
    | Error err -> fail "hold %s" (C.describe err)
  in
  let bare =
    {|open Step_api
module Step : STEP = struct
  let run () = Done "x"
end
|}
  in
  let later name skip setup expect =
    match
      C.compile_fault_after skip setup ~deadline:(Unix.gettimeofday () +. 40.) tools ~source:bare ~modules:[] ~input:[]
    with
    | Error (C.Unavailable msg) when String.starts_with ~prefix:expect msg -> ()
    | Error (C.Rejected "fallback") -> fail "%s reused an exec marker" name
    | Ok _ -> fail "%s executed" name
    | Error err -> fail "%s %s" name (C.describe err)
  in
  later "second rlimit" 2 C.Rlimit "rlimit 13";
  later "second fd" 2 C.Descriptors "fd 13";
  later "second mount" 2 C.Isolation "snapshot_bind ";
  later "cmt rlimit" 6 C.Rlimit "rlimit 13";
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
  let udp = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_DGRAM 0 in
  Unix.bind udp (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  let udp_port = match Unix.getsockname udp with Unix.ADDR_INET (_, port) -> port | _ -> fail "udp" in
  let udp_client = Unix.socket ~cloexec:true Unix.PF_INET Unix.SOCK_DGRAM 0 in
  Unix.connect udp_client (Unix.ADDR_INET (Unix.inet_addr_loopback, udp_port));
  ignore (Unix.write udp_client (Bytes.of_string "hi") 0 2);
  Unix.close udp_client;
  (match C.probe_isolation tools ~sentinel ~tcp_port:port ~udp_port with
  | Ok () -> ()
  | Error err -> fail "isolation %s" (C.describe err));
  (match C.probe_landlock ~work:(Filename.dirname sentinel) ~snap:(Filename.dirname sentinel) ~sentinel ~tcp_port:port ~udp_port with
  | Error (C.Unavailable msg) when String.starts_with ~prefix:"landlock" msg || String.starts_with ~prefix:"FAIL landlock" msg -> ()
  | Ok () -> fail "partial landlock was accepted as the contract"
  | Error err -> fail "landlock %s" (C.describe err));
  Unix.close listen;
  Unix.close udp;
  Unix.unlink sentinel;
  let saved_path = Sys.getenv "PATH" in
  let saved_cwd = Sys.getcwd () in
  let prefix = Filename.temp_dir "ocagent-prefix" "" in
  let bindir = Filename.concat prefix "bin" in
  let libdir = Filename.concat prefix "lib/ocaml" in
  Unix.mkdir bindir 0o700;
  Unix.mkdir (Filename.concat prefix "lib") 0o700;
  Unix.mkdir libdir 0o700;
  let find_on path name =
    let rec go = function
      | [] -> fail "missing %s" name
      | dir :: rest ->
          let candidate = Filename.concat dir name in
          if Sys.file_exists candidate then candidate else go rest
    in
    go (String.split_on_char ':' path)
  in
  let copy_bytes src dst =
    let ic = open_in_bin src in
    let bytes = Fun.protect ~finally:(fun () -> close_in ic) (fun () -> really_input_string ic (in_channel_length ic)) in
    let oc = open_out_bin dst in
    Fun.protect ~finally:(fun () -> close_out oc) (fun () -> output_string oc bytes);
    Unix.chmod dst (Unix.stat src).st_perm
  in
  let real_ocamlc = Unix.realpath (find_on saved_path "ocamlc") in
  let real_root = Filename.dirname (Filename.dirname real_ocamlc) in
  let real_lib = Filename.concat real_root "lib/ocaml" in
  copy_bytes real_ocamlc (Filename.concat bindir "ocamlc.real");
  copy_bytes (Unix.realpath (Filename.concat (Filename.dirname real_ocamlc) "ocamlrun")) (Filename.concat bindir "ocamlrun");
  Unix.symlink "ocamlc.real" (Filename.concat bindir "ocamlc");
  Array.iter
    (fun name ->
      let src = Filename.concat real_lib name in
      if Sys.file_exists src && not (Sys.is_directory src) then
        let skip =
          Filename.check_suffix name ".o" || Filename.check_suffix name ".a" || Filename.check_suffix name ".cmx"
          || Filename.check_suffix name ".cmxa" || Filename.check_suffix name ".cmxs"
        in
        if not skip then copy_bytes src (Filename.concat libdir name))
    (Sys.readdir real_lib);
  Sys.chdir prefix;
  Unix.putenv "PATH" "bin";
  let pinned =
    match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
    | Ok tools -> tools
    | Error err -> fail "relative toolchain %s" (C.describe err)
  in
  let junk path =
    let oc = open_out path in
    output_string oc "broken";
    close_out oc
  in
  junk (Filename.concat bindir "ocamlc.real");
  junk (Filename.concat libdir "stdlib.cmi");
  junk (Filename.concat libdir "stdlib.cma");
  Sys.chdir saved_cwd;
  Unix.putenv "PATH" saved_path;
  let init_source =
    {|open Step_api
module Step : STEP = struct
  let warm = Input.get "material"
  let run () = Partial "no"
end
|}
  in
  (match
     C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 20.) tools ~source:init_source ~modules:[] ~input:[]
   with
  | Error (C.Rejected _) -> ()
  | Ok _ -> fail "compile_with accepted initialization"
  | Error err -> fail "compile_with init %s" (C.describe err));
  (match
     C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 5.) tools ~source:(String.make 262145 'a') ~modules:[]
       ~input:[]
   with
  | Error (C.Rejected "too big") -> ()
  | Ok _ -> fail "compile_with accepted a huge source"
  | Error err -> fail "compile_with huge %s" (C.describe err));
  (match
     C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 5.) tools ~source:step
       ~modules:[ { helper with C.name = "Unix" } ]
       ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
   with
  | Error (C.Rejected "module name") -> ()
  | Ok _ -> fail "compile_with accepted a reserved module"
  | Error err -> fail "compile_with name %s" (C.describe err));
  (match
     C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 5.) tools ~source:step ~modules:[ helper; helper ]
       ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
   with
  | Error (C.Rejected "duplicate module") -> ()
  | Ok _ -> fail "compile_with accepted a duplicate module"
  | Error err -> fail "compile_with duplicate %s" (C.describe err));
  (match
     C.compile_with ~setup_fault:None ~hang:false ~deadline:(Unix.gettimeofday () +. 20.) pinned ~source:step ~modules:[ helper ]
       ~input:[ ("material", "spec-body"); ("fetch_url", "http://127.0.0.1/spec") ]
   with
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
