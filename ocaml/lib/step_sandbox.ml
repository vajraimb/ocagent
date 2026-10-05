(** Linux user/mount/net namespace for one saved bytecode image.
    Threads may be created. fork, vfork, clone3, setsid and setpgid are denied,
    so a descendant cannot leave the worker process group. A supervisor in that
    group kills it when the coordinator's liveness pipe closes. *)

let as_bytes = 268435456
let file_bytes = 1048576

external to_int : Unix.file_descr -> int = "%identity"
external of_int : int -> Unix.file_descr = "%identity"
external unshare_user : unit -> int = "ocagent_unshare_user"
external write_maps : int -> int = "ocagent_write_maps"
external mount_worker : string -> string -> int = "ocagent_mount_worker"
external limit_worker : int -> int -> int = "ocagent_limit_worker"
external confine_worker : unit -> int = "ocagent_confine_worker"
external close_extra_fds : int -> int -> int -> int = "ocagent_close_extra_fds"
external clearenv : unit -> unit = "ocagent_clearenv"
external kill_group : int -> int = "ocagent_kill_group"
external setpgid : int -> int = "ocagent_setpgid"
external set_subreaper : unit -> int = "ocagent_set_subreaper"
external worker_probe : string -> string -> string -> int -> string = "ocagent_worker_probe"

type launch = {
  supervisor : int;
  worker : int;
  ipc : Unix.file_descr;
  alive : Unix.file_descr;
  stdout_path : string;
  stderr_path : string;
}

type error =
  | Unavailable of string
  | Rejected of string

let stage_text code =
  let stage =
    match code / 1000 with
    | 3 -> "namespace"
    | 4 -> "uid"
    | 5 -> "gid"
    | 10 -> "setgroups"
    | 11 -> "propagation_private"
    | 12 -> "jail_mkdir"
    | 13 -> "jail_tmpfs"
    | 14 -> "snapshot_bind"
    | 15 -> "snapshot_readonly"
    | 18 -> "artifact_bind"
    | 19 -> "artifact_readonly"
    | 7 -> "chroot"
    | 8 -> "chdir"
    | 17 -> "root_move"
    | 21 -> "seccomp"
    | 22 -> "pdeath"
    | n -> "stage" ^ string_of_int n
  in
  stage ^ " " ^ string_of_int (code mod 1000)

let read_file path =
  let fd = Unix.openfile path [ Unix.O_RDONLY ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let buf = Buffer.create 64 in
      let tmp = Bytes.create 256 in
      let rec go () =
        match Unix.read fd tmp 0 256 with
        | 0 -> Buffer.contents buf
        | n ->
            Buffer.add_subbytes buf tmp 0 n;
            go ()
      in
      go ())

let write_exact path text =
  let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let rec go off =
        if off < String.length text then
          let n = Unix.write_substring fd text off (String.length text - off) in
          go (off + n)
      in
      go 0)

let signal_byte fd ch =
  let bytes = Bytes.make 1 ch in
  ignore (Unix.write fd bytes 0 1)

let report fd text =
  let bytes = Bytes.of_string text in
  ignore (Unix.write fd bytes 0 (Bytes.length bytes))

let kill_pid pid = try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ()

let reap pid =
  let rec go () =
    match Unix.waitpid [] pid with
    | _, status -> status
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
    | exception Unix.Unix_error (Unix.ECHILD, _, _) -> Unix.WEXITED 0
  in
  go ()

type child_job =
  | Exec of { argv : string array; env : string array; marker : string }
  | Probe of { art : string; sentinel : string; store : string; port : int }

