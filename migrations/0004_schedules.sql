-- Daily schedules a desk keeps (Schedule.daily): every day at at_time in tz,
-- the desk is given `task` as a run. Unowned like the desk; due ones are
-- started by /api/agent/cron (Vercel Cron, an external pinger, or any visit).
create table if not exists schedules (
  id text primary key,
  desk_id text not null references desks(id) on delete cascade,
  task text not null,
  at_time text not null,
  tz text not null,
  enabled boolean not null default true,
  next_at bigint not null,
  last_at bigint,
  last_run_id text,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists schedules_due_idx on schedules (enabled, next_at);
create index if not exists schedules_desk_idx on schedules (desk_id, created_at);

-- Who started a run: the user, or a schedule.
alter table runs add column if not exists trigger text not null default 'user';
