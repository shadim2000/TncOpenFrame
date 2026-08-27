# Deploying FreeFrame to Railway (manual)

This guide deploys the real FreeFrame project (FastAPI backend + Next.js frontend +
Celery workers + Postgres + Redis + S3 storage) on Railway.

Railway has no S3/object-storage plugin, so you bring your own bucket. Everything
else (Postgres, Redis, the app services) runs on Railway.

> **Cost note:** Railway bills per service/volume across a project. This keeps ~6
> always-on app services awake, plus managed Postgres + Redis. A free R2 bucket
> avoids storage cost, but the Railway services themselves are not free. For a
> cheaper always-on setup with Docker, read `docs/deployment.md` and use a small
> VPS instead. This guide is about Railway specifically.

---

## 1. What you get

| Railway service | Image/Dockerfile | Start command (port) | Public? |
|---|---|---|---|
| `web` | `railway/Dockerfile.web` | `node server.js` (3000) | **Yes** |
| `api` | `railway/Dockerfile.api` | migrate + gunicorn (8000) | **Yes** (private net for siblings) |
| `worker` | `railway/Dockerfile.api` | celery `transcoding` | No |
| `email_worker` | `railway/Dockerfile.api` | celery `email_high,email_low` | No |
| `maintenance_worker` | `railway/Dockerfile.api` | celery `maintenance` | No |
| `beat` | `railway/Dockerfile.api` | celery beat | No |
| `postgres` | Railway PostgreSQL plugin | — | No |
| `redis` | Railway Redis plugin | — | No |
| **S3** | **External (R2 / AWS S3 / B2)** | — | Your own |

The `web` service rewrites `/api/*` to the `api` service (the same `/api`-strip
behaviour the Docker Compose/Traefik production setup implements).

---

## 2. Prerequisites

