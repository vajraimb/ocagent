open Effect
open Effect.Deep
open Core.Effects

type fs = {
  read : string -> (string, string) result;
  write : string -> (string, string) result;
  delete : string -> (string, string) result;
}

type mock = {
  mutable files : (string * string) list;
  mutable commands : string list;
  mutable denied : string list;
}

let empty_mock () = { files = []; commands = []; denied = [] }

let safe_relative path =
  if path = "" || String.starts_with ~prefix:"/" path then Error "path escape"
  else
    let parts = String.split_on_char '/' path in
    if List.exists (fun part -> part = "" || part = "..") parts then Error "path escape" else Ok path

let escapes cmd =
  let n = String.length cmd in
  let rec dots i =
    if i + 1 >= n then false
    else if cmd.[i] = '.' && cmd.[i + 1] = '.' then
      let before = i = 0 || cmd.[i - 1] = ' ' || cmd.[i - 1] = '/' || cmd.[i - 1] = '\t' in
      let after_i = i + 2 in
      let after = after_i >= n || cmd.[after_i] = '/' || cmd.[after_i] = ' ' || cmd.[after_i] = '\t' in
      if before && after then true else dots (i + 1)
    else dots (i + 1)
  in
  let rec absolute i =
    if i >= n then false
    else if cmd.[i] = '/' && (i = 0 || cmd.[i - 1] = ' ' || cmd.[i - 1] = '\t') then true
    else absolute (i + 1)
  in
  dots 0 || absolute 0

let mock_fs mock =
  {
    read =
      (fun path ->
        match safe_relative path with
        | Error _ as err ->
            mock.denied <- path :: mock.denied;
            err
        | Ok path -> (
            match List.assoc_opt path mock.files with
            | Some text -> Ok text
            | None -> Error ("missing " ^ path)));
    write =
      (fun args ->
        match String.index_opt args '\n' with
        | None -> Error "write_file 需要 path\\ncontent"
        | Some i -> (
            let path = String.sub args 0 i in
            let content = String.sub args (i + 1) (String.length args - i - 1) in
            match safe_relative path with
            | Error _ as err ->
                mock.denied <- path :: mock.denied;
                err
            | Ok path ->
                mock.files <- (path, content) :: List.remove_assoc path mock.files;
                Ok ("wrote " ^ path)));
    delete =
      (fun path ->
        match safe_relative path with
        | Error _ as err ->
            mock.denied <- path :: mock.denied;
            err
        | Ok path ->
            mock.files <- List.remove_assoc path mock.files;
            Ok ("deleted " ^ path));
  }

let eio_fs root =
  let open Eio.Path in
  let guarded path f =
    match safe_relative path with
    | Error _ as err -> err
    | Ok path -> ( try Ok (f (root / path)) with exn -> Error (Printexc.to_string exn))
  in
  {
    read = (fun path -> guarded path load);
    write =
      (fun args ->
        match String.index_opt args '\n' with
        | None -> Error "write_file 需要 path\\ncontent"
        | Some i ->
            let path = String.sub args 0 i in
            let content = String.sub args (i + 1) (String.length args - i - 1) in
            guarded path (fun target ->
                save ~create:(`Or_truncate 0o644) target content;
                "wrote " ^ path));
    delete =
      (fun path ->
        guarded path (fun target ->
            unlink target;
            "deleted " ^ path));
  }

let run_limited ~clock ~cwd ~mgr ~timeout_sec cmd =
  try
    let output =
      Eio.Time.with_timeout_exn clock timeout_sec (fun () ->
          Eio.Process.parse_out mgr Eio.Buf_read.take_all ~cwd [ "sh"; "-c"; cmd ])
    in
    Ok output
  with
  | Eio.Time.Timeout -> Error "timeout"
  | exn -> Error (Printexc.to_string exn)

let finish result continue_k =
  perform (EmitTrajectory (Core.Types.ToolEnd ("sandbox_exec", result)));
  continue continue_k result

let reject_or cmd run =
  if escapes cmd then Error "path escape" else run ()

let with_eio_sandbox ~clock ~cwd ~mgr f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | SandboxExec { cmd; timeout_sec } ->
              Some
                (fun (k : (b, _) continuation) ->
                  perform (EmitTrajectory (Core.Types.ToolStart ("sandbox_exec", cmd)));
                  let result = reject_or cmd (fun () -> run_limited ~clock ~cwd ~mgr ~timeout_sec cmd) in
                  finish result k)
          | _ -> None);
    }

let with_mock_sandbox mock f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | SandboxExec { cmd; _ } ->
              Some
                (fun (k : (b, _) continuation) ->
                  perform (EmitTrajectory (Core.Types.ToolStart ("sandbox_exec", cmd)));
                  let result =
                    reject_or cmd (fun () ->
                        mock.commands <- cmd :: mock.commands;
                        Ok ("ran: " ^ cmd))
                  in
                  if Result.is_error result then mock.denied <- cmd :: mock.denied;
                  finish result k)
          | _ -> None);
    }

let with_dry_run_sandbox f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | SandboxExec { cmd; _ } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let result = reject_or cmd (fun () -> Ok ("dry-run: " ^ cmd)) in
                  continue k result)
          | _ -> None);
    }

let with_tools ~fs f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | CallTool { name; args_json } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let result =
                    match name with
                    | "shell" | "sandbox_exec" ->
                        perform (SandboxExec { cmd = args_json; timeout_sec = 5. })
                    | "read_file" -> fs.read args_json
                    | "write_file" -> fs.write args_json
                    | "delete_file" -> fs.delete args_json
                    | "fetch" | "http" -> (
                        match Net.parse_fetch_args args_json with
                        | Error _ as err -> err
                        | Ok (meth, url, body) -> (
                            match perform (Fetch { meth; url; body }) with
                            | Error _ as err -> err
                            | Ok reply -> Ok (Printf.sprintf "HTTP %d\n%s" reply.status reply.body)))
                    | "search" | "web_search" -> (
                        match Search.parse_query args_json with
                        | Error _ as err -> err
                        | Ok query -> (
                            match perform (Web_search { query; limit = 5 }) with
                            | Error _ as err -> err
                            | Ok answer -> Ok (Search.render answer)))
                    | other -> Error ("unknown tool " ^ other)
                  in
                  continue k result)
          | _ -> None);
    }
