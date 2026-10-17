-- What the agent chose to remember about a desk across tasks (Memory.remember):
-- short notes shown in every prompt, editable from the panel.
alter table desks add column if not exists notes jsonb not null default '[]'::jsonb;