let child_setup ~stdout ~stderr ~ipc ~status_w ~child_to_parent_w ~parent_to_child_r ~snap ~artifact job =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
  Unix.dup2 null Unix.stdin;
  Unix.close null;
  Unix.dup2 stdout Unix.stdout;
  Unix.dup2 stderr Unix.stderr;
  if to_int ipc <> 3 then (
    Unix.dup2 ipc (of_int 3);
    Unix.close ipc);
  ignore (setpgid 0);
  clearenv ();
  let rc = limit_worker as_bytes file_bytes in
  if rc <> 0 then (report status_w (Printf.sprintf "FAIL rlimit %d\n" (abs rc)); exit 126);
  let unshare_rc = unshare_user () in
  if unshare_rc <> 0 then (report status_w ("FAIL " ^ stage_text unshare_rc ^ "\n"); exit 126);
  signal_byte child_to_parent_w 'R';
  let buf = Bytes.create 1 in
  if Unix.read parent_to_child_r buf 0 1 <> 1 || Bytes.get buf 0 <> 'G' then exit 126;
  Unix.close child_to_parent_w;
  if close_extra_fds (to_int status_w) 3 (to_int parent_to_child_r) <> 0 then (report status_w "FAIL fd\n"; exit 126);
  (try Unix.close parent_to_child_r with Unix.Unix_error _ -> ());
  (match job with
  | Exec { marker; _ } -> (
      try write_exact marker "exec" with _ -> report status_w "FAIL marker\n"; exit 126)
  | Probe _ -> ());
  let mount_rc = mount_worker snap artifact in
  if mount_rc <> 0 then (
    (match job with Exec { marker; _ } -> (try Unix.unlink marker with Unix.Unix_error _ -> ()) | Probe _ -> ());
    report status_w ("FAIL " ^ stage_text mount_rc ^ "\n");
    exit 126);
  let confined = confine_worker () in
  if confined <> 0 then (report status_w ("FAIL " ^ stage_text confined ^ "\n"); exit 126);
  match job with
  | Probe { art; sentinel; store; port } ->
      let line = worker_probe art sentinel store port in
      let bytes = Bytes.of_string (line ^ "\n") in
      ignore (Unix.write Unix.stdout bytes 0 (Bytes.length bytes));
      report status_w ("PROBE " ^ line ^ "\n");
      exit 0
  | Exec { argv; env; marker = _ } ->
      report status_w "OK\n";
      (try Unix.execve argv.(0) argv env with
      | Unix.Unix_error (err, operation, path) ->
          report status_w (Printf.sprintf "EXEC_ERROR %s %s: %s\n" operation path (Unix.error_message err));
          exit 127)

let supervise ~alive_r ~worker =
  let rec watch () =
    let readable =
      match Unix.select [ alive_r ] [] [] 0.2 with
      | fds, _, _ -> fds <> []
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> false
    in
    if readable then (
      ignore (kill_group worker);
      kill_pid worker;
      ignore (reap worker);
      exit 0)
    else
      match Unix.waitpid [ Unix.WNOHANG ] worker with
      | 0, _ -> watch ()
      | _, Unix.WEXITED code -> exit code
      | _, Unix.WSIGNALED signal -> exit (128 + signal)
      | _, _ -> exit 1
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> watch ()
      | exception Unix.Unix_error (Unix.ECHILD, _, _) -> exit 0
  in
  watch ()

let read_line fd deadline =
  let buf = Buffer.create 32 in
  let tmp = Bytes.create 1 in
  let rec go () =
    if Unix.gettimeofday () >= deadline then Error "deadline"
    else
      match Unix.read fd tmp 0 1 with
      | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
      | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> (
          match Unix.select [ fd ] [] [] (max 0. (deadline -. Unix.gettimeofday ())) with
          | [], _, _ -> Error "deadline"
          | _ -> go ())
      | 0 -> if Buffer.length buf = 0 then Error "eof" else Ok (Buffer.contents buf)
      | _ when Bytes.get tmp 0 = '\n' -> Ok (Buffer.contents buf)
      | _ ->
          Buffer.add_char buf (Bytes.get tmp 0);
          go ()
  in
  go ()

