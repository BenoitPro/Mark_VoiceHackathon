# Data Retention and Sensitive Data Handling

## Runtime Workflow Cache

- File: `apps/server/.runtime/email-workflows.json`
- Purpose: temporary Gmail triage continuity
- Git policy: ignored by `.gitignore`
- Retention recommendation: clear at deployment restart and on explicit session reset

## Audit Payloads

- Keep audit payloads minimal and structured.
- Do not log raw provider secrets or access tokens.
- Prefer correlation IDs for support diagnostics.

## Secret Rotation

- Rotate compromised credentials immediately:
  - Supabase service role
  - Composio API key
  - Anthropic key
  - Speechmatics key
  - ElevenLabs key
  - Stripe secrets
- Update runtime env vars and redeploy both API and web.

## Incident Response (Minimum)

1. Identify blast radius and affected users.
2. Revoke and rotate secrets.
3. Deploy patched build.
4. Validate with `/health/readiness` and critical path smoke tests.
5. Record incident summary and prevention action.
