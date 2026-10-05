(** Source subset for one Step. Checks the parse tree and the typed tree.
    A missing Unix library is not the check. *)

type error =
  | Rejected of string

let describe = function
  | Rejected msg -> msg

let forbidden_module = function
  | "Unix" | "Sys" | "Obj" | "Marshal" | "Dynlink" | "Filename" | "Random" | "Domain" | "Effect" | "Thread"
  | "Mutex" | "Condition" | "Atomic" | "Gc" | "Weak" | "Ephemeron" | "In_channel" | "Out_channel" | "Format" | "Scanf"
  | "Printexc" | "Arg" | "Callback" | "Bigarray" | "Str" | "Runtime_events" | "Semaphore" | "ThreadUnix" ->
      true
  | name -> String.starts_with ~prefix:"Camlinternal" name

let allowed_module ~users name =
  List.mem name users
  ||
  match name with
  | "Step_api" | "STEP" | "Input" | "Net" | "Trace" | "Stdlib" | "String" | "StringLabels" | "List" | "ListLabels" | "Option" | "Result" | "Int" | "Bool"
  | "Char" | "Array" | "Seq" | "Map" | "Set" | "Either" | "Fun" | "Uchar" | "Buffer" | "Int32" | "Int64" | "Nativeint"
  | "Unit" | "Float" | "Hashtbl" | "Queue" | "Stack" ->
      true
  | _ -> false

let io_value = function
  | "exit" | "at_exit" | "open_in" | "open_in_bin" | "open_in_gen" | "open_out" | "open_out_bin" | "open_out_gen"
  | "close_in" | "close_out" | "close_in_noerr" | "close_out_noerr" | "flush" | "flush_all" | "input" | "input_char"
  | "input_byte" | "input_binary_int" | "input_value" | "input_line" | "really_input" | "really_input_string" | "output"
  | "output_char" | "output_byte" | "output_string" | "output_bytes" | "output_binary_int" | "output_value"
  | "output_substring" | "seek_in" | "seek_out" | "pos_in" | "pos_out" | "in_channel_length" | "out_channel_length"
  | "print_char" | "print_string" | "print_bytes" | "print_int" | "print_float" | "print_endline" | "print_newline"
  | "prerr_char" | "prerr_string" | "prerr_bytes" | "prerr_int" | "prerr_float" | "prerr_endline" | "prerr_newline"
  | "read_line" | "read_int" | "read_int_opt" | "read_float" | "read_float_opt" | "set_binary_mode_in"
  | "set_binary_mode_out" | "unsafe_really_input" ->
      true
  | _ -> false

let check_modules ~users parts =
  match parts with
  | [] -> Ok ()
  | root :: rest ->
      if forbidden_module root || List.exists forbidden_module rest then
        Error (Rejected ("forbidden module " ^ if forbidden_module root then root else List.find forbidden_module rest))
      else if allowed_module ~users root then Ok ()
      else Error (Rejected ("undeclared module " ^ root))

let check_value ~users parts =
  match List.rev parts with
  | [] -> Ok ()
  | value :: rev_mods ->
      if io_value value then Error (Rejected ("forbidden value " ^ value)) else check_modules ~users (List.rev rev_mods)

let rec longident = function
  | Longident.Lident name -> [ name ]
  | Longident.Ldot (rest, name) -> longident rest @ [ name ]
  | Longident.Lapply (left, right) -> longident left @ longident right

let rec pure_expr expr =
  match expr.Parsetree.pexp_desc with
  | Pexp_constant _ | Pexp_ident _ | Pexp_function _ -> true
  | Pexp_constraint (inner, _) | Pexp_coerce (inner, _, _) -> pure_expr inner
  | Pexp_tuple items -> List.for_all pure_expr items
  | Pexp_construct (_, None) | Pexp_variant (_, None) -> true
  | Pexp_construct (_, Some inner) | Pexp_variant (_, Some inner) -> pure_expr inner
  | Pexp_record (fields, None) -> List.for_all (fun (_, item) -> pure_expr item) fields
  | Pexp_array items -> List.for_all pure_expr items
  | Pexp_let (_, bindings, body) ->
      List.for_all (fun binding -> pure_expr binding.Parsetree.pvb_expr) bindings && pure_expr body
  | Pexp_ifthenelse (cond, yes, Some no) -> pure_expr cond && pure_expr yes && pure_expr no
  | _ -> false

let parse_impl text =
  let lexbuf = Lexing.from_string text in
  try Ok (Parse.implementation lexbuf) with Syntaxerr.Error _ | Parsing.Parse_error -> Error (Rejected "syntax")

let parse_intf text =
  let lexbuf = Lexing.from_string text in
  try Ok (Parse.interface lexbuf) with Syntaxerr.Error _ | Parsing.Parse_error -> Error (Rejected "syntax")

