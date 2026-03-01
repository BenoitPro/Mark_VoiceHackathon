# Deploy Runbook: Vercel (Web) + Render (API)

## 1) API on Render

1. Create a new Render service from this repo using `render.yaml`.
2. Set all required environment variables from `apps/server/.env.example`.
3. Set `WEB_ORIGIN` and `WEB_ORIGINS` to the final Vercel domain.
4. Verify health endpoints:
   - `/health`
   - `/health/voice`
   - `/health/readiness`

## 2) Web on Vercel

1. Import the same repo in Vercel.
2. Framework preset: Vite (`vercel.json` already set).
3. Configure web env variables from `apps/web/.env.example`.
4. Set `VITE_API_BASE_URL` to your Render API URL.

## 3) Smoke Test

1. Sign in with Google.
2. Open Settings and connect Gmail.
3. Start voice session and run a triage prompt.
4. Check `/v1/billing/status` and Stripe checkout flow.

## 4) Rollback

1. Roll back Vercel deployment to previous successful build.
2. Roll back Render service to previous deploy.
3. Re-run smoke test.
