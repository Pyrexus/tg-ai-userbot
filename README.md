# ⚡ TG AI Userbot

Serverless 24/7 Telegram AI Userbot running on **Cloudflare Workers + Durable Objects**, powered by **mtcute**, **Groq (`qwen/qwen3.8-27b`)**, **Tavily Web Search**, and **Turso (libSQL)** with AES-256-GCM encrypted sessions.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Pyrexus/tg-ai-userbot)

---

## ✨ Features

- **In-Chat AI (`.ai` / `.ask`)** — Edits your message in place with context from reply threads & recent chat, formatted in clean Telegram HTML.
- **Live Web Search** — Automatic Tavily search tool for real-time news, prices, weather, and current facts.
- **Chat Cleanup Commands**:
  - `.p` / `.purge` — Reply to any message to delete all messages from that point forward (both sides).
  - `.w` / `.wipe` — Deletes all bot messages in the chat (admin check in groups/channels).
  - `.b` / `.burn` — Self-purge: deletes only your own messages.
- **Zero-Server Persistence** — Each user runs in an isolated Cloudflare Durable Object with auto-wake alarms and cron keep-alive.
- **Encrypted Cloud Storage** — Sessions are encrypted with AES-256-GCM before being stored in Turso.
- **Admin Control Panel** — Hidden `/admin` bot command + live glassmorphism Web Dashboard (`/admin`) with stats, API/DB health checks, and CSV backups.

---

## 🚀 Quick Setup

1. **Clone & install**
   ```bash
   git clone https://github.com/Pyrexus/tg-ai-userbot.git
   cd tg-ai-userbot
   npm install
   ```

2. **Configure secrets**
   ```bash
   cp secrets.example.json secrets.json
   ```
   Fill in your credentials in `secrets.json`:
   - `BOT_TOKEN` — Telegram bot token from `@BotFather`
   - `API_ID` & `API_HASH` — From [my.telegram.org](https://my.telegram.org)
   - `TURSO_URL` & `TURSO_TOKEN` — From [turso.tech](https://turso.tech)
   - `GROQ_API_KEY` — From [console.groq.com](https://console.groq.com)
   - `TAVILY_API_KEY` — From [tavily.com](https://tavily.com)
   - `SESSION_KEY`, `WEBHOOK_SECRET`, `SETUP_KEY`, `ADMIN_CODE`

3. **Upload secrets & deploy**
   ```bash
   npm run secrets
   npm run deploy
   ```

4. **Initialize DB & Webhook (once)**
   Open in your browser:
   ```text
   https://<your-worker>.workers.dev/setup?key=<SETUP_KEY>
   ```

5. **Connect your account**
   Open your login bot in Telegram DM, tap **🔑 Connect Account**, share your phone number, and send the login code **with spaces** (e.g. `1 2 3 4 5`).

---

## 🛠️ Commands

| Command | Description |
| :--- | :--- |
| `.ai <question>` / `.ask <question>` | Ask AI (also works by replying to a message) |
| `.s <count> <msg>` / `.fs <count> <msg>` | Spam (750ms delay) or fast spam (max 30, supports mentions & replies) |
| `.c <count> <text>` | Clone text inline in bold (max 100) |
| `.id` | Show user & chat info (supports reply) |
| `.ping` | Check userbot roundtrip latency |
| `.qt` | Turn replied message into a quote sticker (LyoSU `quote-api`) |
| `.purge` / `.w` / `.b` | Purge all, wipe bot messages, or burn your own messages |
| Admin commands | Group/channel admin moderation & management commands |
| `/admin` *(Bot DM)* | Open hidden Admin Control Panel (passcode via `ADMIN_CODE`) |
