(* The desk loop. It stops when the model answers, or after a few tool rounds,
   so a run cannot spin forever. A journal is the log and the resume point. *)

let clip s n =
  if String.length s <= n then s else String.sub s 0 n ^ "…"

let contains s sub =
  let n = String.length s and m = String.length sub in
  let rec go i =
    if m = 0 then true
    else if i + m > n then false
    else if String.sub s i m = sub then true
    else go (i + 1)
  in
  go 0

let is_word c =
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c = '_'

let contains_word s word =
  let n = String.length s and m = String.length word in
  let rec go i =
    if i + m > n then false
    else
      let left = i = 0 || not (is_word s.[i - 1]) in
      let right = i + m = n || not (is_word s.[i + m]) in
      if left && right && String.sub s i m = word then true else go (i + 1)
  in
  go 0

let dangerous source =
  List.exists (contains source)
    [ "Sys.command"; "Sys.getenv"; "Sys.chdir"; "Sys.remove"; "Sys.rename"; "Sys.set_signal"; "Sys.readdir"; "Unix."; "#load"; "#directory"; "#use" ]

let bad_harness source =
  dangerous source || contains source "#" || contains source "open_in" || contains source "open_out"
  || contains source "Obj." || contains source "Marshal." || contains_word source "call"

let valid_name name =
  let n = String.length name in
  if n = 0 || n > 25 then false
  else if name.[0] < 'A' || name.[0] > 'Z' then false
  else
    let rec go i =
      if i = n then true
      else if is_word name.[i] then go (i + 1) else false
    in
    go 1

let reserved name = name = "Net" || name = "Search" || name = "Files" || name = "Stdlib" || name = "OCaml"

type cur = { s : string; mutable i : int }

let line cur =
  let start = cur.i in
  let len = String.length cur.s in
  let rec go i =
    if i >= len then (
      cur.i <- i;
      String.sub cur.s start (i - start))
    else if cur.s.[i] = '\n' then (
      cur.i <- i + 1;
      String.sub cur.s start (i - start))
    else go (i + 1)
  in
  go start

let block cur =
  let n = int_of_string (line cur) in
  if n < 0 || cur.i + n > String.length cur.s then failwith "bad block" else
    let s = String.sub cur.s cur.i n in
    cur.i <- cur.i + n;
    if cur.i < String.length cur.s && cur.s.[cur.i] = '\n' then cur.i <- cur.i + 1;
    s

let safe_path path =
  path <> "" && String.length path <= 80 && (not (String.starts_with ~prefix:"/" path))
  && (not (String.starts_with ~prefix:"." path))
  && (not (String.ends_with ~suffix:"/" path))
  && (not (contains path ".."))
  && (not (contains path "\\"))

let quote s =
  let buf = Buffer.create (String.length s + 2) in
  Buffer.add_char buf '\'';
  String.iter (fun c -> if c = '\'' then Buffer.add_string buf "'\\''" else Buffer.add_char buf c) s;
  Buffer.add_char buf '\'';
  Buffer.contents buf

let slurp path =
  let ic = open_in path in
  let n = in_channel_length ic in
  let s = really_input_string ic n in
  close_in ic;
  s

let call op payload =
  let req = Filename.temp_file "ocagent" ".in" in
  let resp = req ^ ".out" in
  let oc = open_out req in
  output_string oc payload;
  close_out oc;
  let cmd =
    String.concat " "
      [ quote (Sys.getenv "OCAGENT_NODE"); quote (Sys.getenv "OCAGENT_CLIENT"); quote op; quote req; quote resp ]
  in
  let code = Sys.command cmd in
  let body = try slurp resp with _ -> "" in
  if code <> 0 then failwith (if body = "" then "调用失败" else body) else body

let assoc key args = match List.assoc_opt key args with Some v -> v | None -> ""

let enabled name on = List.mem name on

