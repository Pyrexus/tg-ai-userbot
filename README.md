<div align="center">

# ⚡ TG AI Userbot (Solo / Self-Hosted Edition)
### *Ultra-Fast • 100% Private • Cloudflare-Native • 24/7 Serverless Telegram Assistant*

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers_%26_D1-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Groq AI](https://img.shields.io/badge/Groq-Qwen_3.8_27B-f55036?style=for-the-badge)](https://groq.com)
[![MTProto](https://img.shields.io/badge/Telegram-mtcute-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://github.com/delivrance/mtcute)

<br/>

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Pyrexus/tg-ai-userbot)

<br/>

> **Transform your Telegram account into an intelligent 24/7 AI-powered power-user.**  
> Self-hosted on your personal Cloudflare account with zero server maintenance, zero subscription costs, and total data privacy.

</div>

---

## 🛡️ Why This Architecture?

<table>
<tr>
<td width="50%">

### 🔒 100% Data Safe & Private
Your session keys, credentials, and message logs live strictly inside **your personal Cloudflare account** (Cloudflare D1 / Cloud SQLite). No third-party servers, no middleman tracking, no external data brokers. You own your keys and your database.

</td>
<td width="50%">

### ⚡ Ultra-Fast Edge Execution
Deploys instantly across **Cloudflare's global edge network (300+ cities worldwide)**. Commands execute with sub-100ms roundtrip speeds and zero cold-start delay.

</td>
</tr>
<tr>
<td width="50%">

### 🧠 Beautiful In-Chat AI Answers
Ask anything using `.ai` or `.ask` in any chat, group, or DM. Your message edits in-place with clean Telegram HTML formatting—bold headings, quote callouts, code syntax highlighting, and spoiler tags.

</td>
<td width="50%">

### 🌐 Live Real-Time Web Search
Powered by **Tavily Search**, automatically fetching up-to-the-minute real-world facts, live cricket scores, breaking news, weather updates, and cryptocurrency prices without leaving Telegram.

</td>
</tr>
</table>

---

## ✨ Full Command & Feature Suite

### 🤖 AI & Intelligent Assistant
| Command | Syntax | Purpose & Description |
| :--- | :--- | :--- |
| **Ask AI** | `.ai <question>` / `.ask <question>` | Replaces your command in-place with an intelligent, formatted AI response. Adapts tone to chat vibe (Hinglish/English). |
| **Contextual Reply** | Reply with `.ai` | Analyzes replied message, thread context, or recent conversation history before answering. |
| **Live Web Search** | Automatic | Real-time web retrieval triggered on demand for live news, sports, tech releases, and current events. |

### 🧹 Chat Cleanup & DM Tools
| Command | Syntax | Purpose & Description |
| :--- | :--- | :--- |
| **Purge Messages** | `.purge` / `.p` *(reply)* | Deletes all messages forward from the replied message for both sides (works in both DMs and groups). |
| **Self Burn** | `.burn` / `.b` | Self-purge: safely cleans up only your own messages with an accurate deleted count counter. |
| **Wipe Bot Msgs** | `.wipe` / `.w` | Mass-deletes bot messages in the current chat (requires group admin delete rights). |

### ⚡ Productivity & Fun Utilities
| Command | Syntax | Purpose & Description |
| :--- | :--- | :--- |
| **Roundtrip Ping** | `.ping` | Instant userbot roundtrip speed check with your Telegram username. |
| **User & Chat ID** | `.id` *(or reply)* | Displays complete metadata: User ID, Chat ID, Name, Username, and Group Join Date. |
| **Quote Sticker** | `.qt` *(reply)* | Transforms any replied text or media into a sleek, customized Telegram quote sticker. |
| **Spam** | `.s <count> <msg>` | Sends repeated messages with a 750ms interval (limit 30, supports user tags & replies). |
| **Fast Spam** | `.fs <count> <msg>` | Fires burst messages instantly all at once (limit 30). |
| **Text Clone** | `.c <count> <text>` | Clones/repeats text inline in bold (limit 100). |

### 🛡️ Group Moderation (Admins Only)
| Command | Syntax | Purpose & Description |
| :--- | :--- | :--- |
| **AI Roast Ban** | `.ban` *(reply)* | Bans the user from the group and generates a brutal, unique 2-line AI roast. |
| **Kick User** | `.kick` *(reply)* | Removes the user from the group without a permanent ban. |
| **Mute User** | `.mute 10m/1h/1d` *(reply)* | Restricts user permissions for the specified timeframe. |
| **Warn User** | `.warn <reason>` *(reply)* | Issues a warning (3-strike limit automatically triggers a group ban). |
| **Promote / Demote** | `.promote` / `.demote` *(reply)* | Modifies admin privileges with automated permission validation. |

---

## 🚀 1-Click Deployment (Recommended)

1. Click the **[Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)** button.
2. Sign in with your Cloudflare account.
3. Fill in your environment variables:
   - `BOT_TOKEN` — From [@BotFather](https://t.me/BotFather)
   - `API_ID` & `API_HASH` — From [my.telegram.org](https://my.telegram.org)
   - `GROQ_API_KEY` — Free API key from [console.groq.com](https://console.groq.com)
   - `TAVILY_API_KEY` — Free API key from [tavily.com](https://tavily.com)
   - `SESSION_KEY` — Random 32-character string for AES-256-GCM encryption
   - `WEBHOOK_SECRET` — Random secret string for Telegram webhook validation
   - `SETUP_KEY` — Custom secret string to authorize the `/setup` endpoint
   - `ADMIN_CODE` — 4-digit passcode for your web dashboard (`/admin`)
4. Cloudflare provisions your Worker, Durable Object, and **Cloudflare D1 Database** automatically.
5. **Initialize Webhook (One-Time)**:
   Visit in your browser:
   ```text
   https://<your-worker-subdomain>.workers.dev/setup?key=<YOUR_SETUP_KEY>
   ```
6. **Connect Your Telegram Account**:
   - Open your login bot in Telegram DM.
   - Tap **🔑 Connect Account** and enter your login code with spaces (e.g. `1 2 3 4 5`).
   - The bot locks exclusively to your account and starts running 24/7!

---

## 💻 Manual CLI Deployment

```bash
# 1. Clone repository
git clone https://github.com/Pyrexus/tg-ai-userbot.git
cd tg-ai-userbot
npm install

# 2. Provision Cloudflare D1 Database
npx wrangler d1 create tg-ai-userbot-db
# Paste the returned database_id into wrangler.toml under [[d1_databases]]

# 3. Configure secrets
cp secrets.example.json secrets.json
# Fill in your API credentials in secrets.json

# 4. Upload secrets and deploy
npx wrangler secret bulk secrets.json
npx wrangler deploy

# 5. Initialize Webhook
curl "https://<your-worker>.workers.dev/setup?key=<YOUR_SETUP_KEY>"
```

---

## 📊 Glassmorphism Web Dashboard

Access your live analytics dashboard anytime by visiting:
```text
https://<your-worker>.workers.dev/admin
```
- **Live System Health**: Ping latency and status for Cloudflare D1, Groq Qwen, Tavily, and Telegram Bot API.
- **Message Analytics**: Real-time counters for 24h, 7d, 30d, and all-time commands.
- **CSV Data Backups**: One-click download of message logs and session records.

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)** — see the [LICENSE](LICENSE) file for details.
All users have the freedom to run, study, share, and modify the software.
