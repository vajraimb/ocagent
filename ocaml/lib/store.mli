exception Corrupt of string

type error =
  | Already_running
  | Run_mismatch
  | Version_mismatch
  | Revision_conflict
  | Stale_attempt
  | Unknown_result
  | Request_changed
  | Replay_incomplete
  | Approval_conflict
  | Bad_decision of string
  | Corrupt_snapshot of string
  | Protocol of string
  | Manifest_mismatch
  | Version_unavailable
  | Artifact_missing
  | Artifact_corrupt
  | Admission_conflict
  | Multiple_steps_unsupported
  | Unsupported_capability

val describe : error -> string

type executor
type issued

type operation_request = {
  seq : int;
  kind : string;
  label : string;
  req_hash : string;
  req : Json.t;
  recovery : string;
  approval : bool;
}

type prepare_result =
  | Replay of Json.t
  | Awaiting_approval
  | Execute of issued
  | In_flight

type snapshot = {
  revision : int;
  epoch : int;
  journal : Journal.t;
  step : Step_manifest.record option;
}

val epoch : executor -> int
val export_issued : issued -> string
val import_issued : string -> (issued, error) result
val read_snapshot : string -> (snapshot, error) result
val load : string -> Journal.t
val file_bytes : string -> string

val with_executor :
  path:string ->
  run_id:string ->
  agent_version:string ->
  (executor -> ('a, error) result) ->
  ('a, error) result

val prepare_operation : executor -> operation_request -> (prepare_result, error) result
val commit_result : string -> issued -> Json.t -> (unit, error) result

val commit_decision :
  path:string ->
  run_id:string ->
  agent_version:string ->
  seq:int ->
  callback_id:string ->
  expected_request_hash:string ->
  decision_json:Json.t ->
  (unit, error) result

val tail_check : executor -> int -> (unit, error) result

val compare_and_save :
  path:string -> expected_revision:int -> epoch:int -> Journal.t -> (unit, error) result

type 'a step_run =
  | Stored_completion of { reply : Step_manifest.reply; workspace : string }
  | Resumed of 'a

val admit_step :
  path:string ->
  run_id:string ->
  agent_version:string ->
  admission_key:string ->
  Step_manifest.bundle ->
  (Step_manifest.t, error) result

val with_step_executor :
  path:string ->
  execution_hash:string ->
  (executor -> ('a, error) result) ->
  ('a step_run, error) result

val complete_step : executor -> cursor:int -> reply:Step_manifest.reply -> workspace_hash:string -> (unit, error) result

val approve_step :
  path:string ->
  execution_hash:string ->
  seq:int ->
  callback_id:string ->
  expected_request_hash:string ->
  decision_json:Json.t ->
  (unit, error) result

