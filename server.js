'use strict';

// Tiny built-in .env loader (no "dotenv" dependency) - reads KEY=VALUE lines next to this file,
// without overriding anything already set in the real process environment (e.g. by a service manager).
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = (match[2] || '').trim();
      }
    }
  }
} catch {
  // Non-fatal - falls back to whatever is already in process.env / the hardcoded defaults below.
}

const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3900;
const API_KEY = process.env.API_KEY || 'CHANGE_THIS_SHARED_SECRET';

let client = null;
let connecting = false;
let connected = false;
let lastError = null;
// Rendered as a data: URL so the .NET admin page can <img> it directly - no separate image
// endpoint/CORS concern. Cleared once linked; whatsapp-web.js re-fires 'qr' with a fresh code
// roughly every ~20-60s until someone actually scans it, so this always reflects the latest one.
let latestQrDataUrl = null;

/**
 * Builds a fresh Client and starts it. Called at boot, and again after /disconnect - a new instance
 * is used each time rather than reusing one across a full disconnect/reconnect cycle, since
 * whatsapp-web.js's own puppeteer session is torn down by logout() and isn't meant to be
 * re-initialized in place.
 */
function startClient() {
  if (connecting || connected) return;
  connecting = true;
  lastError = null;
  latestQrDataUrl = null;

  // Session persistence via LocalAuth means the QR code only needs to be scanned once - it's saved
  // to .wwebjs_auth/ and reused across restarts, same as any other WhatsApp Web login.
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    // whatsapp-web.js ships with a WhatsApp Web version frozen at publish time. Resuming an
    // already-linked session tolerates that, but WhatsApp's servers reject brand-new device
    // pairing (fresh QR scans) against a stale/unsupported version - surfaced on the phone as
    // "Can't link new devices right now". Pulling a current version from a maintained archive
    // instead fixes first-time linking on freshly deployed instances.
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
    }
  });

  client.on('qr', (qr) => {
    connected = false;
    console.log('Scan this QR code with WhatsApp (Linked Devices) to connect:');
    qrcodeTerminal.generate(qr, { small: true });
    qrcode
      .toDataURL(qr)
      .then((dataUrl) => {
        latestQrDataUrl = dataUrl;
      })
      .catch((err) => console.error('Failed to render QR code as an image:', err.message));
  });

  client.on('ready', () => {
    connecting = false;
    connected = true;
    lastError = null;
    latestQrDataUrl = null;
    console.log('WhatsApp client is ready.');
  });

  client.on('disconnected', (reason) => {
    connecting = false;
    connected = false;
    lastError = `Disconnected: ${reason}`;
    console.error(lastError);
  });

  client.on('auth_failure', (message) => {
    connecting = false;
    connected = false;
    lastError = `Auth failure: ${message}`;
    console.error(lastError);
  });

  client.initialize().catch((err) => {
    connecting = false;
    lastError = err.message || 'Failed to start the WhatsApp session.';
    console.error(lastError);
  });
}

startClient();

const app = express();

app.use(express.json({ limit: '25mb' }));

// Not exposed to the internet - internal network only, and every request still needs the shared
// secret the .NET side sends via X-Api-Key (see WhatsAppClientOptions/DependencyInjection.cs there).
app.use((req, res, next) => {
  if (req.get('X-Api-Key') !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
});

app.get('/status', (req, res) => {
  res.json({ connected, error: connected ? null : lastError, qrCode: connected ? null : latestQrDataUrl });
});

app.post('/connect', (req, res) => {
  if (connected) return res.json({ success: true, alreadyConnected: true });
  startClient();
  res.json({ success: true });
});

app.post('/disconnect', async (req, res) => {
  if (!client) {
    return res.status(400).json({ error: 'No active WhatsApp session to disconnect.' });
  }

  try {
    // logout() clears the LocalAuth session data too, so reconnecting afterwards always requires a
    // fresh QR scan rather than silently resuming the old one.
    await client.logout();
  } catch (err) {
    // Still treat as disconnected below even if logout() itself errored (e.g. the session had
    // already dropped) - forcing a stuck "connected" state to clear is more useful than surfacing
    // a logout error for a session that isn't actually usable anyway.
    console.error('Error during WhatsApp logout:', err.message);
  }

  connected = false;
  connecting = false;
  latestQrDataUrl = null;
  client = null;
  res.json({ success: true });
});

app.post('/send', async (req, res) => {
  const { phoneNumber, message, attachment } = req.body || {};

  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber and message are both required.' });
  }

  if (!connected) {
    return res.status(503).json({ error: 'WhatsApp session is not connected yet - scan the QR code first.' });
  }

  try {
    // whatsapp-web.js expects "<countrycode><number>@c.us" - the .NET side already normalizes to a
    // bare digit-only number with country code (e.g. "201012345678") before calling this endpoint.
    const chatId = `${phoneNumber}@c.us`;

    if (attachment && attachment.base64) {
      // Send the file as media with the message as its caption, so it arrives as a single bubble
      // (e.g. the order-confirmed message with its invoice PDF attached) instead of two separate sends.
      const media = new MessageMedia(attachment.mimeType, attachment.base64, attachment.fileName);
      await client.sendMessage(chatId, media, { caption: message });
    } else {
      await client.sendMessage(chatId, message);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to send message.' });
  }
});

app.listen(PORT, () => {
  console.log(`whatsapp-service listening on port ${PORT}`);
});