- A GitHub account with the code pushed (see section 3).
- A Railway account (https://railway.com) with a payment method on file.
- An S3-compatible bucket. Cloudflare R2 is easiest on the free tier:
  - Create an R2 bucket (e.g. `freeframe`).
  - Create an R2 API token → give you `S3_ACCESS_KEY` / `S3_SECRET_KEY`.
  - Your endpoint is `https://<account-id>.r2.cloudflarestorage.com` (find the
    account id in the R2 dashboard URL).
  - **Set CORS on the bucket to your app's origin** (see section 6).
  - R2 region is `auto`.
- An SMTP mailbox (Mailgun, SendGrid, Postmark, or any SMTP). **Email is REQUIRED**
  for login — FreeFrame signs users in with emailed magic codes.

---

## 3. Push this repo to GitHub

```bash
# from the repo root on your machine
git remote add origin https://github.com/shadim2000/freeframe.git
git branch -M stable
git push -u origin stable
```

(If you prefer, rename the default branch to `main` and push that instead. The rest
of this guide assumes the branch is `stable`.)

---

## 4. Create the Railway project and services

1. In Railway, click **New Project** → **Deploy from GitHub repo** → pick
   `shadim2000/freeframe` (branch `stable`).
2. Railway may auto-create one service from `railway.json`. We'll configure the
   full set manually. Create the following services (New Service → Dockerfile
   from repo root, or right-click → Configure):

   **Backend app services** — for each, set the Dockerfile path to
   `railway/Dockerfile.api`:

   | Service | Dockerfile path | Start command |
   |---|---|---|
   | `api` | `railway/Dockerfile.api` | *(default — migrate + gunicorn)* |
   | `worker` | `railway/Dockerfile.api` | `celery -A apps.api.tasks.celery_app worker -Q transcoding -c ${TRANSCODING_CONCURRENCY:-1} --loglevel=warning` |
   | `email_worker` | `railway/Dockerfile.api` | `celery -A apps.api.tasks.celery_app worker -Q email_high,email_low -c ${EMAIL_CONCURRENCY:-1} --loglevel=warning` |
   | `maintenance_worker` | `railway/Dockerfile.api` | `celery -A apps.api.tasks.celery_app worker -Q maintenance -c ${MAINTENANCE_CONCURRENCY:-1} --loglevel=warning` |
   | `beat` | `railway/Dockerfile.api` | `celery -A apps.api.tasks.celery_app beat --loglevel=warning -s /tmp/celerybeat-schedule` |

   **Web app service:**

   | Service | Dockerfile path | Start command |
   |---|---|---|
   | `web` | `railway/Dockerfile.web` | `node server.js` |

3. **Add the plugin services:**
   - New Service → **PostgreSQL** → name it `postgres`.
   - New Service → **Redis** → name it `redis`.

> **Service names matter** for private networking. Railway exposes each service on
> `<name>.railway.internal`. If you name them differently, update
> `INTERNAL_API_URL` and `DATABASE_URL`/`REDIS_URL` accordingly.

---

## 5. Environment variables

Add the shared variables to every **backend** service (`api`, `worker`,
`email_worker`, `maintenance_worker`, `beat`). Railway fills in the `DATABASE_URL`
and `REDIS_URL` automatically from the plugins if you use the "Variable" reference
feature (e.g. `${{postgres.DATABASE_URL}}`), but you can also paste the internal
URLs directly.

Create a `.env.railway.example` → fill in real values. Key ones:

```
DATABASE_URL=postgresql://...@postgres.railway.internal:5432/railway
REDIS_URL=redis://:...@redis.railway.internal:6379
JWT_SECRET=<openssl rand -hex 64>
FRONTEND_URL=https://<web-public-domain>
S3_STORAGE=minio
S3_BUCKET=freeframe
S3_ACCESS_KEY=<r2-access-key>
S3_SECRET_KEY=<r2-secret-key>
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
MAIL_PROVIDER=smtp
MAIL_FROM_ADDRESS=noreply@your-domain.com
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_USE_TLS=true
API_WORKERS=2
TRANSCODING_CONCURRENCY=1
EMAIL_CONCURRENCY=1
MAINTENANCE_CONCURRENCY=1
```

**Web service only:**

```
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_UPLOAD_CONCURRENCY=5
INTERNAL_API_URL=http://api.railway.internal:8000   # build-time, matches your api service name
```

> `INTERNAL_API_URL` is a **build-time** arg in `railway/Dockerfile.web`. If it
> changes you must redeploy `web` (not just change the env var) — Railway rebuilds
> on env change, but if in doubt do a manual rebuild.

---

## 6. S3 bucket CORS

Uploads go **directly from the browser to your bucket** via presigned URLs, so the
bucket must allow your FreeFrame origin. In Cloudflare R2 → your bucket → Settings →
CORS, add a rule:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://<web-public-domain>"],
      "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
      "AllowedHeaders": ["Content-Type", "Content-MD5", "x-amz-content-sha256", "x-amz-date", "x-amz-decoded-content-length"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

FreeFrame also tries to apply this automatically to non-AWS buckets at startup if
it has permission.

---

## 7. Networking / public domains

- `web`: **Generate domain** → this is your public app URL. Set
  `FRONTEND_URL` (on the backend services) to this URL.
- `api`: **No public domain needed.** The `web` service rewrites `/api/*` →
  `api` over Railway's **private network** (`http://api.railway.internal:8000`).
  That rewrite runs **server-side** inside Railway, where `.railway.internal`
  resolves — the browser never talks to the API directly.

  > **IPv6 requirement.** Railway's private network is IPv6. The `api` Dockerfile
  > binds on dual-stack `[::]:8000` so it answers on both the public edge and the
  > private network. Do not change the bind to `0.0.0.0` or private networking
  > will fail to connect (you'd then see `api.railway.internal` time out).
  >
  > If you prefer, you *can* give `api` a public domain for debugging — visit
  > `https://<api-domain>/health` and `/docs`. But keep `INTERNAL_API_URL` on the
  > private URL so `web` proxies internally (avoids egress fees and keeps CORS
  > simple).

---

## 8. Health checks

- `api`: Healthcheck path `/health`.
- `web`: Healthcheck path `/` (or omit if Next.js responds on `/`).

---

## 9. First login / setup

1. Open your web URL. Railcards: the first user to sign up becomes the **super
   admin** via the setup wizard. But signup needs email magic codes to work —
   verify SMTP config first (the API logs a warning at startup if email is not
   configured).
2. Check the API is healthy: `https://<api-domain>/health` → `{"status":"ok"}`.

---

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Web loads but API calls 404 | `/api` rewrite target wrong (check `web`'s `INTERNAL_API_URL` and rebuild `web`), or `api` not bound on IPv6 `[::]:8000`. From a service shell: `curl http://api.railway.internal:8000/health`. |
| Uploads fail / CORS errors | S3 bucket CORS not set to your web origin (section 6). |
| Can't log in (no email arrives) | SMTP not configured. Magic codes are emailed. Check `api` logs for the startup warning. |
| `api` unhealthy / not starting | `DATABASE_URL`/`REDIS_URL` wrong; or migrations failing. Check `api` logs. |
| Videos never transcode | `worker` service missing or not consuming the `transcoding` queue. |
| Comments/approvals don't update live | `useSSE` endpoints — confirm `web`'s rewrite forwards `/api/events/*` to `api`. |
| Consistent 404 on login | Confirm `FRONTEND_URL` matches your public web domain exactly (used for link construction/CORS). |

---

## 11. Notes & caveats

- **Database migrations** run automatically at `api` startup (`alembic upgrade head`).
- **Object storage is external** — Railway never stores media. Your R2 bucket is
  the source of truth for media; back it up / enable versioning.
- **Media reachability:** presigned URLs are generated against `S3_ENDPOINT`. R2's
  endpoint is publicly reachable, so the browser can fetch them directly. If you
  ever use a private S3-compatible store, set `S3_PUBLIC_ENDPOINT` to a public URL.
- **SSE (Server-Sent Events)** for real-time updates works through the rewrite, but
  if you put Cloudflare or another proxy in front, ensure it doesn't buffer
  `text/event-stream`.
- This setup uses **all 5 backend roles as separate services** to mirror the
  Docker Compose topology. On a trial you can run `worker` only and skip
  `email_worker`/`maintenance_worker`/`beat`, but email delivery, housekeeping and
  scheduled tasks will be limited.
