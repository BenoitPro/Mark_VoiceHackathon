# Launch Candidate Checklist

## Build and Quality Gates

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `cd apps/web && pnpm test:e2e`

## Product Readiness

- Landing page visible and copy in English
- Stripe checkout CTA functional
- Onboarding flow: sign-in -> Gmail connect -> first voice triage

## Security Readiness

- `pnpm audit --audit-level=high` clean
- Secrets not committed
- CORS allowlist configured for production
- Rate limiting enabled

## Operational Readiness

- Render API healthy (`/health/readiness`)
- Vercel web points to correct API base URL
- Rollback path documented and tested
