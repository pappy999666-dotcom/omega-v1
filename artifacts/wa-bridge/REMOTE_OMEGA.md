# Omega remote session capability API

Omega remains the owner of every WhatsApp session. A separately deployed client such as Waiq can use an explicitly allowlisted Omega session through a narrow HTTP capability API.

## Configuration

```dotenv
OMEGA_WAIQ_API_KEY=<long-random-service-key>
OMEGA_WAIQ_SESSION_ALLOWLIST=<omega-session-id-1,omega-session-id-2>
```

`OMEGA_WAIQ_API_KEY` is a dedicated service credential. Never reuse WhatsApp auth data, `creds.json`, browser cookies, Telegram credentials, or a web dashboard password.

`OMEGA_WAIQ_SESSION_ALLOWLIST` is a comma- or whitespace-separated list of Omega session IDs. An empty list authorizes nothing; there is no wildcard. Keep this value private and rotate the key when a client is removed.

## Endpoints

All endpoints require:

```http
Authorization: Bearer <OMEGA_WAIQ_API_KEY>
```

- `GET /api/remote/sessions` — status for allowlisted sessions only.
- `GET /api/remote/sessions/:id` — status for one allowlisted session.
- `POST /api/remote/sessions/:id/messages` — send plain text to a validated WhatsApp JID.

Message requests require:

```http
Content-Type: application/json
Idempotency-Key: <8-128 safe characters>
```

```json
{"jid":"2348012345678@s.whatsapp.net","text":"hello"}
```

The API returns `ACTIVE`, `DISCONNECTED`, `FROZEN`, `PAIRING`, `PURGED`, or `UNAVAILABLE` state. When a session is not available, the request returns a structured 503 response instead of throwing or exposing credentials.

## Deployment

Put the Omega web server behind HTTPS and a firewall/reverse proxy. Restrict access to the Waiq VPS where possible. Do not expose the session workspace or Baileys socket directly. The remote API serializes only session descriptors and message delivery results.