let spawn ~deadline ~snap ~artifact ~stdout_path ~stderr_path job =
  if Unix.gettimeofday () >= deadline then Error (Rejected "worker timeout")
  else
    let ipc_parent, ipc_child = Unix.socketpair ~cloexec:false Unix.PF_UNIX Unix.SOCK_STREAM 0 in
    Unix.set_close_on_exec ipc_parent;
    Unix.clear_close_on_exec ipc_child;
    let alive_r, alive_w = Unix.pipe ~cloexec:true () in
    let info_r, info_w = Unix.pipe ~cloexec:true () in
    let stdout = Unix.openfile stdout_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
    let stderr = Unix.openfile stderr_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600 in
    match Unix.fork () with
    | 0 -> (
        try
          Unix.close alive_w;
          Unix.close info_r;
          Unix.close ipc_parent;
          ignore (set_subreaper ());
          let status_r, status_w = Unix.pipe ~cloexec:true () in
          let c2p_r, c2p_w = Unix.pipe ~cloexec:true () in
          let p2c_r, p2c_w = Unix.pipe ~cloexec:true () in
          match Unix.fork () with
          | 0 ->
              Unix.close status_r;
              Unix.close c2p_r;
              Unix.close p2c_w;
              Unix.close alive_r;
              Unix.close info_w;
              child_setup ~stdout ~stderr ~ipc:ipc_child ~status_w ~child_to_parent_w:c2p_w ~parent_to_child_r:p2c_r ~snap
                ~artifact job
          | worker ->
              Unix.close status_w;
              Unix.close c2p_w;
              Unix.close p2c_r;
              Unix.close ipc_child;
              Unix.close stdout;
              Unix.close stderr;
              ignore (setpgid worker);
              let note = Bytes.create 1 in
              let ready =
                match Unix.read c2p_r note 0 1 with
                | 1 when Bytes.get note 0 = 'R' -> true
                | _ -> false
                | exception Unix.Unix_error _ -> false
              in
              if not ready then (
                ignore (kill_group worker);
                report info_w "FAIL sync\n";
                exit 126);
              let code = write_maps worker in
              if code <> 0 then (
                signal_byte p2c_w 'A';
                ignore (kill_group worker);
                report info_w ("FAIL " ^ stage_text code ^ "\n");
                exit 126);
              signal_byte p2c_w 'G';
              Unix.close p2c_w;
              Unix.close c2p_r;
              let text = Buffer.create 64 in
              let tmp = Bytes.create 256 in
              let rec drain () =
                match Unix.read status_r tmp 0 256 with
                | 0 -> ()
                | n ->
                    Buffer.add_subbytes text tmp 0 n;
                    drain ()
                | exception Unix.Unix_error (Unix.EINTR, _, _) -> drain ()
              in
              drain ();
              let body = String.trim (Buffer.contents text) in
              if String.starts_with ~prefix:"PROBE " body then (
                report info_w (body ^ "\n");
                exit 0)
              else if body = "OK" then (
                report info_w (Printf.sprintf "OK %d\n" worker);
                supervise ~alive_r ~worker)
              else (
                ignore (kill_group worker);
                let line = if body = "" then "FAIL status" else body in
                report info_w (line ^ "\n");
                exit 126)
        with _ ->
          report info_w "FAIL supervisor\n";
          exit 127)
    | supervisor -> (
        Unix.close alive_r;
        Unix.close info_w;
        Unix.close ipc_child;
        Unix.close stdout;
        Unix.close stderr;
        match read_line info_r deadline with
        | Error msg ->
            kill_pid supervisor;
            ignore (reap supervisor);
            Unix.close info_r;
            Unix.close alive_w;
            Unix.close ipc_parent;
            Error (Unavailable msg)
        | Ok line when String.starts_with ~prefix:"OK " line -> (
            match int_of_string_opt (String.trim (String.sub line 3 (String.length line - 3))) with
            | Some worker ->
                Unix.close info_r;
                Ok { supervisor; worker; ipc = ipc_parent; alive = alive_w; stdout_path; stderr_path }
            | None ->
                kill_pid supervisor;
                ignore (reap supervisor);
                Unix.close info_r;
                Unix.close alive_w;
                Unix.close ipc_parent;
                Error (Unavailable "worker pid"))
        | Ok line ->
            let status = reap supervisor in
            Unix.close info_r;
            Unix.close alive_w;
            Unix.close ipc_parent;
            let detail = if line = "" then "isolation" else line in
            match status with
            | Unix.WEXITED 0 when String.starts_with ~prefix:"PROBE " line -> Error (Rejected detail)
            | _ -> Error (Unavailable detail))

let release launch =
  (try Unix.close launch.alive with Unix.Unix_error _ -> ());
  (try Unix.close launch.ipc with Unix.Unix_error _ -> ());
  let _ = reap launch.supervisor in
  (try Unix.rmdir (Printf.sprintf "/tmp/ocagent-wjail-%d" launch.worker) with Unix.Unix_error _ -> ())

let probe ~deadline ~snap ~artifact ~art ~sentinel ~store ~port ~stdout_path ~stderr_path =
  match spawn ~deadline ~snap ~artifact ~stdout_path ~stderr_path (Probe { art; sentinel; store; port }) with
  | Error (Rejected line) ->
      let line = if String.starts_with ~prefix:"PROBE " line then String.sub line 6 (String.length line - 6) else line in
      Ok line
  | Error (Unavailable _) as err -> err
  | Ok launch ->
      release launch;
      Error (Unavailable "probe stayed up")

let mount_available ~deadline ~snap ~artifact =
  let dir = Filename.temp_dir "ocagent-mount" "" in
  let stdout_path = Filename.concat dir "out" in
  let stderr_path = Filename.concat dir "err" in
  let art = Filename.concat artifact "worker" in
  Fun.protect
    ~finally:(fun () ->
      (try Sys.remove stdout_path with _ -> ());
      (try Sys.remove stderr_path with _ -> ());
      (try Unix.rmdir dir with _ -> ()))
    (fun () ->
      match probe ~deadline ~snap ~artifact ~art ~sentinel:dir ~store:dir ~port:1 ~stdout_path ~stderr_path with
      | Ok _ -> Ok ()
      | Error (Unavailable msg) as err -> if String.starts_with ~prefix:"PROBE " msg then Ok () else err
      | Error (Rejected _) -> Ok ())
