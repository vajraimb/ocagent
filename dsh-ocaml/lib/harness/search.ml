(** Web search. The agent [perform]s [Web_search]. The handler calls the
    xAI Responses API with the web_search tool. Evaluation never reaches it. *)

open Effect.Deep
open Core.Effects
open Core.Types

let decode_string s i =
  let buf = Buffer.create 16 in
  let n = String.length s in
  let rec loop i =
    if i >= n then None
    else
      match s.[i] with
      | '"' -> Some (Buffer.contents buf, i + 1)
      | '\\' when i + 1 < n ->
          (match s.[i + 1] with
          | '"' -> Buffer.add_char buf '"'
          | '\\' -> Buffer.add_char buf '\\'
          | '/' -> Buffer.add_char buf '/'
          | 'n' -> Buffer.add_char buf '\n'
          | 'r' -> Buffer.add_char buf '\r'
          | 't' -> Buffer.add_char buf '\t'
          | c -> Buffer.add_char buf c);
          loop (i + 2)
      | c ->
          Buffer.add_char buf c;
          loop (i + 1)
  in
  loop i

let extract_string key s =
  let pat = "\"" ^ key ^ "\"" in
  let n = String.length s and pn = String.length pat in
  let rec find i =
    if i + pn > n then None
    else if String.sub s i pn = pat then
      let j = ref (i + pn) in
      while !j < n && (s.[!j] = ' ' || s.[!j] = '\n' || s.[!j] = ':') do
        incr j
      done;
      if !j < n && s.[!j] = '"' then
        match decode_string s (!j + 1) with
        | Some (value, next) -> Some (value, next)
        | None -> find (i + 1)
      else find (i + 1)
    else find (i + 1)
  in
  find 0

let collect key s =
  let rec loop acc rest =
    match extract_string key rest with
    | None -> List.rev acc
    | Some (value, next_index) ->
        let rest =
          if next_index <= String.length rest then String.sub rest next_index (String.length rest - next_index)
          else ""
        in
        loop (value :: acc) rest
  in
  loop [] s

let find_sub s pat =
  let n = String.length s and m = String.length pat in
  let rec loop i =
    if i + m > n then None else if String.sub s i m = pat then Some i else loop (i + 1)
  in
  loop 0

let dedup xs =
  let rec loop seen acc = function
    | [] -> List.rev acc
    | x :: rest -> if List.mem x seen then loop seen acc rest else loop (x :: seen) (x :: acc) rest
  in
  loop [] [] xs

let take n xs =
  let rec loop n acc = function
    | _ when n <= 0 -> List.rev acc
    | [] -> List.rev acc
    | x :: rest -> loop (n - 1) (x :: acc) rest
  in
  loop n [] xs

let host_of url =
  let rest =
    if String.starts_with ~prefix:"https://" url then String.sub url 8 (String.length url - 8)
    else if String.starts_with ~prefix:"http://" url then String.sub url 7 (String.length url - 7)
    else url
  in
  let n = String.length rest in
  let rec cut i =
    if i >= n then rest else match rest.[i] with '/' | '?' | '#' -> String.sub rest 0 i | _ -> cut (i + 1)
  in
  cut 0

let answer_text body =
  match find_sub body "output_text" with
  | Some i -> (
      let rest = String.sub body i (String.length body - i) in
      match extract_string "text" rest with Some (text, _) -> text | None -> "")
  | None ->
      let texts = List.filter (fun text -> text <> "") (collect "text" body) in
      match List.fold_left (fun best text -> if String.length text > String.length best then text else best) "" texts with
      | "" -> ""
      | text -> text

let hits_of ~limit body =
  let urls =
    collect "url" body
    |> List.filter (fun url -> String.starts_with ~prefix:"http://" url || String.starts_with ~prefix:"https://" url)
    |> dedup |> take limit
  in
  List.map (fun url -> { title = host_of url; url; snippet = "" }) urls

let parse body ~limit =
  let limit = if limit < 1 then 1 else if limit > 8 then 8 else limit in
  { text = answer_text body; hits = hits_of ~limit body }

let render answer =
  let lines = List.map (fun hit -> Printf.sprintf "- %s\n  %s" hit.title hit.url) answer.hits in
  match lines with
  | [] -> answer.text
  | _ -> answer.text ^ "\n\n" ^ String.concat "\n" lines

let parse_query args =
  let args = String.trim args in
  if args = "" then Error "先写要搜的内容"
  else if args.[0] = '{' then
    match extract_string "query" args with
    | Some (query, _) when String.trim query <> "" -> Ok (String.trim query)
    | _ -> Error "search 需要 query"
  else Ok args

let run ~mgr ~api_key ~model ~limit query =
  let query = String.trim query in
  let limit = if limit < 1 then 1 else if limit > 8 then 8 else limit in
  if query = "" then Error "先写要搜的内容"
  else if api_key = "" then Error "未配置 XAI_API_KEY，搜索不会假装有结果"
  else
    let prompt = "Search the web and answer in a few sentences. Query: " ^ query in
    let body =
      Printf.sprintf
        {|{"model":%s,"stream":false,"max_output_tokens":500,"input":[{"role":"user","content":%s}],"tools":[{"type":"web_search"}]}|}
        (Trajectory.json_string model) (Trajectory.json_string prompt)
    in
    match
      Net.request ~mgr ~timeout:60. ~meth:POST ~url:"https://api.x.ai/v1/responses"
        ~headers:[ ("Authorization", "Bearer " ^ api_key); ("Content-Type", "application/json") ]
        ~body ()
    with
    | Error text -> Error text
    | Ok reply when reply.status < 200 || reply.status >= 300 ->
        Error (Printf.sprintf "搜索 HTTP %d" reply.status)
    | Ok reply -> Ok (parse reply.body ~limit)

let with_xai ~mgr ~api_key ~model f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Web_search { query; limit } ->
              Some (fun (k : (b, _) continuation) -> continue k (run ~mgr ~api_key ~model ~limit query))
          | _ -> None);
    }

let with_scripted (answer : (search_answer, string) result) f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Web_search _ -> Some (fun (k : (b, _) continuation) -> continue k answer)
          | _ -> None);
    }

let with_offline f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Web_search _ ->
              Some (fun (k : (b, _) continuation) -> continue k (Error Net.offline_reason))
          | _ -> None);
    }

let with_unconfigured f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Web_search _ ->
              Some
                (fun (k : (b, _) continuation) ->
                  continue k (Error "未配置 XAI_API_KEY，搜索不会假装有结果"))
          | _ -> None);
    }
