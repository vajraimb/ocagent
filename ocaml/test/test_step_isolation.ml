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
            X.probe ~deadline:(X.monotonic () +. 10.) ~snap:(C.toolchain_root tools) ~artifact:art ~art:worker ~sentinel
              ~store:sentinel ~port:1 ~stdout_path ~stderr_path
          with
          | Error err ->
              let detail = match err with X.Unavailable msg -> msg | X.Rejected msg -> msg in
              let err_text = if Sys.file_exists stderr_path then In_channel.with_open_bin stderr_path In_channel.input_all else "" in
              let out_text = if Sys.file_exists stdout_path then In_channel.with_open_bin stdout_path In_channel.input_all else "" in
              fail "%s stderr=%s stdout=%s" detail err_text out_text
          | Ok line ->
              let need_denied key =
                match int_of_string_opt (field line key) with
                | Some n when n <> 0 -> ()
                | _ -> fail "%s 没有被拒绝: %s" key line
              in
              need_denied "setpgid";
              need_denied "setsid";
              need_denied "fork";
              need_denied "vfork";
              need_denied "clone3";
              need_denied "unshare";
              need_denied "mount";
              need_denied "prctl";
              if field line "policy" <> "1" then fail "同一过滤器没有拒绝兼容 ABI: %s" line;
              (match field line "entered" with
              | "1" -> (
                  match int_of_string_opt (field line "compat") with
                  | Some 1 -> ()
                  | _ -> fail "兼容 ABI 进入了内核但不是 EPERM: %s" line)
              | "0" -> ()
              | other -> fail "entered=%s %s" other line);
              if field line "tcp" <> "0" || field line "stat" <> "0" || field line "store" <> "0" || field line "tmp" <> "1" || field line "ro" <> "0"
              then fail "契约 %s" line;
              print_endline ("step isolation ok " ^ line))
