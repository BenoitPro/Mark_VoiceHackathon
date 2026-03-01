# Supabase RLS Verification Checklist

## Tables covered

- `agent_action_threads`
- `agent_action_revisions`
- `agent_action_decisions`
- `agent_action_executions`
- `agent_event_log`

## Required checks

1. RLS enabled on each table.
2. `select` policy is restricted to `auth.uid() = user_id`.
3. Service-role writes happen only from backend (`SUPABASE_SERVICE_ROLE_KEY` never exposed to web).
4. Authenticated user can read only own rows through API.
5. Cross-user read attempts return empty results or denial.

## Manual verification (SQL)

```sql
select relname, relrowsecurity
from pg_class
where relname in (
  'agent_action_threads',
  'agent_action_revisions',
  'agent_action_decisions',
  'agent_action_executions',
  'agent_event_log'
);
```

```sql
select schemaname, tablename, policyname, roles, cmd, qual
from pg_policies
where tablename in (
  'agent_action_threads',
  'agent_action_revisions',
  'agent_action_decisions',
  'agent_action_executions',
  'agent_event_log'
)
order by tablename, policyname;
```
