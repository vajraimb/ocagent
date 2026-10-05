type validated_artifact

type error =
  | Rejected of string
  | Unavailable of string
  | Store of Store.error

val describe : error -> string

(** Pure dependency/diagnostic helpers, exposed for regression tests. *)
val loader_dependencies : string -> ((string * string) list, error) result

val compiler_diagnostic : string -> string -> string

type module_source = {
  name : string;
  source : string;
  interface_ : string;
}

type setup_fault =
  | Rlimit
  | Descriptors
  | Isolation

type toolchain

type collect_state = {
  reaped : Unix.process_status option;
  eof : bool;
  length : int;
}

type collect_event =
  | Output of int
  | Pipe_eof
  | Would_block
  | Reaped of Unix.process_status
  | Deadline

type collect_action =
  | Read
  | Reap
  | Wait
  | Done
  | Failed of string

val collector_step : collect_state -> collect_event -> collect_state * collect_action

val toolchain : unit -> (string * string, error) result

val toolchain_acceptable : compiler:string -> runtime:string -> bool

val policy_version : string

val toolchain_root : toolchain -> string

val runtime_argv : toolchain -> bytecode:string -> string array * string array

val hold_toolchain : deadline:float -> (toolchain, error) result

val release : toolchain -> unit

val compile_with :
  setup_fault:setup_fault option ->
  hang:bool ->
  deadline:float ->
  toolchain ->
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (validated_artifact, error) result

val compile :
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (validated_artifact, error) result

val compile_fault :
  setup_fault ->
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (validated_artifact, error) result

val compile_fault_after :
  int ->
  setup_fault ->
  deadline:float ->
  toolchain ->
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

val submit :
  path:string ->
  run_id:string ->
  agent_version:string ->
  admission_key:string ->
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (Step_manifest.t, error) result

val submit_fault :
  setup_fault ->
  path:string ->
  run_id:string ->
  agent_version:string ->
  admission_key:string ->
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (Step_manifest.t, error) result

val submit_hang :
  budget:float ->
  path:string ->
  run_id:string ->
  agent_version:string ->
  admission_key:string ->
  source:string ->
  modules:module_source list ->
  input:(string * string) list ->
  (Step_manifest.t, error) result

val command : timeout:float -> string array -> int * int * (string, error) result

val probe_isolation : toolchain -> sentinel:string -> tcp_port:int -> udp_port:int -> (unit, error) result

val probe_landlock : work:string -> snap:string -> sentinel:string -> tcp_port:int -> udp_port:int -> (unit, error) result

val getpgid : int -> int
