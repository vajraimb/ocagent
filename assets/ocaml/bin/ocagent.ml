(* The desk loop, run as a script by the bundled toplevel:

     ocamlrun ocaml ocagent.ml <job> <result>

   It is deliberately thin. Each round it asks the model for one step (a
   module Step), hands the step to the runner, folds the step's effect log into
   its journal, and either answers or goes round again. Everything that needs
   judgement — the instructions, the prompt context, the plan and the
   pre-finish check, budgets and stall limits, installing harnesses — lives on
   the Node side, which talks to this loop through the two bridge calls
   ("model" and "ocaml") and the frames they return. The loop never decides on
   its own that a run is finished: it ends only when the step it was handed
   says Done / Ask / Partial, when the same step comes back twice without
   progress, or when the model stops producing code. *)

let clip s n = if String.length s <= n then s else String.sub s 0 n ^ "…"

let contains s sub =
  let n = String.length s and m = String.length sub in
  let rec go i = if m = 0 then true else if i + m > n then false else if String.sub s i m = sub then true else go (i + 1) in
  go 0

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
  if n < 0 || cur.i + n > String.length cur.s then failwith "bad block"
  else
    let s = String.sub cur.s cur.i n in
    cur.i <- cur.i + n;
    if cur.i < String.length cur.s && cur.s.[cur.i] = '\n' then cur.i <- cur.i + 1;
    s

let quote s =
  let buf = Buffer.create (String.length s + 2) in
  Buffer.add_char buf '\'';
  String.iter (fun c -> if c = '\'' then Buffer.add_string buf "'\\''" else Buffer.add_char buf c) s;
  Buffer.add_char buf '\'';
  Buffer.contents buf

let slurp path =
  let ic = open_in_bin path in
  let n = in_channel_length ic in
  let s = really_input_string ic n in
  close_in ic;
  s

(* One call over the bridge: the payload goes through a temp file, the reply
   comes back through another, both removed afterwards. *)
let call op payload =
  let req = Filename.temp_file "ocagent_loop_" ".in" in
  let resp = req ^ ".out" in
  let oc = open_out_bin req in
  output_string oc payload;
  close_out oc;
  let cmd =
    String.concat " " [ quote (Sys.getenv "OCAGENT_NODE"); quote (Sys.getenv "OCAGENT_CLIENT"); quote op; quote req; quote resp ]
  in
  let code = Sys.command cmd in
  let body = try slurp resp with _ -> "" in
  (try Sys.remove req with _ -> ());
  (try Sys.remove resp with _ -> ());
  if code <> 0 then failwith (if body = "" then "调用失败" else body) else body

(* --- job and result files --------------------------------------------- *)

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
  (* Written whole, then moved into place, so a half-written checkpoint is
     never what the other side reads. *)
  let tmp = path ^ ".tmp" in
  let oc = open_out_bin tmp in
  output_string oc (Buffer.contents buf);
  close_out oc;
  Sys.rename tmp path

(* --- journal ------------------------------------------------------------ *)

let journal_size journal = List.fold_left (fun n (_, text) -> n + String.length text) 0 journal

let rec drop n xs = if n <= 0 then xs else match xs with [] -> [] | _ :: rest -> drop (n - 1) rest

let rec take n xs = if n <= 0 then [] else match xs with [] -> [] | x :: rest -> x :: take (n - 1) rest

(* Older journal entries fold into the memory string once the journal grows. *)
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

