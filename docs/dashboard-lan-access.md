# Dashboard LAN Access & IP Blocklist

The dashboard binds to **loopback only (`127.0.0.1`) by default**. It has **no
authentication** and can dispatch agents and open interactive terminals — effectively
remote code execution. Treat any non-loopback exposure as granting full control to
everyone who can reach the port.

## Exposing on the LAN (opt-in)

LAN exposure is explicit. Setting a LAN IP in `DASHCTL_HOST` alone does **not** expose the
dashboard; you must opt in:

```sh
DASHCTL_BIND_ALL=1 tools/dashboard/dashctl.sh restart
```

When opted in, the server binds `0.0.0.0` (reachable from the LAN and from loopback,
survives DHCP/VPN IP changes) and `dashctl` prints a no-auth/RCE warning. The displayed
URL shows the routable LAN IP; the health check stays on `127.0.0.1` (valid because
`0.0.0.0` also accepts loopback). Only do this on a trusted network behind a firewall.

`ARCHITECT_BIND_ALL=1` has the same effect for a direct `node server.mjs` launch.

**Limitation:** `dashctl install` (launchd/systemd) does not thread the host setting;
service-managed starts remain loopback-only.

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
