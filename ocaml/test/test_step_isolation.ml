(** OS boundary for the worker jail. The probe is the same mount, seccomp and namespace path. *)

module C = Ocagent_harness.Step_compile
module X = Ocagent_harness.Step_sandbox

let fail fmt = Printf.ksprintf failwith fmt

let field line key =
  let parts = String.split_on_char ' ' line in
  match List.find_opt (fun item -> String.starts_with ~prefix:(key ^ "=") item) parts with
  | Some item -> String.sub item (String.length key + 1) (String.length item - String.length key - 1)
  | None -> fail "缺少 %s in %s" key line

let () =
  match C.hold_toolchain ~deadline:(Unix.gettimeofday () +. 20.) with
  | Error err -> fail "%s" (C.describe err)
  | Ok tools ->
      Fun.protect
        ~finally:(fun () -> C.release tools)
        (fun () ->
          let root = Filename.temp_dir "ocagent-iso" "" in
          let art = Filename.concat root "artifact" in
          Unix.mkdir art 0o755;
          let worker = Filename.concat art "worker" in
          let oc = open_out worker in
          output_string oc "bytecode";
          close_out oc;
          Unix.chmod worker 0o644;
          let sentinel = Filename.concat root "sentinel" in
          let oc = open_out sentinel in
          output_string oc "secret";
          close_out oc;
          let stdout_path = Filename.concat root "out" in
          let stderr_path = Filename.concat root "err" in
          match
            X.probe ~deadline:(Unix.gettimeofday () +. 10.) ~snap:(C.toolchain_root tools) ~artifact:art ~art:worker ~sentinel
              ~store:sentinel ~port:1 ~stdout_path ~stderr_path
          with
          | Error err -> fail "%s" (match err with X.Unavailable msg -> msg | X.Rejected msg -> msg)
          | Ok line ->
              let need_denied key =
                match int_of_string_opt (field line key) with
                | Some n when n <> 0 -> ()
                | _ -> fail "%s 没有被拒绝: %s" key line
              in
              need_denied "setpgid";
              need_denied "fork";
              need_denied "mount";
              need_denied "prctl";
              if field line "tcp" <> "0" || field line "stat" <> "0" || field line "store" <> "0" || field line "tmp" <> "1" || field line "ro" <> "0"
              then fail "契约 %s" line;
              print_endline "step isolation ok")
