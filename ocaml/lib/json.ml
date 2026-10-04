(** A small canonical JSON subset. Object keys are sorted, so hashes and
    journal lines do not depend on construction order. *)

type t =
  | Null
  | Bool of bool
  | Int of int
  | Float of float
  | String of string
  | List of t list
  | Assoc of (string * t) list

let escape s =
  let buf = Buffer.create (String.length s + 8) in
  String.iter
    (function
      | '"' -> Buffer.add_string buf "\\\""
      | '\\' -> Buffer.add_string buf "\\\\"
      | '\n' -> Buffer.add_string buf "\\n"
      | '\r' -> Buffer.add_string buf "\\r"
      | '\t' -> Buffer.add_string buf "\\t"
      | c when Char.code c < 32 ->
          Buffer.add_string buf (Printf.sprintf "\\u%04x" (Char.code c))
      | c -> Buffer.add_char buf c)
    s;
  Buffer.contents buf

let rec canonical = function
  | Null -> "null"
  | Bool true -> "true"
  | Bool false -> "false"
  | Int n -> string_of_int n
  | Float f ->
      if Float.is_finite f && Float.trunc f = f && f >= -9e15 && f <= 9e15 then
        Printf.sprintf "%.0f" f
      else Printf.sprintf "%.17g" f
  | String s -> "\"" ^ escape s ^ "\""
  | List xs -> "[" ^ String.concat "," (List.map canonical xs) ^ "]"
  | Assoc fields ->
      let fields =
        List.sort (fun (a, _) (b, _) -> String.compare a b) fields
      in
      let body =
        String.concat ","
          (List.map (fun (k, v) -> canonical (String k) ^ ":" ^ canonical v) fields)
      in
      "{" ^ body ^ "}"

let hash t = Digest.to_hex (Digest.string (canonical t))

exception Parse of string

let parse text =
  let n = String.length text in
  let i = ref 0 in
  let fail msg = raise (Parse (Printf.sprintf "%s at %d" msg !i)) in
  let peek () = if !i < n then text.[!i] else '\000' in
  let bump () = incr i in
  let rec ws () =
    match peek () with
    | ' ' | '\n' | '\r' | '\t' ->
        bump ();
        ws ()
    | _ -> ()
  in
  let expect lit =
    let len = String.length lit in
    if !i + len > n || String.sub text !i len <> lit then fail ("expected " ^ lit);
    i := !i + len
  in
  let parse_string () =
    bump ();
    let buf = Buffer.create 16 in
    let rec loop () =
      if !i >= n then fail "unterminated string";
      match text.[!i] with
      | '"' ->
          bump ();
          Buffer.contents buf
      | '\\' ->
          bump ();
          if !i >= n then fail "bad escape";
          (match text.[!i] with
          | '"' -> Buffer.add_char buf '"'
          | '\\' -> Buffer.add_char buf '\\'
          | 'n' -> Buffer.add_char buf '\n'
          | 'r' -> Buffer.add_char buf '\r'
          | 't' -> Buffer.add_char buf '\t'
          | 'u' ->
              if !i + 4 >= n then fail "bad unicode";
              let hex = String.sub text (!i + 1) 4 in
              let code = int_of_string ("0x" ^ hex) in
              Buffer.add_char buf (Char.chr code);
              i := !i + 4
          | c -> fail ("bad escape " ^ String.make 1 c));
          bump ();
          loop ()
      | c ->
          Buffer.add_char buf c;
          bump ();
          loop ()
    in
    loop ()
  in
  let parse_number () =
    let start = !i in
    if peek () = '-' then bump ();
    let rec digits () =
      match peek () with
      | '0' .. '9' ->
          bump ();
          digits ()
      | _ -> ()
    in
    digits ();
    let is_float = ref false in
    if peek () = '.' then (
      is_float := true;
      bump ();
      digits ());
    (match peek () with
    | 'e' | 'E' ->
        is_float := true;
        bump ();
        if peek () = '+' || peek () = '-' then bump ();
        digits ()
    | _ -> ());
    let raw = String.sub text start (!i - start) in
    if !is_float then Float (float_of_string raw) else Int (int_of_string raw)
  in
  let rec parse_value () =
    ws ();
    match peek () with
    | 'n' ->
        expect "null";
        Null
    | 't' ->
        expect "true";
        Bool true
    | 'f' ->
        expect "false";
        Bool false
    | '"' -> String (parse_string ())
    | '[' ->
        bump ();
        ws ();
        if peek () = ']' then (
          bump ();
          List [])
        else
          let rec items acc =
            let v = parse_value () in
            ws ();
            match peek () with
            | ',' ->
                bump ();
                items (v :: acc)
            | ']' ->
                bump ();
                List (List.rev (v :: acc))
            | _ -> fail "list"
          in
          items []
    | '{' ->
        bump ();
        ws ();
        if peek () = '}' then (
          bump ();
          Assoc [])
        else
          let rec fields acc =
            ws ();
            if peek () <> '"' then fail "key";
            let key = parse_string () in
            ws ();
            if peek () <> ':' then fail "colon";
            bump ();
            let v = parse_value () in
            ws ();
            match peek () with
            | ',' ->
                bump ();
                fields ((key, v) :: acc)
            | '}' ->
                bump ();
                Assoc (List.rev ((key, v) :: acc))
            | _ -> fail "object"
          in
          fields []
    | '-' | '0' .. '9' -> parse_number ()
    | c -> fail ("value " ^ String.make 1 c)
  in
  let value = parse_value () in
  ws ();
  if !i <> n then fail "trailing";
  value

let field name = function
  | Assoc fields ->
      (match List.assoc_opt name fields with
      | Some v -> v
      | None -> raise (Parse ("missing " ^ name)))
  | _ -> raise (Parse "not an object")

let field_opt name = function
  | Assoc fields -> List.assoc_opt name fields
  | _ -> None

let string_field name json =
  match field name json with
  | String s -> s
  | _ -> raise (Parse ("string " ^ name))

let int_field name json =
  match field name json with
  | Int n -> n
  | _ -> raise (Parse ("int " ^ name))

let assoc_string key = function
  | Assoc fields ->
      (match List.assoc_opt key fields with
      | Some (String s) -> s
      | _ -> "")
  | _ -> ""
