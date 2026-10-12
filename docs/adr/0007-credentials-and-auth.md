# ADR 0007: Eufy credentials live on the bridge; HA only knows the bridge

Status: accepted (2026-10-13)

## Decision

- The config flow sends email/password once to `POST /api/login`; the bridge stores them in
  `DATA_DIR/credentials.json` (mode 0600) so it can log in again after a restart. Environment
  variables `EUFY_EMAIL`/`EUFY_PASSWORD` take precedence if set.
- The HA config entry stores only host, port and the bridge token.
- The bridge API is protected by `BRIDGE_TOKEN` (Bearer header, or `?token=` for stream and
  captcha URLs that HA consumers cannot add headers to). Token comparison is constant-time.
  `/api/health` is unauthenticated. Without a token the bridge logs a warning.
- Credentials are never returned by the API; diagnostics redact token, email and password.

## Consequences

- The stream URL contains the token; it is only handed to HA's stream/go2rtc, not to browsers.
- If `BRIDGE_TOKEN` changes, the integration starts a reauth flow asking for the new token.