let read_job path =
  let cur = { s = slurp path; i = 0 } in
  let _version = line cur in
  let task = block cur in
  let harness_n = int_of_string (line cur) in
  let rec harnesses i acc = if i = harness_n then List.rev acc else harnesses (i + 1) (line cur :: acc) in
  let harnesses = harnesses 0 [] in
  let file_n = int_of_string (line cur) in
  let rec files i acc =
    if i = file_n then List.rev acc
    else
      let path = line cur in
      let content = block cur in
      files (i + 1) ((path, content) :: acc)
  in
  let files = files 0 [] in
  let module_n = int_of_string (line cur) in
  let rec modules i acc =
    if i = module_n then List.rev acc
    else
      let name = line cur in
      let body = block cur in
      modules (i + 1) ((name, body) :: acc)
  in
  let modules = modules 0 [] in
  let journal_n = int_of_string (line cur) in
  let rec journal i acc =
    if i = journal_n then List.rev acc
    else
      let kind = line cur in
      let text = block cur in
      journal (i + 1) ((kind, text) :: acc)
  in
  let journal = journal 0 [] in
  let memory = block cur in
  (task, harnesses, files, modules, journal, memory)

let journal_size journal = List.fold_left (fun n (_, text) -> n + String.length text) 0 journal

let rec drop n xs = if n <= 0 then xs else match xs with [] -> [] | _ :: rest -> drop (n - 1) rest

let rec take n xs = if n <= 0 then [] else match xs with [] -> [] | x :: rest -> x :: take (n - 1) rest

let compact memory journal =
  if journal_size journal < 16_000 || List.length journal <= 8 then (clip memory 4_000, journal)
  else
    let keep = 8 in
    let old_n = List.length journal - keep in
    let old = take old_n journal in
    let recent = drop old_n journal in
    let folded = String.concat "\n" (List.map (fun (kind, text) -> kind ^ ": " ^ clip text 140) old) in
    let memory = if memory = "" then folded else memory ^ "\n" ^ folded in
    (clip memory 4_000, recent)

let render task memory journal =
  let history =
    if journal = [] then "（这是新的一轮）"
    else String.concat "\n" (List.map (fun (kind, text) -> kind ^ "\n" ^ clip text 1_200) journal)
  in
  String.concat "\n\n"
    [
      "你在一个 OCaml agent 循环里。最多三轮工具。做完就用纯文本回答，不要再调工具。";
      "失败的工具会自动重试一次。不要把没跑成的结果说成已经做成。";
      "记忆：";
      if memory = "" then "（无）" else memory;
      "日志：";
      history;
      "任务：";
      task;
    ]

type reply = Text of string | Tools of (string * (string * string) list) list | Failed of string

let parse_reply raw =
  let cur = { s = raw; i = 0 } in
  match line cur with
  | "text" -> Text (block cur)
  | "error" -> Failed (block cur)
  | "tools" ->
      let n = int_of_string (line cur) in
      let rec calls i acc =
        if i = n then Tools (List.rev acc)
        else
          let name = line cur in
          let argc = int_of_string (line cur) in
          let rec args j map =
            if j = argc then map
            else
              let key = line cur in
              let value = block cur in
              args (j + 1) ((key, value) :: map)
          in
          calls (i + 1) ((name, args 0 []) :: acc)
      in
      calls 0 []
  | other -> Failed ("模型回复无法解析：" ^ clip other 80)

let retry_call op payload =
  try call op payload with
  | Failure text as first -> (
      try call op payload with Failure _ -> raise first | e -> raise e)

let is_io name = name = "web_search" || name = "http_get"

let transient text = contains text "没有跑起来" || contains text "暂时失败"

let lookup files path = List.assoc_opt path files

let replace files path content =
  let rest = List.filter (fun (item, _) -> item <> path) files in
  (path, content) :: rest

let remove files path = List.filter (fun (item, _) -> item <> path) files

let find_hits files query =
  let q = String.lowercase_ascii query in
  let hits = ref [] in
  List.iter
    (fun (path, content) ->
      let rec scan i line_no =
        if i >= String.length content || List.length !hits >= 15 then ()
        else
          let stop = match String.index_from_opt content i '\n' with None -> String.length content | Some j -> j in
          let line = String.sub content i (stop - i) in
          if contains (String.lowercase_ascii line) q then hits := (Printf.sprintf "%s:%d: %s" path line_no line) :: !hits;
          let next = if stop >= String.length content then stop else stop + 1 in
          scan next (line_no + 1)
      in
      scan 0 1)
    files;
  List.rev !hits

