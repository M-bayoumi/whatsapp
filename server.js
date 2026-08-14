"use strict";

const fs = require("fs");
const path = require("path");

// Tiny built-in .env loader (no "dotenv" dependency) - reads KEY=VALUE lines next to this file,
// without overriding anything already set in the real process environment (e.g. by a service manager).
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = (match[2] || "").trim();
      }
    }
  }
} catch {
  // Non-fatal - falls back to whatever is already in process.env / the hardcoded defaults below.
}

const express = require("express");
const qrcodeTerminal = require("qrcode-terminal");
const qrcode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3900;
const API_KEY =
  process.env.API_KEY || "130409cc4b486507751fde48ad4b2a7c44b29a14e76c4ad6";
const AUTH_DIR = path.join(__dirname, "baileys_auth");

let sock = null;
let connecting = false;
let connected = false;
let lastError = null;
// Rendered as a data: URL so the .NET admin page can <img> it directly - no separate image
// endpoint/CORS concern. Cleared once linked; Baileys re-fires a fresh QR string roughly every
// ~20-60s until someone actually scans it, so this always reflects the latest one.
let latestQrDataUrl = null;

/**
 * Connects (or reconnects) the Baileys socket. Called at boot, again after /disconnect, and
 * automatically on any non-logout disconnect - Baileys expects the caller to handle reconnects
 * itself rather than doing it internally.
 *
 * Unlike whatsapp-web.js, there's no headless browser here at all: Baileys talks WhatsApp's
 * multi-device protocol directly over a WebSocket, which is why this needs a small fraction of
 * the CPU/RAM a Puppeteer-driven Chromium instance did (that gap was the root cause of the
 * out-of-memory crashes on Railway's 1GB plan).
 */
async function startClient() {
  if (connecting || connected) return;
  connecting = true;
  lastError = null;
  latestQrDataUrl = null;

  try {
    // Session persistence means the QR code only needs to be scanned once - it's saved to
    // baileys_auth/ and reused across restarts, same as any other WhatsApp Web login.
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // Always resolves the WhatsApp Web version currently supported by WhatsApp's servers, instead
    // of a version frozen at package-publish time - this is what avoided the "Can't link new
    // devices right now" pairing rejection whatsapp-web.js's bundled version ran into.
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connected = false;
        console.log(
          "Scan this QR code with WhatsApp (Linked Devices) to connect:",
        );
        qrcodeTerminal.generate(qr, { small: true });
        try {
          latestQrDataUrl = await qrcode.toDataURL(qr);
        } catch (err) {
          console.error("Failed to render QR code as an image:", err.message);
        }
      }

      if (connection === "open") {
        connecting = false;
        connected = true;
        lastError = null;
        latestQrDataUrl = null;
        console.log("WhatsApp client is ready.");
      }

      if (connection === "close") {
        connecting = false;
        connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        lastError = lastDisconnect?.error?.message || "Disconnected";
        console.error(`Disconnected: ${lastError}`);

        if (!loggedOut) {
          // Transient drop (network blip, server-side restart, etc.) - reconnect automatically
          // using the saved credentials, same as whatsapp-web.js resuming a persisted session.
          // A short delay avoids hammering WhatsApp with instant reconnect attempts if the drop
          // keeps recurring.
          setTimeout(() => {
            startClient().catch((err) => {
              connecting = false;
              lastError =
                err.message || "Failed to reconnect the WhatsApp session.";
              console.error(lastError);
            });
          }, 3000);
        }
      }
    });
  } catch (err) {
    connecting = false;
    lastError = err.message || "Failed to start the WhatsApp session.";
    console.error(lastError);
  }
}

startClient();

const app = express();

// Default express.json() body limit is 100kb - too small once a message carries a base64-encoded
// attachment.
app.use(express.json({ limit: "25mb" }));

// Not exposed to the internet - internal network only, and every request still needs the shared
// secret the .NET side sends via X-Api-Key (see WhatsAppClientOptions/DependencyInjection.cs there).
app.use((req, res, next) => {
  if (req.get("X-Api-Key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }
  next();
});

app.get("/status", (req, res) => {
  res.json({
    connected,
    error: connected ? null : lastError,
    qrCode: connected ? null : latestQrDataUrl,
  });
});

app.post("/connect", (req, res) => {
  if (connected) return res.json({ success: true, alreadyConnected: true });
  startClient();
  res.json({ success: true });
});

app.post("/disconnect", async (req, res) => {
  if (!sock) {
    return res
      .status(400)
      .json({ error: "No active WhatsApp session to disconnect." });
  }

  try {
    // logout() invalidates the session on WhatsApp's side too, so reconnecting afterwards always
    // requires a fresh QR scan rather than silently resuming the old one.
    await sock.logout();
  } catch (err) {
    // Still treat as disconnected below even if logout() itself errored (e.g. the session had
    // already dropped) - forcing a stuck "connected" state to clear is more useful than surfacing
    // a logout error for a session that isn't actually usable anyway.
    console.error("Error during WhatsApp logout:", err.message);
  }

  connected = false;
  connecting = false;
  latestQrDataUrl = null;
  sock = null;

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error("Failed to clear stored session:", err.message);
  }

  res.json({ success: true });
});

app.post("/send", async (req, res) => {
  const { phoneNumber, message, attachment } = req.body || {};

  if (!phoneNumber || !message) {
    return res
      .status(400)
      .json({ error: "phoneNumber and message are both required." });
  }

  if (!connected) {
    return res
      .status(503)
      .json({
        error:
          "WhatsApp session is not connected yet - scan the QR code first.",
      });
  }

  try {
    // Baileys expects "<countrycode><number>@s.whatsapp.net" - the .NET side already normalizes
    // to a bare digit-only number with country code (e.g. "201012345678") before calling this
    // endpoint.
    const jid = `${phoneNumber}@s.whatsapp.net`;

    const sendPromise =
      attachment && attachment.base64
        ? sock.sendMessage(jid, {
            document: Buffer.from(attachment.base64, "base64"),
            mimetype: attachment.mimeType,
            fileName: attachment.fileName,
            caption: message,
          })
        : sock.sendMessage(jid, { text: message });

    // Sent directly over the WebSocket (no browser DOM/media upload to get stuck in), so this
    // should resolve in a couple of seconds - but fail fast with a clear error instead of hanging
    // indefinitely if WhatsApp's servers stop responding mid-send.
    const timeoutMs = attachment ? 60_000 : 20_000;
    await Promise.race([
      sendPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Send timed out after ${timeoutMs / 1000}s.`)),
          timeoutMs,
        ),
      ),
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to send message." });
  }
});

app.listen(PORT, () => {
  console.log(`whatsapp-service listening on port ${PORT}`);
});
