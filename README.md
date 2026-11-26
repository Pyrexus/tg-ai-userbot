# ⚡ TG AI Userbot (Solo / Self-Hosted Edition)

Serverless 24/7 Telegram AI Userbot running on **Cloudflare Workers + Cloudflare D1 (SQL) + Durable Objects**, powered by **mtcute**, **Groq (`qwen/qwen3.8-27b`)**, **Tavily Web Search**, and AES-256-GCM encrypted sessions.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Pyrexus/tg-ai-userbot)

---

## 🌟 Why Solo / Self-Hosted?

- **100% Cloudflare Native**: Uses **Cloudflare D1 (Serverless SQLite)** for data storage. No external database services (like Turso) required!
- **Zero Free-Tier Quota Issues**: Built as a dedicated single-user instance. Exactly **1 Durable Object** runs on your account, staying well within Cloudflare's free limits.
- **Private Solo Lock**: The bot automatically locks to the first Telegram account that connects. Any other user messaging the bot is rejected with an access-denied screen.
- **1-Click Deployment**: Deploy directly into your Cloudflare account using the Cloudflare Workers Deploy button.

---

## ✨ Features

- **In-Chat AI (`.ai` / `.ask`)** — Edits your message in place with context from reply threads & recent chat in Romanized Hindi/Hinglish or English.
- **Real-Time Web Search** — Automatic Tavily search integration for live news, weather, prices, and facts.
- **Quote Stickers (`.qt`)** — Generates high-quality quote stickers from replied messages via Cloudflare quote rendering worker.
- **Chat Cleanup Commands**:
  - `.purge` / `.p` — Purges messages forward from the replied message (both sides, works in groups & DMs).
  - `.wipe` / `.w` — Deletes bot messages in the chat.
  - `.burn` / `.b` — Deletes only your own messages with accurate deleted counts.
- **Fun & Productivity**:
  - `.s <count> <msg>` / `.fs <count> <msg>` — Spam / fast spam (supports user mentions & replies).
  - `.c <count> <text>` — Inline clone repetitions in bold.
  - `.id` — Displays detailed user and chat metadata.
  - `.ping` — Instant userbot roundtrip latency with your username.
- **Group Moderation**:
  - `.ban`, `.kick`, `.mute`, `.warn`, `.promote`, `.demote` with permissions validation.
- **Admin Control Panel**:
  - Hidden `/admin` command in the login bot + web dashboard with analytics, API health checks, and CSV log backups.

---

## 🚀 1-Click Deployment (Recommended)

1. Click the **[Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/?url=https://github.com/Pyrexus/tg-ai-userbot)** button above.
2. Sign in to your Cloudflare account.
3. Fill in the prompted environment variables:
   - `BOT_TOKEN` — Telegram Bot Token from [@BotFather](https://t.me/BotFather)
   - `API_ID` & `API_HASH` — Obtained from [my.telegram.org](https://my.telegram.org)
   - `GROQ_API_KEY` — Free API key from [console.groq.com](https://console.groq.com)
   - `TAVILY_API_KEY` — Free API key from [tavily.com](https://tavily.com)
   - `SESSION_KEY` — Any random 32-character secret string
   - `WEBHOOK_SECRET` — Any random secret string for Telegram webhook validation
   - `SETUP_KEY` — Any random passphrase for the `/setup` initialization URL
   - `ADMIN_CODE` — 4-digit numeric passcode to access the `/admin` dashboard (e.g. `4847`)
4. Cloudflare will automatically provision your Worker, Durable Object, and **Cloudflare D1 Database** in one step!
5. **One-Time Webhook Setup**:
   Open in your browser:
   ```text
   https://<your-worker-subdomain>.workers.dev/setup?key=<YOUR_SETUP_KEY>
   ```
6. **Connect Your Telegram Account**:
   - Open your Telegram bot in DM.
   - Tap **🔑 Connect Account**.
   - Provide your phone number and enter the verification code sent to your Telegram.
   - Once connected, the userbot locks to your account and runs 24/7!

---

## 🛠️ Manual Deployment via CLI

```bash
# 1. Clone repository
git clone https://github.com/Pyrexus/tg-ai-userbot.git
cd tg-ai-userbot
npm install

# 2. Create Cloudflare D1 Database
npx wrangler d1 create tg-ai-userbot-db
# Copy the returned database_id into wrangler.toml under [[d1_databases]]

# 3. Configure secrets
cp secrets.example.json secrets.json
# Edit secrets.json with your credentials

# 4. Upload secrets and deploy
npx wrangler secret bulk secrets.json
npx wrangler deploy

# 5. Initialize Webhook
curl "https://<your-worker>.workers.dev/setup?key=<YOUR_SETUP_KEY>"
```

---

## 📜 License

MIT License. Built for community self-hosting with zero server maintenance.
