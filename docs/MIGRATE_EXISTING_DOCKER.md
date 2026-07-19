# Migrate existing Docker volume to hardened ClipCascade

Goal: repoint `sathvikrao/clipcascade:latest` → hardened build **without losing users / server settings**.

Client login cookies may expire after restart; **user accounts live in the H2 volume**. Desktop/mobile app settings stay on each device.

## What is preserved

| Data | Where | Migrates? |
|------|--------|-----------|
| Users, passwords (bcrypt), server config in DB | Docker volume `/database` | **Yes** if same volume + same H2 password |
| Session cookies | Server memory / client | **No** — re-login |
| Desktop `DATA` / keyring secrets | Each PC | **Yes** (local) |
| Mobile AsyncStorage / Keychain | Each phone | **Yes** (local) |
| Container env (message size, P2P, etc.) | compose file | Copy into new compose |

## Critical differences vs `latest`

1. **`CC_SERVER_DB_PASSWORD` is required** (H2). A blank password refuses to start.
2. If you never set it on `latest`, the baked-in default was:  
   `QjuGlhE3uwylBBANMkX1 o2MdEoFgbU5XkFvTftky`  
   (file password, one space, user password — the URL uses `CIPHER=AES`, so H2
   needs both). Rotate it once the migration is verified: it shipped in
   `application.properties`, so it is public.
3. **`CC_ALLOWED_ORIGINS=*` now refuses to start.** Use exact origins, e.g.
   `http://100.64.0.1:8080` (your Tailscale IP; `tailscale ip -4`). A wildcard
   let any website open an authenticated WebSocket with your session cookie and
   read your clipboard.
4. Process runs as **uid 10001** (non-root). Old images wrote the DB as root → **chown** required once.
5. **Sessions now expire after 24h, not a year** (`CC_SESSION_TIMEOUT` went from
   `525960m` to `1440m`). Every client re-logs in daily unless you set
   `CC_SESSION_TIMEOUT=525960m` in `.env`.
6. **`CC_BIND_ADDRESS` defaults to `127.0.0.1`.** Set it to your Tailscale IP, or
   the server is unreachable from other machines.
7. Image is not `sathvikrao/clipcascade:latest` until upstream merges/publishes — build from this branch.

## Your previous compose → new

Old:

```yaml
image: sathvikrao/clipcascade:latest
ports:
  - "100.64.0.1:8080:8080"
volumes:
  - clipcascade-data:/database
environment:
  - CC_ALLOWED_ORIGINS=*
  # no CC_SERVER_DB_PASSWORD
```

New: use  
`ClipCascade_Server/docker-compose/docker-compose.migrate-from-latest.yml`  
+ `.env.migrate.example` → `.env`.

## Step-by-step

```bash
# 0) On the host that has the volume
cd /path/to/ClipCascade   # this hardened checkout

# 1) Stop old stack (wherever its compose lives)
docker stop clipcascade   # or: docker compose down

# 2) Backup volume (optional but recommended)
docker run --rm -v clipcascade-data:/database -v "$PWD":/backup alpine \
  tar czf /backup/clipcascade-database-backup.tgz -C /database .

# 3) Fix ownership for non-root image
docker run --rm -v clipcascade-data:/database alpine \
  chown -R 10001:10001 /database

# 4) Build hardened image
cd ClipCascade_Server/ClipCascade_Backend
./mvnw -DskipTests package
docker build -t clipcascade:hardening .

# 5) Env for migrate compose
cd ../docker-compose
cp .env.migrate.example .env
# edit .env: CC_BIND_ADDRESS, CC_ALLOWED_ORIGINS, confirm DB password

# 6) Start
docker compose -f docker-compose.migrate-from-latest.yml --env-file .env up -d

# 7) Health
curl -sS http://100.64.0.1:8080/health
docker logs clipcascade --tail 80
```

## Clients after cutover

- Server URL stays e.g. `http://100.64.0.1:8080` (Tailscale HTTP is allowed on this branch).
- Re-login if session died (server restart).
- Keep client encryption enabled.
- Rebuild mobile APK only if you need the new Android cleartext / capture features.

## Failure modes

| Symptom | Cause | Fix |
|---------|--------|-----|
| `Set CC_SERVER_DB_PASSWORD` | Env missing | Set env (see default above) |
| H2 wrong password / cannot open DB | Password ≠ original | Use original default or the password you had set |
| Permission denied on `/database` | Volume still root-owned | `chown -R 10001:10001` |
| WebSocket / browser fails | `CC_ALLOWED_ORIGINS=*` or wrong origin | Exact `http://100.64.0.1:8080` |
| Empty admin / “no users” | Wrong volume or fresh path | Confirm volume name `clipcascade-data` external |

## Roll back

```bash
docker compose -f docker-compose.migrate-from-latest.yml down
# start previous compose with sathvikrao/clipcascade:latest again
# same volume clipcascade-data
```

Rollback only works if you did not change H2 password or corrupt the volume.
