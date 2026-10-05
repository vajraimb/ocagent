type validated_artifact

type error =
  | Rejected of string
  | Unavailable of string
  | Store of Store.error

val describe : error -> string

type module_source = {
  name : string;
  source : string;
  interface_ : string;
}

val toolchain : unit -> (string * string, error) result

val toolchain_acceptable : compiler:string -> runtime:string -> bool

val bounded_command : timeout:float -> string array -> (string, error) result

val limits_failure : string -> (unit, error) result

val isolation_probe : sentinel:string -> (unit, error) result

val compile :
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (validated_artifact, error) result

val admit :
  path:string ->
  run_id:string ->
  agent_version:string ->
  admission_key:string ->
  validated_artifact ->
  (Step_manifest.t, error) result
