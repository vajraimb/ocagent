-- A desk is one workspace: its files, enabled harnesses, installed modules and
-- the loop's carried journal/memory. Desks are unowned (no accounts); the id is
-- an unguessable key the browser keeps, so a desk is private to whoever has it.
create table if not exists desks (
  id text primary key,
  files jsonb not null default '[]'::jsonb,
  harnesses jsonb not null default '[]'::jsonb,
  modules jsonb not null default '[]'::jsonb,
  journal jsonb not null default '[]'::jsonb,
  memory text not null default '',
  revision integer not null default 0,
  created_at bigint not null,
  updated_at bigint not null
);

-- One task given to a desk. A run spans several requests (segments); the
-- timeline (events) and the carried outcome live here so any server instance
-- can report progress, stop it, or continue a paused run.
create table if not exists runs (
  id text primary key,
  desk_id text not null references desks(id) on delete cascade,
  task text not null,
  status text not null,
  segment integer not null default 1,
  rounds integer not null default 0,
  events jsonb not null default '[]'::jsonb,
  result jsonb,
  stop_requested boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  ended_at bigint
);

create index if not exists runs_desk_created_idx on runs (desk_id, created_at desc);