(* --- the model's reply and the step frame -------------------------------- *)

type reply = Text of string | Failed of string

let parse_reply raw =
  let cur = { s = raw; i = 0 } in
  match line cur with
  | "text" -> Text (block cur)
  | "error" -> Failed (block cur)
  | other -> Failed ("模型回复无法解析：" ^ clip other 80)

let find_from s sub from =
  let n = String.length s and m = String.length sub in
  let rec go i = if i + m > n then None else if String.sub s i m = sub then Some i else go (i + 1) in
  if from < 0 || m = 0 then None else go from

let extract_code text =
  let fenced marker =
    match find_from text marker 0 with
    | None -> None
    | Some i -> (
        let start = i + String.length marker in
        let start = if start < String.length text && text.[start] = '\n' then start + 1 else start in
        match find_from text "```" start with
        | None -> Some (String.trim (String.sub text start (String.length text - start)))
        | Some j -> Some (String.trim (String.sub text start (j - start))))
  in
  match fenced "```ocaml" with
  | Some code when code <> "" -> code
  | _ -> (
      match fenced "```" with
      | Some code when code <> "" -> code
      | _ -> if contains text "module Step" || contains text "let run" then String.trim text else "")

let step_payload source files =
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
  Buffer.add_string buf "step\n";
  add_block source;
  add_line (string_of_int (List.length files));
  List.iter
    (fun (path, content) ->
      add_line path;
      add_block content)
    files;
  Buffer.contents buf

let nonempty_lines s =
  let rec go i acc =
    if i >= String.length s then List.rev acc
    else
      let j = match String.index_from_opt s i '\n' with None -> String.length s | Some j -> j in
      let line = String.sub s i (j - i) in
      let next = if j >= String.length s then j else j + 1 in
      go next (if line = "" then acc else line :: acc)
  in
  go 0 []

let split_tab s =
  match String.index_opt s '\t' with
  | None -> (s, "", "")
  | Some i -> (
      let rest = String.sub s (i + 1) (String.length s - i - 1) in
      match String.index_opt rest '\t' with
      | None -> (String.sub s 0 i, rest, "")
      | Some j -> (String.sub s 0 i, String.sub rest 0 j, String.sub rest (j + 1) (String.length rest - j - 1)))

(* What this loop itself tells the model: the task, its own Trace notes, and
   the last compile error. The Node side prepends the instructions and the
   rest of the context. *)
let render_task task memory journal =
  let traces = List.filter_map (fun (kind, text) -> if kind = "trace" then Some ("- " ^ text) else None) journal in
  let compile =
    List.fold_left (fun acc (kind, text) -> match kind with "compile" -> Some text | "trace" | "code" -> None | _ -> acc) None journal
  in
  let notes =
    if traces = [] && memory = "" then "（还没有）"
    else String.concat "\n" ((if memory = "" then [] else [ "更早的记录："; memory ]) @ traces)
  in
  let problem = match compile with None -> "" | Some text -> "上一轮没有执行，编译失败：\n" ^ text in
  String.concat "\n\n" [ "任务："; task; "你用 Trace.note 记下的："; notes; problem ]

let step_lines steps =
  String.concat "\n" (List.map (fun (tool, detail, output) -> tool ^ " " ^ detail ^ "：" ^ clip output 160) steps)

(* --- the loop ------------------------------------------------------------- *)

type _ Effect.t +=
  | Model : string -> string Effect.t
  | Run_step : string -> string Effect.t
  | Checkpoint : unit Effect.t

let () =
  let job = Sys.argv.(1) in
  let out = Sys.argv.(2) in
  let task, _harnesses, files0, modules0, journal0, memory0 = read_job job in
  let files = ref files0 in
  let modules = modules0 in
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
  let finish text =
    note "answer" text;
    write_result out "done" text !files modules !steps !journal !memory
  in
  let rec loop stalled last_code =
    Effect.perform Checkpoint;
    let prompt = render_task task !memory !journal in
    match parse_reply (Effect.perform (Model prompt)) with
    | Failed text ->
        note "error" text;
        let shown = if !steps = [] then text else text ^ "\n" ^ step_lines !steps in
        write_result out "done" shown !files modules !steps !journal !memory
    | Text text -> (
        let code = extract_code text in
        if code = "" then (
          note "compile" "没有 ocaml 代码块。只输出 module Step。";
          if stalled >= 2 then finish "没有拿到可执行的 OCaml。" else loop (stalled + 1) last_code)
        else
          let result = Effect.perform (Run_step (step_payload code !files)) in
          let cur = { s = result; i = 0 } in
          match line cur with
          | "fail" ->
              let msg = block cur in
              note "compile" msg;
              push "compile" "没执行" msg;
              if code = last_code && stalled >= 1 then finish msg else loop (stalled + 1) code
          | "ok" -> (
              let kind = line cur in
              let answer = block cur in
              let _traces = block cur in
              let effects = block cur in
              let file_n = int_of_string (line cur) in
              let rec read_files i acc =
                if i = file_n then List.rev acc
                else
                  let path = line cur in
                  let content = block cur in
                  read_files (i + 1) ((path, content) :: acc)
              in
              files := read_files 0 [];
              note "code" code;
              List.iter
                (fun line ->
                  let tool, detail, output = split_tab line in
                  push tool detail output;
                  note "effect" line;
                  if tool = "Trace.note" && output <> "" then note "trace" output)
                (nonempty_lines effects);
              match kind with
              | "done" | "ask" | "partial" -> finish answer
              | "continue" when code = last_code -> finish "同一步重复了，没有新进展。"
              | "continue" -> loop 0 code
              | _ -> finish answer)
          | other ->
              let msg = "这一步没有跑成：" ^ clip other 160 in
              note "compile" msg;
              if stalled >= 2 then finish msg else loop (stalled + 1) code)
  in
  let drive () =
    let module Deep = Effect.Deep in
    Deep.try_with
      (fun () -> loop 0 "")
      ()
      {
        effc =
          (fun (type a) (e : a Effect.t) ->
            match e with
            | Model prompt ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let raw = try call "model" prompt with Failure text -> "error\n" ^ string_of_int (String.length text) ^ "\n" ^ text ^ "\n" in
                    Deep.continue k raw)
            | Run_step payload ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    let raw = try call "ocaml" payload with Failure text -> "fail\n" ^ string_of_int (String.length text) ^ "\n" ^ text ^ "\n" in
                    Deep.continue k raw)
            | Checkpoint ->
                Some
                  (fun (k : (a, _) Deep.continuation) ->
                    write_result out "partial" "" !files modules !steps !journal !memory;
                    Deep.continue k ())
            | _ -> None);
      }
  in
  try drive () with
  | Failure text ->
      note "error" text;
      write_result out "error" text !files modules !steps !journal !memory
  | exn ->
      let text = Printexc.to_string exn in
      note "error" text;
      write_result out "error" text !files modules !steps !journal !memory
