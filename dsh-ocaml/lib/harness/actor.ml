(** Actors are fibers. A fiber does not inherit the parent's effect handlers,
    so every attempt reinstalls the whole stack around the body via [rerun].
    Mailboxes are [Eio.Stream]s. Supervision is OTP-shaped: one_for_one,
    one_for_all, rest_for_one, with a restart budget and no clock. *)

open Effect.Deep
open Core.Effects
open Core.Types

exception Actor_error of string
exception Restart_limit of string

type rerun = sw:Eio.Switch.t -> self_id:string -> (unit -> unit) -> unit

type world = {
  mailboxes : (string, actor_msg Eio.Stream.t) Hashtbl.t;
  reserved : (string, unit) Hashtbl.t;
  cancels : (string, Eio.Cancel.t) Hashtbl.t;
  generation : (string, int) Hashtbl.t;
  please : (string, bool) Hashtbl.t;
  crashes : (string * string) list ref;
  on_event : trajectory_event -> unit;
}

let create ~on_event () =
  let mailboxes = Hashtbl.create 16 in
  let reserved = Hashtbl.create 16 in
  Hashtbl.add mailboxes "root" (Eio.Stream.create 64);
  Hashtbl.add reserved "root" ();
  {
    mailboxes;
    reserved;
    cancels = Hashtbl.create 16;
    generation = Hashtbl.create 16;
    please = Hashtbl.create 16;
    crashes = ref [];
    on_event;
  }

let current world name =
  match Hashtbl.find_opt world.generation name with None -> 0 | Some n -> n

let bump world name = Hashtbl.replace world.generation name (current world name + 1)

let wants world name =
  match Hashtbl.find_opt world.please name with Some true -> true | _ -> false

let rec is_cancelled = function
  | Eio.Cancel.Cancelled _ -> true
  | Eio.Exn.Multiple xs -> List.exists (fun (exn, _) -> is_cancelled exn) xs
  | _ -> false

let younger names name =
  let rec after = function
    | [] -> []
    | n :: rest when n = name -> rest
    | _ :: rest -> after rest
  in
  after names

let victims strategy names name =
  match strategy with
  | One_for_one -> []
  | One_for_all -> List.filter (fun n -> n <> name) names
  | Rest_for_one -> younger names name

let restart_siblings world strategy names name =
  List.iter
    (fun sibling ->
      match Hashtbl.find_opt world.cancels sibling with
      | None -> ()
      | Some cc ->
          let before = current world sibling in
          Hashtbl.replace world.please sibling true;
          Eio.Cancel.cancel cc (Failure "supervisor restart");
          let spins = ref 0 in
          while current world sibling = before && !spins < 10000 do
            incr spins;
            Eio.Fiber.yield ()
          done;
          if current world sibling = before then failwith ("actor restart timed out: " ^ sibling))
    (victims strategy names name)

let reserve world name =
  if name = "" || Hashtbl.mem world.reserved name then Error ("duplicate actor " ^ name)
  else (
    Hashtbl.add world.reserved name ();
    Hashtbl.add world.mailboxes name (Eio.Stream.create 64);
    Ok ())

let run_child ~world ~rerun ~strategy ~names ~max_restarts ~gate name body =
  let crashes = ref 0 in
  let rec attempt ~use_gate () =
    bump world name;
    try
      Eio.Cancel.sub (fun cc ->
          Hashtbl.replace world.cancels name cc;
          Fun.protect
            ~finally:(fun () ->
              match Hashtbl.find_opt world.cancels name with
              | Some stored when stored == cc -> Hashtbl.remove world.cancels name
              | _ -> ())
            (fun () ->
              if use_gate then Option.iter Eio.Stream.take gate;
              Eio.Switch.run @@ fun actor_sw -> rerun ~sw:actor_sw ~self_id:name body))
    with
    | exn when is_cancelled exn ->
        if wants world name then (
          Hashtbl.replace world.please name false;
          world.on_event (ActorRestart name);
          attempt ~use_gate:false ())
        else raise exn
    | exn ->
        let error = Printexc.to_string exn in
        world.crashes := (name, error) :: !(world.crashes);
        world.on_event (ActorCrash (name, error));
        incr crashes;
        if !crashes > max_restarts then
          raise (Restart_limit (Printf.sprintf "%s after %d: %s" name !crashes error))
        else (
          restart_siblings world strategy names name;
          world.on_event (ActorRestart name);
          attempt ~use_gate:false ())
  in
  attempt ~use_gate:(Option.is_some gate) ()

let mailbox world id =
  match Hashtbl.find_opt world.mailboxes id with
  | Some box -> Ok box
  | None -> Error ("no such actor " ^ id)

let with_actor ~world ~sw ~(self_id : actor_id) ~rerun f =
  match_with f ()
    {
      retc = (fun x -> x);
      exnc = raise;
      effc =
        (fun (type b) (eff : b Effect.t) ->
          match eff with
          | Self -> Some (fun (k : (b, _) continuation) -> continue k self_id)
          | Send { to_; body } ->
              Some
                (fun (k : (b, _) continuation) ->
                  match mailbox world to_ with
                  | Error msg -> discontinue k (Actor_error msg)
                  | Ok box ->
                      Eio.Stream.add box { from = self_id; body };
                      continue k ())
          | Receive ->
              Some
                (fun (k : (b, _) continuation) ->
                  match mailbox world self_id with
                  | Error msg -> discontinue k (Actor_error msg)
                  | Ok box -> (
                      try continue k (Eio.Stream.take box)
                      with exn -> discontinue k exn))
          | Spawn { name; max_restarts; body } ->
              Some
                (fun (k : (b, _) continuation) ->
                  match reserve world name with
                  | Error msg -> discontinue k (Actor_error msg)
                  | Ok () ->
                      world.on_event (ActorSpawn name);
                      Eio.Fiber.fork ~sw (fun () ->
                          run_child ~world ~rerun ~strategy:One_for_one ~names:[ name ] ~max_restarts
                            ~gate:None name body);
                      continue k name)
          | Supervise { strategy; max_restarts; children } ->
              Some
                (fun (k : (b, _) continuation) ->
                  let clash =
                    List.find_map
                      (fun spec ->
                        if spec.name = "" || Hashtbl.mem world.reserved spec.name then Some spec.name else None)
                      children
                  in
                  match clash with
                  | Some name -> discontinue k (Actor_error ("duplicate actor " ^ name))
                  | None -> (
                      List.iter
                        (fun spec ->
                          Hashtbl.add world.reserved spec.name ();
                          Hashtbl.add world.mailboxes spec.name (Eio.Stream.create 64);
                          world.on_event (ActorSpawn spec.name))
                        children;
                      let names = List.map (fun spec -> spec.name) children in
                      let gate =
                        if children = [] then None
                        else Some (Eio.Stream.create (List.length children))
                      in
                      match
                        try
                          Ok
                            (Eio.Switch.run @@ fun group_sw ->
                             List.iter
                               (fun spec ->
                                 Eio.Fiber.fork ~sw:group_sw (fun () ->
                                     run_child ~world ~rerun ~strategy ~names ~max_restarts ~gate spec.name
                                       spec.body))
                               children;
                             Option.iter
                               (fun gate -> List.iter (fun _ -> Eio.Stream.add gate ()) children)
                               gate)
                        with exn -> Error exn
                      with
                      | Ok () -> continue k ()
                      | Error exn -> discontinue k exn))
          | _ -> None);
    }
