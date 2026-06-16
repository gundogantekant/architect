# Dashboard LAN Access & IP Blocklist

The dashboard binds to **all interfaces (`0.0.0.0`) by default**, so it is reachable from
the LAN (e.g. a phone on the same WiFi at `http://<lan-ip>:3777`). It has **no
authentication** and can dispatch agents and open interactive terminals — effectively
remote code execution. Treat the exposure as granting full control to everyone who can
reach the port and the access guard allows. Use only on a trusted network behind a
firewall. On start, `dashctl` prints a no-auth/RCE warning and the routable LAN URL.

## Restricting to loopback (opt-out)

To bind loopback-only (`127.0.0.1`):

```sh
DASHCTL_LOOPBACK_ONLY=1 tools/dashboard/dashctl.sh restart   # or DASHCTL_BIND_ALL=0
```

For a direct `node server.mjs` launch, set `ARCHITECT_LOOPBACK_ONLY=1` (or
`ARCHITECT_BIND_ALL=0`, or an explicit `ARCHITECT_HOST=127.0.0.1`). Bind-host precedence
in `resolveBindHost`: `ARCHITECT_HOST` → `ARCHITECT_LOOPBACK_ONLY=1` →
`ARCHITECT_BIND_ALL=0` → default `0.0.0.0`.

`dashctl install` (launchd/systemd) threads the **resolved** bind host into the service
unit, so a service-managed start honors whatever bind/opt-out was in effect at install
time. The health check stays on `127.0.0.1` (valid because `0.0.0.0` also accepts
loopback). `/api/server/status` reports `bindHost`, `lanExposed`, and `lanUrl`; when
exposed, the UI shows a dismissible no-auth banner with the LAN URL.

## Access guard (always on)

Because the no-auth dashboard binds the LAN by default, every request passes through a
pure access guard (`lib/access-guard.mjs`, `evaluateRequest`) before routing:

- **Loopback is always exempt** (guaranteed recovery path from the host).
- **Host-header validation:** the `Host` hostname must be loopback (`localhost`/`127.0.0.1`/
  `::1`), one of the server's own LAN IPs, or in `ARCHITECT_ALLOWED_HOSTS`. Blocks
  DNS-rebinding for non-loopback clients.
- **Same-origin / CSRF:** mutating requests (POST/PUT/PATCH/DELETE, and WebSocket
  upgrades) with a foreign `Origin`/`Referer` are rejected `403`; absent Origin (curl/
  programmatic) is allowed.
- **IP allow-list (opt-in):** set `ARCHITECT_ALLOW_IPS` (comma-separated IPs/CIDRs) to
  deny non-loopback clients outside the list — inverts the default-allow posture.
- **IP deny-list:** the blocklist below remains as a kill-switch.

## IP blocklist

Every inbound request is logged to `access_log`; the `#access` page shows the log and the
active blocklist with block/unblock actions, backed by `ip_blocklist`
(`/api/access/*`). The blocklist is **deny-list only and empty by default** — it does not
protect against a never-seen client, so it is not a substitute for authentication.

### Lockout safeguards

- **Loopback is always exempt** from the blocklist. The host machine, via
  `http://127.0.0.1:3777`, can always reach `/api/access/*` to recover.
- The block API **rejects blocking your own IP** (HTTP 400), so a LAN operator cannot
  one-click self-lockout.
- Access-control identity comes strictly from `req.socket.remoteAddress` — never from
  `X-Forwarded-For` or other client-supplied headers (which are spoofable).

### Recovery if locked out

1. From the dashboard host, open `http://127.0.0.1:3777/#access` and unblock the IP
   (loopback is never blocked).
2. Last resort — delete directly from the database:
   ```sh
   docker exec architect-postgres psql -U architect -d architect \
     -c "DELETE FROM ip_blocklist WHERE ip = '<IP>';"
   ```
   then `dashctl restart` to reload the in-memory blocklist.
