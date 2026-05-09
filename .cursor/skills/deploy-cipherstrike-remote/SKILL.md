---
name: deploy-cipherstrike-remote
description: Deploys the CipherStrike web stack on the LAN workstation via SSH, git pull, and Docker Compose rebuild. Use when the user asks to deploy to the cipherstrike remote server, cipher-web host, tls@192.168.9.188, or production-like Docker deployment after pushing to main.
disable-model-invocation: true
---

# Deploy CipherStrike remote (cipher-web)

## Target environment

| Setting | Value |
|--------|--------|
| SSH identity | `~/.ssh/id_ed25519_nyx` |
| SSH user | `tls` |
| SSH host | `192.168.9.188` |
| Remote repo root | `/home/tls/cipher-web` |

Remote checkout tracks **`main`** from GitHub (`cipher-web` repository). Local workspace folder may be named `cipherstrike`; deployment always uses the **remote** path above.

## Preconditions

- Network route to `192.168.9.188`; SSH key permitted for `tls`.
- On the remote host: Docker and Docker Compose plugin installed; `docker compose` works from `/home/tls/cipher-web`.
- `server/.env` already exists on the remote (Compose reads it for `api`). After pulls that change `server/.env.example`, merge any new variables into remote `server/.env` manually if needed.

## Deploy procedure

Run non-interactively from the operator machine (add `-o BatchMode=yes` if keys are passphrase-less automation; omit for interactive passphrase):

```bash
ssh -i ~/.ssh/id_ed25519_nyx tls@192.168.9.188 'cd /home/tls/cipher-web && git pull && docker compose up --build -d'
```

**Compose behavior:** rebuilds images for services whose Docker build contexts changed (typically **`api`** and **`web`**); recreates those containers. **`mongo`** and **`redis`** usually stay running with existing volumes.

## Verify

```bash
ssh -i ~/.ssh/id_ed25519_nyx tls@192.168.9.188 'cd /home/tls/cipher-web && docker compose ps'
```

Expect **`api`** and **`web`** (and dependencies) **healthy**. Default published ports on the host: **3000** (Next.js), **8000** (FastAPI).

## Agent microservice

The Compose file documents running the Python **agent** on the host (NyxStrike), not necessarily inside this stack. Updating `agent/` via `git pull` does **not** restart a host agent process automatically; restart or redeploy the agent separately if that service is used.

## If SSH or git fails

- **Permission denied (publickey):** confirm key path and `tls` authorized_keys on the server.
- **`git pull` requires credentials:** ensure remote uses HTTPS with credential helper or deploy keys, or switch remote to SSH URL on the server.
- **Build failures:** inspect `docker compose build` output on the remote; fix client lint/type errors or server imports locally, push, then redeploy.