let ocaml_payload entry source modules =
  let buf = Buffer.create 256 in
  let add_line s =
    Buffer.add_string buf s;
    Buffer.add_char buf '\n'
  in
  let add_block s =
    add_line (string_of_int (String.length s));
    Buffer.add_string buf s;
    Buffer.add_char buf '\n'
  in
  add_block entry;
  add_block source;
  add_line (string_of_int (List.length modules));
  List.iter
    (fun (name, body) ->
      add_line name;
      add_block body)
    modules;
  Buffer.contents buf

let module_from name content =
  let trimmed = String.trim content in
  let prefix = "module " ^ name ^ " = struct" in
  if String.starts_with ~prefix trimmed then
    let rest = String.trim (String.sub trimmed (String.length prefix) (String.length trimmed - String.length prefix)) in
    let end_at = match String.rindex_opt rest '\n' with None -> String.length rest | Some i -> i in
    let body = String.trim (String.sub rest 0 end_at) in
    if String.ends_with ~suffix:"end" (String.trim rest) then body else String.trim rest
  else trimmed

let write_result path status answer files modules steps journal memory =
  let buf = Buffer.create 1024 in
  let add_line s =
    Buffer.add_string buf s;
    Buffer.add_char buf '\n'
  in
  let add_block s =
    add_line (string_of_int (String.length s));
    Buffer.add_string buf s;
    Buffer.add_char buf '\n'
  in
  add_line "v1";
  add_line status;
  add_block answer;
  add_line (string_of_int (List.length files));
  List.iter
    (fun (path, content) ->
      add_line path;
      add_block content)
    (List.rev files);
  add_line (string_of_int (List.length modules));
  List.iter
    (fun (name, body) ->
      add_line name;
      add_block body)
    modules;
  add_line (string_of_int (List.length steps));
  List.iter
    (fun (tool, detail, output) ->
      add_line tool;
      add_block detail;
      add_block output)
    steps;
  add_line (string_of_int (List.length journal));
  List.iter
    (fun (kind, text) ->
      add_line kind;
      add_block text)
    journal;
  add_block memory;
  let oc = open_out path in
  output_string oc (Buffer.contents buf);
  close_out oc

let step_lines steps =
  String.concat "\n"
    (List.fold_left
       (fun acc (tool, detail, output) ->
         if detail = "推迟" then acc else acc @ [ tool ^ " " ^ detail ^ "：" ^ clip output 160 ])
       [] steps)

