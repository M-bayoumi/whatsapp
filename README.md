# whatsapp-service

Minimal internal-network bridge in front of a persistent WhatsApp session ([Baileys](https://github.com/WhiskeySockets/Baileys)), used by the NexusEcommerce backend's WhatsApp notification outbox. Kept as a separate process/project from the .NET backend on purpose. Talks WhatsApp's multi-device protocol directly over a WebSocket - no headless browser involved, unlike the earlier `whatsapp-web.js`-based version.

## Setup

```bash
cd whatsapp-service
npm install
copy .env.example .env   # then edit API_KEY to match backend appsettings' WhatsApp:ApiKey
npm start
```

On first run, scan the printed QR code with WhatsApp on your phone (Linked Devices -> Link a Device). The session is saved to `baileys_auth/` and reused on every restart - no need to scan again unless that folder is deleted or the device is unlinked from your phone.

## Endpoints

Every request must send the header `X-Api-Key: <API_KEY>` (must match the backend's `WhatsApp:ApiKey` config).

- `GET /status` -> `{ connected: boolean, error: string | null }`
- `POST /send` -> body `{ phoneNumber: string, message: string }` (phoneNumber is digits-only with country code, e.g. `201012345678`) -> `{ success: true }` or `4xx/5xx` with `{ error }`

## Deployment note

Not meant to be exposed to the internet - run it on the same internal network as the .NET backend, which is the only client that calls it (see `IWhatsAppClient`/`WhatsAppDispatcherBackgroundService` in `NexusEcommerce.BLL`).
