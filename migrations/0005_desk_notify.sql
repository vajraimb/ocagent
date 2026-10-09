-- Where a desk's messages go: one incoming-webhook address (飞书 / 钉钉 /
-- 企业微信 / Slack …). A finished scheduled run posts its summary there, and
-- Notify.send lets a step send a line of its own.
alter table desks add column if not exists notify_url text not null default '';