let () =
  let job = Sys.argv.(1) in
  let out = Sys.argv.(2) in
  let task, harnesses, files0, modules0, journal0, memory0 = read_job job in
  let files = ref files0 in
  let modules = ref modules0 in
  let journal = ref journal0 in
  let memory = ref memory0 in
  let steps = ref [] in
  let note kind text =
    journal := !journal @ [ (kind, text) ];
    let memory', journal' = compact !memory !journal in
    memory := memory';
    journal := journal'
  in
  let push tool detail output =
    steps := !steps @ [ (tool, detail, clip output 800) ];
    note "tool" (tool ^ " " ^ detail ^ "\n" ^ clip output 1_500)
  in
  let run_ocaml entry source =
    if dangerous source then "沙箱拒绝了这段代码：它想跑进程或离开工作区。"
    else
      try retry_call "ocaml" (ocaml_payload entry source !modules) with
      | Failure text -> text
      | _ -> "没有跑起来"
  in
  let exec name args =
    match name with
    | "list_files" when enabled "files" harnesses ->
        let paths = List.rev_map fst !files in
        let output = if paths = [] then "（空）" else String.concat "\n" (List.sort compare paths) in
        push name (string_of_int (List.length paths) ^ " 个文件") output
    | "read_file" when enabled "files" harnesses ->
        let path = assoc "path" args in
        let output = if not (safe_path path) then "路径不行" else match lookup !files path with None -> "没有这个文件" | Some text -> text in
        push name path output
    | "find_in_files" when enabled "files" harnesses ->
        let query = String.trim (assoc "query" args) in
        let hits = if query = "" then [] else find_hits !files query in
        push name query (if hits = [] then "没有匹配" else String.concat "\n" hits)
    | "write_file" when enabled "files" harnesses ->
        let path = assoc "path" args in
        let content = assoc "content" args in
        let output =
          if not (safe_path path) then "路径不行"
          else if String.length content > 8_000 then "内容太长"
          else (
            files := replace !files path content;
            "写好了 " ^ path)
        in
        push name path output
    | "delete_file" when enabled "files" harnesses ->
        let path = assoc "path" args in
        if not (safe_path path) then push name path "路径不行"
        else (
          files := remove !files path;
          push name path ("删了 " ^ path))
    | "web_search" when enabled "web" harnesses ->
        let query = String.trim (assoc "query" args) in
        let output = if query = "" then "查询是空的" else try retry_call "search" query with Failure text -> text in
        push name query output
    | "http_get" when enabled "net" harnesses ->
        let url = String.trim (assoc "url" args) in
        let once () = try Ok (call "net" url) with Failure text -> Error text in
        let output =
          if url = "" then "地址是空的"
          else
            match once () with
            | Ok text -> text
            | Error text when transient text -> ( match once () with Ok text -> text | Error text -> text)
            | Error text -> text
        in
        push name url output
    | "ocaml_run" when enabled "ocaml" harnesses ->
        let path = String.trim (assoc "path" args) in
        let output =
          if not (safe_path path) || not (String.ends_with ~suffix:".ml" path) then "只能跑工作区里的一个 .ml 文件。"
          else match lookup !files path with None -> "没有 " ^ path | Some source -> run_ocaml path source
        in
        push name path output
    | "load_harness" when enabled "ocaml" harnesses ->
        let module_name = String.trim (assoc "name" args) in
        let path = String.trim (assoc "path" args) in
        let output =
          match lookup !files path with
          | None -> "没有 " ^ path
          | Some source ->
              let body = module_from module_name source in
              if not (safe_path path) || not (String.ends_with ~suffix:".ml" path) then "只能加载工作区里的一个 .ml 文件。"
              else if not (valid_name module_name) || reserved module_name then "模块名不行。"
              else if body = "" || String.length body > 2500 || bad_harness body then "这个文件不能当 harness。"
              else if List.length !modules >= 6 && not (List.exists (fun (name, _) -> name = module_name) !modules) then
                "自定义 harness 最多 6 个。"
              else
                let trial = (module_name, body) :: List.filter (fun (name, _) -> name <> module_name) !modules in
                let check = "let () = print_endline \"harness-ok\"\n" in
                let previous = !modules in
                modules := trial;
                let ran = run_ocaml "src/ocagent_load_check.ml" check in
                if contains ran "harness-ok" && not (contains ran "Error:") then "已加载 module " ^ module_name
                else (
                  modules := previous;
                  ran)
        in
        push name module_name output
    | _ -> push name "拒绝" "这个工具没开，或者不存在。"
  in
  let max_rounds = 3 in
  let rec loop rounds =
    let memory', journal' = compact !memory !journal in
    memory := memory';
    journal := journal';
    if rounds >= max_rounds then (
      let text =
        if !steps = [] then "轮数到了，还没有做出结果。把任务写短一点，或点继续。"
        else "轮数到了，这是已经做出的部分。\n" ^ step_lines !steps ^ "\n点继续可以接着做。"
      in
      note "answer" text;
      write_result out "done" text !files !modules !steps !journal !memory)
    else (
      write_result out "partial" "" !files !modules !steps !journal !memory;
      let prompt = render task !memory !journal in
      let raw =
        try call "model" prompt
        with Failure text -> "error\n" ^ string_of_int (String.length text) ^ "\n" ^ text ^ "\n"
      in
      match parse_reply raw with
      | Failed text ->
          note "error" text;
          let shown = if !steps = [] then text else text ^ "\n" ^ step_lines !steps in
          write_result out "done" shown !files !modules !steps !journal !memory
      | Text text ->
          note "answer" text;
          write_result out "done" text !files !modules !steps !journal !memory
      | Tools calls ->
          let io, rest = List.partition (fun (name, _) -> is_io name) calls in
          let batch = if io = [] then calls else io in
          List.iter (fun (name, args) -> exec name args) batch;
          if io <> [] then List.iter (fun (name, _) -> push name "推迟" "先不执行。搜索结果还没回来，下一轮再做。") rest;
          loop (rounds + 1))
  in
  try loop 0 with
  | Failure text ->
      note "error" text;
      write_result out "error" text !files !modules !steps !journal !memory
  | exn ->
      let text = Printexc.to_string exn in
      note "error" text;
      write_result out "error" text !files !modules !steps !journal !memory
