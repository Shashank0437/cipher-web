# CipherStrike

Monorepo with a **Next.js** client (`client/`) and **FastAPI** API (`server/`), backed by **MongoDB** and **Redis**.

## Run everything with Docker Compose

From the repository root:

1. Copy the example environment file and set secrets (at minimum **`JWT_SECRET`**):

   ```bash
   cp .env.example .env
   ```

2. Build and start **MongoDB**, **Redis**, the **API** (`api`), and the **web** app (`web`):

   ```bash
   docker compose up --build
   ```

3. Open the app:

   - **Frontend**: [http://localhost:3000](http://localhost:3000)
   - **API docs**: [http://localhost:8000/docs](http://localhost:8000/docs)

The browser talks to the API via **same-origin** paths: Next.js rewrites `/be/*` to the Python service (`PY_API_URL` / `INTERNAL_API_URL` inside Compose point at `http://api:8000`).

### Ports

| Service | Port |
|--------|------|
| Web (Next.js) | 3000 |
| API (FastAPI) | 8000 |
| MongoDB | 27017 |
| Redis | 6379 |

### Configuration

- **Root `.env`**: secrets and optional overrides referenced by `docker-compose.yml` (`JWT_SECRET`, `FRONTEND_URL`, `CORS_ORIGINS`, Brevo, etc.). **`MongoDB` / `Redis` URLs** for the API are set inside Compose to the container hostnames `mongo` and `redis`; you do not need to change those for the default stack.
- **`FRONTEND_URL` / `CORS_ORIGINS`**: When you deploy behind a real hostname or TLS, set these to the **public** origin users use (for example `https://app.example.com`).

### Images

- **`server/Dockerfile`**: Python 3.12, `uvicorn app.main:app`.
- **`client/Dockerfile`**: multi-stage Next.js **standalone** production image.

Ignore lists for build context: **`server/.dockerignore`**, **`client/.dockerignore`**.

### Local development without Docker for app code

You can still run **only** MongoDB and Redis via Compose, then run the API and Next dev servers on the host. See [`server/README.md`](server/README.md).