let scan_structure ~users items =
  let bad = ref None in
  let fail msg = if !bad = None then bad := Some msg in
  let note_value lid =
    match check_value ~users (longident lid) with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let note_module lid =
    match check_modules ~users (longident lid) with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let iter =
    {
      Ast_iterator.default_iterator with
      expr =
        (fun self expr ->
          (match expr.Parsetree.pexp_desc with
          | Pexp_extension _ | Pexp_object _ | Pexp_pack _ | Pexp_new _ | Pexp_send _ | Pexp_override _ ->
              fail "unsupported expression"
          | Pexp_ident id -> note_value id.txt
          | _ -> ());
          Ast_iterator.default_iterator.expr self expr);
      typ =
        (fun self expr ->
          (match expr.Parsetree.ptyp_desc with
          | Ptyp_constr (id, _) -> note_value id.txt
          | Ptyp_package _ -> fail "unsupported module"
          | _ -> ());
          Ast_iterator.default_iterator.typ self expr);
      module_expr =
        (fun self expr ->
          (match expr.Parsetree.pmod_desc with
          | Pmod_ident id -> note_module id.txt
          | Pmod_unpack _ | Pmod_apply _ -> fail "unsupported module"
          | _ -> ());
          Ast_iterator.default_iterator.module_expr self expr);
      structure_item =
        (fun self item ->
          (match item.Parsetree.pstr_desc with
          | Pstr_primitive _ -> fail "external"
          | Pstr_eval _ -> fail "toplevel expression"
          | Pstr_extension _ | Pstr_attribute _ -> fail "extension"
          | Pstr_recmodule _ | Pstr_class _ | Pstr_class_type _ | Pstr_typext _ -> fail "unsupported declaration"
          | Pstr_value (_, bindings) ->
              List.iter
                (fun binding -> if not (pure_expr binding.Parsetree.pvb_expr) then fail "initialization effect")
                bindings
          | _ -> ());
          Ast_iterator.default_iterator.structure_item self item);
    }
  in
  iter.structure iter items;
  match !bad with
  | None -> Ok ()
  | Some msg -> Error (Rejected msg)

let scan_signature ~users items =
  let bad = ref None in
  let fail msg = if !bad = None then bad := Some msg in
  let note_module lid =
    match check_modules ~users (longident lid) with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let note_value lid =
    match check_value ~users (longident lid) with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let iter =
    {
      Ast_iterator.default_iterator with
      typ =
        (fun self expr ->
          (match expr.Parsetree.ptyp_desc with
          | Ptyp_constr (id, _) -> note_value id.txt
          | Ptyp_package _ -> fail "unsupported module"
          | _ -> ());
          Ast_iterator.default_iterator.typ self expr);
      module_type =
        (fun self expr ->
          (match expr.Parsetree.pmty_desc with
          | Pmty_ident id | Pmty_alias id -> note_module id.txt
          | _ -> ());
          Ast_iterator.default_iterator.module_type self expr);
      signature_item =
        (fun self item ->
          (match item.Parsetree.psig_desc with
          | Psig_extension _ | Psig_attribute _ -> fail "extension"
          | Psig_class _ | Psig_class_type _ -> fail "unsupported declaration"
          | _ -> ());
          Ast_iterator.default_iterator.signature_item self item);
    }
  in
  iter.signature iter items;
  match !bad with
  | None -> Ok ()
  | Some msg -> Error (Rejected msg)

let implementation ~users text =
  match parse_impl text with
  | Error _ as err -> err
  | Ok items -> scan_structure ~users items

let interface ~users text =
  match parse_intf text with
  | Error _ as err -> err
  | Ok items -> scan_signature ~users items

let scan_cmt ~users path =
  let info = Cmt_format.read_cmt path in
  let bad = ref None in
  let fail msg = if !bad = None then bad := Some msg in
  let note_value parts =
    match check_value ~users parts with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let note_module parts =
    match check_modules ~users parts with
    | Ok () -> ()
    | Error (Rejected msg) -> fail msg
  in
  let parts path = String.split_on_char '.' (Path.name path) in
  let iter =
    {
      Tast_iterator.default_iterator with
      expr =
        (fun self expr ->
          (match expr.Typedtree.exp_desc with
          | Texp_ident (path, _, _) -> note_value (parts path)
          | _ -> ());
          Tast_iterator.default_iterator.expr self expr);
      module_expr =
        (fun self expr ->
          (match expr.Typedtree.mod_desc with
          | Tmod_ident (path, _) -> note_module (parts path)
          | _ -> ());
          Tast_iterator.default_iterator.module_expr self expr);
      typ =
        (fun self expr ->
          (match expr.Typedtree.ctyp_desc with
          | Ttyp_constr (path, _, _) -> note_value (parts path)
          | _ -> ());
          Tast_iterator.default_iterator.typ self expr);
    }
  in
  (match info.cmt_annots with
  | Implementation structure -> iter.structure iter structure
  | Interface signature -> iter.signature iter signature
  | _ -> fail "missing typed tree");
  match !bad with
  | None -> Ok ()
  | Some msg -> Error (Rejected msg)
