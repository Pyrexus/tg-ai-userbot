import { DurableObject } from 'cloudflare:workers'
import { TelegramClient, MemoryStorage, WebCryptoProvider } from '@mtcute/web'
import { thtml, html } from '@mtcute/html-parser'
import { handleSpam, handleClone, handleId, handlePing, handleMod, handleCleanup, handleQuote, CmdDeps } from './commands'
// Workers can't compile wasm at runtime, so load it precompiled (wrangler bundles this import).
// @ts-ignore
import wasmModule from '@mtcute/wasm/mtcute.wasm'
import { initSync } from '@mtcute/wasm'

initSync(wasmModule)

class WorkerCryptoProvider extends WebCryptoProvider {
  constructor() {
    super({ wasmInput: wasmModule })
  }
  async initialize() {
    // WebAssembly is already initialized synchronously via initSync(wasmModule)
  }
}

interface Env {
  USERBOT: DurableObjectNamespace
  DB?: D1Database
  BOT_TOKEN: string
  API_ID: string
  API_HASH: string
  GROQ_API_KEY: string
  GROQ_MODELS?: string
  TAVILY_API_KEY: string
  SESSION_KEY: string
  WEBHOOK_SECRET: string
  SETUP_KEY: string
  ADMIN_CODE?: string
  QUOTE_API_URL?: string
}

/* ───────────── Cloudflare D1 (Serverless SQLite) ───────────── */
async function dbQuery(env: Env, sql: string, args: any[] = []): Promise<string[][]> {
  if (env.DB) {
    try {
      const trimmed = sql.trim().toUpperCase()
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
        const stmt = env.DB.prepare(sql).bind(...args)
        const raw: any = await stmt.raw()
        return (raw || []).map((row: any[]) => row.map(c => (c !== null && c !== undefined) ? String(c) : ''))
      } else {
        await env.DB.prepare(sql).bind(...args).run()
        return []
      }
    } catch (e: any) {
      console.error('D1 query error:', sql, e)
      throw e
    }
  }
  return []
}

async function initTables(env: Env) {
  if (env.DB) {
    try {
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS users (tg_id TEXT PRIMARY KEY, session TEXT NOT NULL, created_at TEXT);
        CREATE TABLE IF NOT EXISTS message_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT NOT NULL, chat_id TEXT, command TEXT, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS warns (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, user_id));
        CREATE INDEX IF NOT EXISTS idx_msg_logs_created ON message_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_msg_logs_tg_id ON message_logs(tg_id);
      `)
    } catch (e) {
      console.error('initTables error:', e)
    }
  }
}

/* ───────────── AES-GCM for sessions ───────────── */
async function aesKey(env: Env) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SESSION_KEY))
  return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
async function encrypt(env: Env, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text)))
  return b64(iv) + '.' + b64(ct)
}
async function decrypt(env: Env, blob: string) {
  const [iv, ct] = blob.split('.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct))
  return new TextDecoder().decode(pt)
}

/* ───────────── Bot API helper ───────────── */
async function bot(env: Env, method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const json: any = await r.json().catch(() => null)
  if (!json?.ok && body?.message_effect_id) {
    const fallbackBody = { ...body }
    delete fallbackBody.message_effect_id
    const r2 = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fallbackBody),
    })
    return r2.json().catch(() => json) as Promise<any>
  }
  return json as Promise<any>
}

/* ───────────── HTML helpers ───────────── */
const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const ALLOWED = /^<\/?(b|i|u|s|tg-spoiler|a|code|pre|blockquote)(\s[^<>]*)?>$/i

function sanitize(htmlText: string): string {
  const normalized = String(htmlText || '')
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  const parts = normalized.split(/(<[^<>]*>)/g)
  const out: string[] = []
  const stack: string[] = []
  for (const p of parts) {
    if (p.startsWith('<') && p.endsWith('>') && ALLOWED.test(p)) {
      const m = p.match(/^<(\/?)([a-z-]+)/i)!
      const name = m[2].toLowerCase()
      if (m[1]) {
        const idx = stack.lastIndexOf(name)
        if (idx !== -1) {
          while (stack.length - 1 > idx) {
            out.push(`</${stack.pop()}>`)
          }
          stack.pop()
          out.push(p)
        }
      } else {
        stack.push(name)
        out.push(p)
      }
    } else {
      out.push(p.replace(/&(?!(amp|lt|gt|quot);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`)
  return out.join('').trim()
}
const stripTags = (h: string) => h.replace(/<[^<>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/* ───────────── Persona / system prompt ───────────── */
function systemPrompt(owner: string, chatName: string, wantLong: boolean) {
  const who = (chatName || 'friend').split(' ')[0]
  return `You are the AI inside a Telegram userbot. ${owner} types a command (.ai / .ask) in a chat and your answer replaces their message, so EVERYONE in the chat (${chatName}) reads it. Write like a smart, funny, emotionally aware friend from India chatting on Telegram. Never sound like a bot, teacher, or customer support. Today: ${new Date().toDateString()}.

── 1. LANGUAGE ──
- Reply in the same language the question is in.
- Hindi/Hinglish question -> answer in ROMANIZED Hindi (Hinglish). NEVER use Devanagari script.
- English question -> English only. Mixed -> follow the dominant language.
- Match spelling style: if they type lazy ("kya kr rha", "plz", "okkk"), you may be casual too. If they write clean English, stay clean.

── 2. READ THE ROOM FIRST ──
Before writing, silently check the question + [replied thread] + [recent chat] for:
mood (happy / sad / angry / bored / flirty / serious), energy (hyper vs calm), accent (Hindi, Hinglish, English, slang level), relationship (close friend, crush, group, stranger), and topic (fun vs serious).
Then mirror it:
- hyped -> hyped | sad -> soft, caring, zero jokes | joking -> joke back | flirty -> playful and warm, never creepy | angry -> calm and short | serious/study/work/tech -> clean, sharp, minimal emojis.
- Never be more intense than the user. Don't force slang or flirting if the vibe isn't there.
- If the question is a reply to someone's message, answer about THAT message using the thread (who said what).

── 3. LENGTH ──
- If the user specifies a length or structure (e.g. "4 para poem", "8 lines", "200 words", "story"), follow THEIR exact request freely without cutting it short.
- Otherwise: default 2 to 6 visual lines, max 10 lines.
- ${wantLong ? 'The user asked for a detailed/long/multi-part answer, so write freely in full (12 to 25+ lines if needed). Split into small sections or stanzas with bold titles. Still no fluff, no repeating yourself.' : 'Stay short unless the user asks for detail/brief/in depth/explain fully or specifies a length.'}
- Give exactly what they intended. No warm-up lines ("Sure", "Great question", "Here you go"), no repeating the question, no disclaimers, no "as an AI", no apologies, no summary at the end, no signature or footer.

── 4. WRITING STYLE (very important) ──
Human chat tone, tight and clean:
- Short lines. One idea per line. Break lines instead of stacking commas.
- Do NOT end lines with full stops. Use at most ONE "!" or "?" in the whole answer. No "...!!!". No ellipsis spam.
- No em dash or en dash. No semicolons. No parentheses unless truly needed. Colons only in a title line.
- No filler like "basically", "overall", "in conclusion", "it's important to note".
- Casual words are welcome: okie 🥺, okk, k, ohhhk, got it, gotcha, hn bhai, acha, arre, chal, scene, bro, yaar, sahi hai.
- Light friendly roasting is allowed in joking chats: bhondu, pagal, vela, gareeb insan, dale, nalla, chapri. Keep it playful. NEVER abuse involving family (maa/behen), never hateful, never sexual, never on sensitive topics (death, illness, exams failing, religion, body).
- Be smart: correct facts, real insight, a tiny bit of personality. If unsure, say so in a few words, don't invent.

── 5. EMOJIS ──
- 1 to 4 emojis per answer, placed naturally (end of a line or after a key word).
- Allowed favorites: 🥺 😭 🤌 💀 ✨ 👀 🫂 💅 🫶 🫡 🫠 😌 🚀 🔥 💯
- NEVER spam emojis. NEVER put 3 emojis in a row.

── 6. TELEGRAM HTML FORMATTING ──
Use Telegram HTML tags purposefully:
- <b>bold</b> for the first line/title or a punchy takeaway
- <i>italic</i> for an internal thought, aside, soft tone, or punchline
- <code>inline code</code> for commands, numbers, shortcuts, or hex
- <pre><code class="language-python">code block</code></pre> for any code snippet
- <blockquote>quote block</blockquote> for key rules, tips, quotes, or punchlines
- <tg-spoiler>spoiler</tg-spoiler> for the punchline of a joke or a surprise
- NEVER use markdown (*, _, \`, #). NEVER invent custom tags. Every opened tag MUST be closed.

── 7. ACCURACY (Tavily search) ──
- A web_search tool is available. Call it whenever the question is about:
  current events, today's news, live cricket/sports scores, recent releases, tech specs, stock/crypto prices, weather, people, or any factual claim you are not 100% sure about.
- NEVER guess real-world facts. Search first, then write the answer in the persona.

── FINAL CHECK BEFORE SENDING ──
Right language? Right mood? Short enough? Line 1 plain or bold? No markdown, no header, no signature? Max one "!"? Spoiler on punchline? Tags closed? Emojis natural, 1 to 4? Would a real friend send this? If yes, send.`
}

/* ───────────── Groq + Tavily ───────────── */
async function tavily(env: Env, query: string) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: 4, include_answer: true }),
    })
    const j: any = await r.json()
    return JSON.stringify({
      answer: j.answer,
      results: (j.results || []).map((x: any) => ({ title: x.title, url: x.url, snippet: String(x.content || '').slice(0, 350) })),
    })
  } catch (e) { return 'search failed' }
}

const GROQ_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']

async function askAI(env: Env, system: string, userMsg: string, wantLong: boolean): Promise<string> {
  const models = (env.GROQ_MODELS || '').split(',').map(s => s.trim()).filter(Boolean)
  const candidates = models.length ? models : GROQ_MODELS
  const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: userMsg }]
  const tools = [{ type: 'function', function: {
    name: 'web_search', description: 'Search the web for current/real-world info',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  } }]

  for (const model of candidates) {
    try {
      for (let round = 0; round < 3; round++) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages, tools: round < 2 ? tools : undefined,
            temperature: 0.8, max_tokens: wantLong ? 3000 : 1800,
            ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
          }),
        })
        const j: any = await r.json()
        const m = j.choices?.[0]?.message
        if (!m) throw new Error('groq ' + model + ': ' + JSON.stringify(j).slice(0, 300))
        if (m.tool_calls?.length) {
          messages.push(m)
          for (const tc of m.tool_calls) {
            let q = ''
            try { q = JSON.parse(tc.function.arguments).query } catch {}
            messages.push({ role: 'tool', tool_call_id: tc.id, content: await tavily(env, q) })
          }
          continue
        }
        const content = String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        if (!content) throw new Error('groq ' + model + ': empty content')
        if (wantLong && content.length < 40 && j.choices?.[0]?.finish_reason === 'length') {
          throw new Error('groq ' + model + ': truncated at title')
        }
        return content
      }
      return 'hmm kuch gadbad ho gayi 😭'
    } catch (e) {
      console.error('groq model failed:', model, e)
    }
  }
  throw new Error('all groq models failed')
}

/* ───────────── Admin & Stats Helpers (Solo) ───────────── */
interface AdminStats {
  ownerId: string
  active: boolean
  dailyMsgs: number
  weeklyMsgs: number
  monthlyMsgs: number
  allTimeMsgs: number
  topUsers: Array<{ tgId: string; count: number }>
  dbHealth: { status: boolean; latencyMs: number; error?: string }
  groqHealth: { status: boolean; latencyMs: number; error?: string }
  tavilyHealth: { status: boolean; latencyMs: number; error?: string }
  tgHealth: { status: boolean; latencyMs: number; error?: string }
}

async function getAdminStats(env: Env): Promise<AdminStats> {
  const dbStart = performance.now()
  let dbHealth: { status: boolean; latencyMs: number; error?: string } = { status: false, latencyMs: 0 }
  let ownerId = 'Not Connected'
  let active = false
  let dailyMsgs = 0
  let weeklyMsgs = 0
  let monthlyMsgs = 0
  let allTimeMsgs = 0
  let topUsers: Array<{ tgId: string; count: number }> = []

  const dbPromise = (async () => {
    try {
      await initTables(env)
      const uRes = await dbQuery(env, "SELECT tg_id FROM users WHERE session IS NOT NULL AND session != '' LIMIT 1")
      if (uRes.length && uRes[0][0]) {
        ownerId = uRes[0][0]
        active = true
      }

      const dRes = await dbQuery(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-1 day')")
      dailyMsgs = Number(dRes[0]?.[0] || 0)

      const wRes = await dbQuery(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-7 days')")
      weeklyMsgs = Number(wRes[0]?.[0] || 0)

      const mRes = await dbQuery(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-30 days')")
      monthlyMsgs = Number(mRes[0]?.[0] || 0)

      const aRes = await dbQuery(env, 'SELECT COUNT(*) FROM message_logs')
      allTimeMsgs = Number(aRes[0]?.[0] || 0)

      const topRes = await dbQuery(env, 'SELECT tg_id, COUNT(*) as cnt FROM message_logs GROUP BY tg_id ORDER BY cnt DESC LIMIT 10')
      topUsers = topRes.map(r => ({ tgId: r[0], count: Number(r[1] || 0) }))

      dbHealth = { status: true, latencyMs: Math.round(performance.now() - dbStart) }
    } catch (e: any) {
      dbHealth = { status: false, latencyMs: Math.round(performance.now() - dbStart), error: String(e?.message || e) }
    }
  })()

  const groqStart = performance.now()
  let groqHealth: { status: boolean; latencyMs: number; error?: string } = { status: false, latencyMs: 0 }
  const groqPromise = (async () => {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      })
      groqHealth = { status: r.ok, latencyMs: Math.round(performance.now() - groqStart), error: r.ok ? undefined : `HTTP ${r.status}` }
    } catch (e: any) {
      groqHealth = { status: false, latencyMs: Math.round(performance.now() - groqStart), error: String(e?.message || e) }
    }
  })()

  const tavilyStart = performance.now()
  let tavilyHealth: { status: boolean; latencyMs: number; error?: string } = { status: false, latencyMs: 0 }
  const tavilyPromise = (async () => {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: 'ping', max_results: 1 }),
      })
      tavilyHealth = { status: r.ok, latencyMs: Math.round(performance.now() - tavilyStart), error: r.ok ? undefined : `HTTP ${r.status}` }
    } catch (e: any) {
      tavilyHealth = { status: false, latencyMs: Math.round(performance.now() - tavilyStart), error: String(e?.message || e) }
    }
  })()

  const tgStart = performance.now()
  let tgHealth: { status: boolean; latencyMs: number; error?: string } = { status: false, latencyMs: 0 }
  const tgPromise = (async () => {
    try {
      const r = await bot(env, 'getMe', {})
      tgHealth = { status: Boolean(r?.ok), latencyMs: Math.round(performance.now() - tgStart), error: r?.ok ? undefined : r?.description || 'Error' }
    } catch (e: any) {
      tgHealth = { status: false, latencyMs: Math.round(performance.now() - tgStart), error: String(e?.message || e) }
    }
  })()

  await Promise.all([dbPromise, groqPromise, tavilyPromise, tgPromise])

  return {
    ownerId,
    active,
    dailyMsgs,
    weeklyMsgs,
    monthlyMsgs,
    allTimeMsgs,
    topUsers,
    dbHealth,
    groqHealth,
    tavilyHealth,
    tgHealth,
  }
}

async function generateCsvData(env: Env, type: 'users' | 'messages' | 'all'): Promise<Record<string, string>> {
  const result: Record<string, string> = {}

  if (type === 'users' || type === 'all') {
    const usersRows = await dbQuery(env, "SELECT tg_id, created_at, (CASE WHEN session IS NOT NULL AND session != '' THEN 'yes' ELSE 'no' END) as active FROM users")
    let csv = 'tg_id,created_at,has_active_session\n'
    for (const r of usersRows) {
      csv += r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',') + '\n'
    }
    result.users = csv
  }

  if (type === 'messages' || type === 'all') {
    const logsRows = await dbQuery(env, 'SELECT id, tg_id, chat_id, command, created_at FROM message_logs ORDER BY id DESC LIMIT 5000')
    let csv = 'id,tg_id,chat_id,command,created_at\n'
    for (const r of logsRows) {
      csv += r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',') + '\n'
    }
    result.messages = csv
  }

  return result
}

async function sendCsvBackupToTelegram(env: Env, chatId: number | string) {
  const data = await generateCsvData(env, 'all')
  const dateStr = new Date().toISOString().slice(0, 10)

  // 1. Users table backup
  const formUsers = new FormData()
  formUsers.append('chat_id', String(chatId))
  formUsers.append('caption', `📦 <b>Solo Userbot Session Backup</b> (${dateStr})`)
  formUsers.append('parse_mode', 'HTML')
  formUsers.append('document', new Blob([data.users], { type: 'text/csv' }), `user_backup_${dateStr}.csv`)

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formUsers,
  })

  // 2. Message logs backup
  const formLogs = new FormData()
  formLogs.append('chat_id', String(chatId))
  formLogs.append('caption', `📊 <b>Message Logs Backup</b> (${dateStr})\nTotal records: ${Math.max(0, data.messages.split('\n').length - 2)}`)
  formLogs.append('parse_mode', 'HTML')
  formLogs.append('document', new Blob([data.messages], { type: 'text/csv' }), `message_logs_backup_${dateStr}.csv`)

  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formLogs,
  })
}

async function buildAdminPanelMessage(env: Env) {
  const start = performance.now()
  const stats = await getAdminStats(env)
  const ping = Math.round(performance.now() - start)

  let topUsersText = '<i>None yet</i>'
  if (stats.topUsers.length > 0) {
    topUsersText = stats.topUsers.map((u, i) => `${i + 1}. ID: <code>${u.tgId}</code> — <b>${u.count}</b> msgs`).join('\n')
  }

  const text = `<blockquote><b>⚡ Solo Userbot Admin Dashboard</b></blockquote>\n\n` +
    `👤 <b>Paired Owner:</b> <code>${esc(stats.ownerId)}</code>\n` +
    `🟢 <b>Userbot Status:</b> ${stats.active ? '🟢 Running 24/7' : '⚪ Not Connected'}\n\n` +
    `📈 <b>Message Statistics:</b>\n` +
    `• <b>Past 24 Hours:</b> <code>${stats.dailyMsgs}</code>\n` +
    `• <b>Past 7 Days:</b> <code>${stats.weeklyMsgs}</code>\n` +
    `• <b>Past 30 Days:</b> <code>${stats.monthlyMsgs}</code>\n` +
    `• <b>All-Time Processed:</b> <code>${stats.allTimeMsgs}</code>\n\n` +
    `⚡ <b>System & Service Health:</b>\n` +
    `• <b>Cloudflare D1 (SQL):</b> ${stats.dbHealth.status ? `🟢 Healthy (<code>${stats.dbHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Groq AI:</b> ${stats.groqHealth.status ? `🟢 Healthy (<code>${stats.groqHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Tavily Search:</b> ${stats.tavilyHealth.status ? `🟢 Healthy (<code>${stats.tavilyHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Telegram Bot API:</b> ${stats.tgHealth.status ? `🟢 Healthy (<code>${stats.tgHealth.latencyMs}ms</code>)` : `🔴 Down`}\n\n` +
    `🏆 <b>Top Active Chats/Users:</b>\n${topUsersText}\n\n` +
    `<i>Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</i>`

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh Stats', callback_data: 'admin_refresh' },
        { text: '📥 Export CSV Backup', callback_data: 'admin_backup' },
      ],
      [
        { text: '⚡ Health Check', callback_data: 'admin_health' },
        { text: '🚪 Exit Admin', callback_data: 'admin_exit' },
      ],
    ],
  }

  return { text, keyboard, ping }
}

/* ───────────── Keyboard Helpers ───────────── */
const EFFECT_FIRE = '5104841245755180586'
const EFFECT_HEART = '5107584321108051014'
const EFFECT_PARTY = '5046509860389126442'

function getMainKeyboard(isRunning: boolean) {
  return {
    inline_keyboard: [
      [
        { text: isRunning ? '📊 Userbot Status' : '🔑 Connect Account', callback_data: isRunning ? 'btn_status' : 'btn_login' },
        { text: '📖 Features & Help', callback_data: 'btn_help' },
      ],
      [
        ...(isRunning ? [{ text: '🚪 Disconnect / Logout', callback_data: 'btn_logout' }] : []),
      ],
    ],
  }
}

function getHelpGuideText(): string {
  return `<b>📖 AI Userbot — Master Command Guide</b>
` +
    `<i>All commands run directly from your user account. No extra bot prefix needed!</i>

` +
    `<blockquote>🤖 <b>In-Chat AI Assistant</b>
` +
    `• <code>.ai &lt;question&gt;</code> or <code>.ask &lt;question&gt;</code> — Generates smart answers in-place
` +
    `• <b>Reply + <code>.ai</code></b> — Analyzes the replied message or conversation thread
` +
    `• <b>Real-Time Web Search</b> — Instant live facts via Tavily search</blockquote>

` +
    `<blockquote>🧹 <b>Chat Cleanup &amp; Privacy</b>
` +
    `• <code>.purge</code> / <code>.p</code> <i>(reply)</i> — Mass-deletes all messages forward for both sides
` +
    `• <code>.burn</code> / <code>.b</code> — Deletes only your own messages with verified count
` +
    `• <code>.wipe</code> / <code>.w</code> — Cleans all bot messages in the current chat</blockquote>

` +
    `<blockquote>⚡ <b>Productivity &amp; Fun Tools</b>
` +
    `• <code>.ping</code> — Real-time latency, mention &amp; uptime
` +
    `• <code>.id</code> <i>(or reply)</i> — Displays User ID, chat ID, and join date metadata
` +
    `• <code>.qt</code> <i>(reply)</i> — Generates a custom quote sticker
` +
    `• <code>.s &lt;n&gt; &lt;text&gt;</code> — Spams messages with delay (max 30)
` +
    `• <code>.fs &lt;n&gt; &lt;text&gt;</code> — Fast burst spam without delay (max 30)
` +
    `• <code>.c &lt;n&gt; &lt;text&gt;</code> — Repeats text inline in bold (max 100)</blockquote>

` +
    `<blockquote>🛡️ <b>Admin Moderation (Group Admins Only)</b>
` +
    `• <code>.ban</code> <i>(reply)</i> — Bans user with an AI roast
` +
    `• <code>.kick</code> <i>(reply)</i> — Removes user without banning
` +
    `• <code>.mute 10m/1h/1d</code> <i>(reply)</i> — Mutes user for specified duration
` +
    `• <code>.warn &lt;reason&gt;</code> <i>(reply)</i> — Warns user (auto-bans on 3/3)
` +
    `• <code>.promote</code> / <code>.demote</code> <i>(reply)</i> — Modifies administrator rights</blockquote>`
}

function getPhoneKeyboard() {
  return {
    keyboard: [
      [{ text: '📱 Share Phone Number', request_contact: true }],
      [{ text: '❌ Cancel' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

function getCancelKeyboard() {
  return {
    keyboard: [
      [{ text: '❌ Cancel' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

/* ───────────── Durable Object: Solo Userbot Runtime ───────────── */
export class Userbot extends DurableObject<Env> {
  tg?: TelegramClient
  step: 'idle' | 'phone' | 'code' | 'pass' | 'admin_code' = 'idle'
  phone = ''; hash = ''; uid = ''; twoFa = ''
  running = false
  isAdmin = false
  startedAt: number = Date.now()
  bootPromise?: Promise<void>
  seenMsgs = new Set<string>()

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/restart') {
      try { await this.tg?.destroy() } catch {}
      this.tg = undefined
      this.running = false
      throw new Error('restart_instance_requested')
    }
    if (url.pathname === '/wake' || url.pathname === '/ping') {
      if (!this.running) {
        await this.boot().catch(e => console.error('boot error on wake:', e))
      }
      let me: any = null
      if (this.tg) {
        try {
          const m = await this.tg.getMe()
          me = { id: m.id, username: m.username, displayName: m.displayName }
        } catch (e: any) {
          me = { error: String(e?.message || e) }
        }
      }
      return new Response(JSON.stringify({ ok: true, running: this.running, uid: this.uid, me }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname === '/msg') {
      const { chatId, text, messageId, contact } = await req.json() as any
      if (!this.running && this.step === 'idle') {
        this.boot().catch(e => console.error('auto-boot on msg error:', e))
      }
      await this.onBotMessage(chatId, messageId, String(text || '').trim(), contact).catch(async e => {
        await bot(this.env, 'sendMessage', { chat_id: chatId, text: 'Error: ' + (e?.message || e) })
      })
      return new Response('ok')
    }
    if (url.pathname === '/callback') {
      const cq = await req.json() as any
      await this.onCallbackQuery(cq).catch(async e => {
        console.error('callback error:', e)
      })
      return new Response('ok')
    }
    return new Response(JSON.stringify({ error: 'not_found', pathname: url.pathname }), { status: 404, headers: { 'content-type': 'application/json' } })
  }

  // 5-minute watchdog alarm to prevent high DO duration consumption on free tier
  async alarm() {
    try {
      if (!this.running || !this.tg) {
        await this.boot()
      }
    } catch (e) {
      console.error('alarm boot error:', e)
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 300_000)
    }
  }

  newClient() {
    return new TelegramClient({
      apiId: Number(this.env.API_ID),
      apiHash: this.env.API_HASH,
      storage: new MemoryStorage(),
      crypto: new WorkerCryptoProvider(),
      initConnectionOptions: {
        deviceModel: 'Solo AI Userbot on Cloudflare',
        appVersion: '2.0.0',
        systemVersion: 'Cloudflare Edge',
      },
    })
  }

  /** Load session from Cloudflare D1 and start listening */
  async boot() {
    if (this.step !== 'idle') return
    if (this.bootPromise) return this.bootPromise
    this.bootPromise = (async () => {
      try {
        if (this.step !== 'idle') return
        await initTables(this.env)

        const rows = await dbQuery(this.env, "SELECT tg_id, session FROM users WHERE session IS NOT NULL AND session != '' LIMIT 1")
        if (!rows.length || !rows[0][1]) return

        this.uid = rows[0][0]
        await this.ctx.storage.put('uid', this.uid)

        if (this.running && this.tg && (this.tg as any)._client?._connected) {
          await this.ctx.storage.setAlarm(Date.now() + 300_000)
          return
        }

        const session = await decrypt(this.env, rows[0][1])
        if (this.step !== 'idle') return
        try { await this.tg?.destroy() } catch {}
        const tg = this.newClient()
        ;(tg as any)._client?.onConnectionState?.add((state: string) => {
          if (state === 'closed' || state === 'broken') this.running = false
        })
        this.attach(tg)
        await tg.start({ session })
        if (this.step !== 'idle') {
          try { await tg.destroy() } catch {}
          return
        }
        await tg.startUpdatesLoop()
        this.tg = tg; this.running = true
        await this.ctx.storage.setAlarm(Date.now() + 300_000)
      } finally {
        this.bootPromise = undefined
      }
    })()
    return this.bootPromise
  }

  async onCallbackQuery(cq: any) {
    const data = String(cq.data || '')
    const chatId = cq.chatId
    const fromId = String(cq.fromId || chatId)
    const messageId = cq.messageId

    await bot(this.env, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})

    // Solo 1-User Lock: Reject any other user trying to control the bot
    const activeUsers = await dbQuery(this.env, "SELECT tg_id FROM users WHERE session IS NOT NULL AND session != '' LIMIT 1")
    const ownerId = activeUsers[0]?.[0]
    if (ownerId && fromId !== ownerId) {
      return bot(this.env, 'answerCallbackQuery', {
        callback_query_id: cq.id,
        text: '🔒 Access Denied: This instance is locked to its owner.',
        show_alert: true,
      })
    }

    if (data === 'btn_help') {
      return bot(this.env, 'sendMessage', {
        chat_id: chatId,
        text: getHelpGuideText(),
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(this.running),
      })
    }

    // Main Menu Buttons
    if (data === 'btn_login') {
      this.step = 'phone'
      this.phone = ''
      this.hash = ''
      this.twoFa = ''
      const loginPrompt = `<blockquote><b>📱 Step 1 of 2: Phone Verification</b></blockquote>\n\n` +
        `Tap the <b>📱 Share Phone Number</b> button below or enter your phone number with country code (e.g. <code>+1234567890</code>).`
      return bot(this.env, 'sendMessage', {
        chat_id: chatId,
        text: loginPrompt,
        parse_mode: 'HTML',
        reply_markup: getPhoneKeyboard(),
      })
    }

    if (data === 'btn_status') {
      if (!this.running) {
        await this.boot().catch(() => {})
      }
      if (this.running) {
        const statusText = `<blockquote><b>🟢 Solo AI Userbot is Active & Running</b></blockquote>\n\n` +
          `• <b>Status:</b> Listening for <code>.ai</code>, <code>.ask</code>, <code>.qt</code>, <code>.ping</code>\n` +
          `• <b>Database:</b> Cloudflare D1 (SQL) synced\n` +
          `• <b>Owner Lock:</b> <code>${esc(this.uid)}</code>\n` +
          `• <b>Security:</b> Active AES-256-GCM session\n\n` +
          `<i>Tip: In any chat or group, send <code>.ai your question</code> to use your userbot!</i>`
        return bot(this.env, 'sendMessage', {
          chat_id: chatId,
          text: statusText,
          parse_mode: 'HTML',
          reply_markup: getMainKeyboard(true),
          message_effect_id: EFFECT_FIRE,
        })
      } else {
        const statusText = `<blockquote><b>⚪ AI Userbot is Not Connected</b></blockquote>\n\n` +
          `No active session found. Tap <b>🔑 Connect Account</b> below to connect your Telegram account.`
        return bot(this.env, 'sendMessage', {
          chat_id: chatId,
          text: statusText,
          parse_mode: 'HTML',
          reply_markup: getMainKeyboard(false),
        })
      }
    }

    if (data === 'btn_logout') {
      try { await this.tg?.logOut() } catch {}
      try { await this.tg?.destroy() } catch {}
      this.tg = undefined; this.running = false; this.step = 'idle'
      this.phone = ''; this.hash = ''; this.twoFa = ''
      await dbQuery(this.env, 'DELETE FROM users')
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.delete('uid')
      const logoutText = `<blockquote><b>🗑️ Session Disconnected & Unlocked</b></blockquote>\n\n` +
        `Your userbot session has been logged out and cleared from Cloudflare D1.\n` +
        `The bot is now unlocked. Tap below anytime to reconnect.`
      return bot(this.env, 'sendMessage', {
        chat_id: chatId,
        text: logoutText,
        parse_mode: 'HTML',
        reply_markup: getMainKeyboard(false),
        message_effect_id: EFFECT_HEART,
      })
    }

    // Admin Panel Callbacks
    const isAuthed = this.isAdmin || (await this.ctx.storage.get<boolean>('isAdmin'))
    if (!isAuthed && data.startsWith('admin_')) {
      await bot(this.env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ <b>Session expired.</b> Please type /admin to authenticate again.',
        parse_mode: 'HTML',
      })
      return
    }

    if (data === 'admin_refresh' || data === 'admin_health') {
      const panel = await buildAdminPanelMessage(this.env)
      await bot(this.env, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: panel.text,
        parse_mode: 'HTML',
        reply_markup: panel.keyboard,
      }).catch(() => {})
    } else if (data === 'admin_backup') {
      await bot(this.env, 'sendMessage', {
        chat_id: chatId,
        text: '⏳ <b>Preparing CSV database backup...</b>',
        parse_mode: 'HTML',
      })
      await sendCsvBackupToTelegram(this.env, chatId).catch(async e => {
        await bot(this.env, 'sendMessage', { chat_id: chatId, text: 'Backup error: ' + (e?.message || e) })
      })
    } else if (data === 'admin_exit') {
      this.isAdmin = false
      await this.ctx.storage.delete('isAdmin')
      await bot(this.env, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: '🚪 <b>Admin panel closed.</b> Use /admin to re-open anytime.',
        parse_mode: 'HTML',
      }).catch(() => {})
    }
  }

  async onBotMessage(chatId: number, messageId: number, text: string, contact?: any) {
    const say = (t: string, reply_markup?: any, effectId?: string) => {
      const body: any = {
        chat_id: chatId,
        text: t,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }
      if (reply_markup) body.reply_markup = reply_markup
      if (effectId) body.message_effect_id = effectId
      return bot(this.env, 'sendMessage', body)
    }

    // Solo 1-User Lock: Reject anyone other than the registered owner
    const activeUsers = await dbQuery(this.env, "SELECT tg_id FROM users WHERE session IS NOT NULL AND session != '' LIMIT 1")
    const ownerId = activeUsers[0]?.[0]
    if (ownerId && String(chatId) !== ownerId) {
      const lockedMsg = `<blockquote><b>🔒 Private Solo Userbot</b></blockquote>\n\n` +
        `This userbot instance is locked to its owner (<code>${esc(ownerId)}</code>).\n` +
        `Unauthorized users cannot access or control this bot.\n\n` +
        `<i>Deploy your own free 24/7 AI Userbot on Cloudflare with one click!</i>`
      return say(lockedMsg)
    }

    const adminPass = this.env.ADMIN_CODE || '4847'
    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase()

    /* ─── Cancel action ─── */
    if (text === '❌ Cancel' || text.toLowerCase() === 'cancel' || cmd === '/cancel') {
      this.step = 'idle'
      this.phone = ''
      this.hash = ''
      this.twoFa = ''
      const cancelText = `<blockquote><b>Operation Cancelled</b></blockquote>\n\nChoose an action below whenever you are ready.`
      return say(cancelText, getMainKeyboard(this.running))
    }

    /* ─── Admin Command Handler ─── */
    if (cmd === '/admin') {
      const codeArg = parts[1]
      if (codeArg === adminPass) {
        this.isAdmin = true
        this.step = 'idle'
        await this.ctx.storage.put('isAdmin', true)
        const panel = await buildAdminPanelMessage(this.env)
        return say(panel.text, panel.keyboard, EFFECT_FIRE)
      }

      const isAuthed = this.isAdmin || (await this.ctx.storage.get<boolean>('isAdmin'))
      if (isAuthed) {
        const panel = await buildAdminPanelMessage(this.env)
        return say(panel.text, panel.keyboard, EFFECT_FIRE)
      }

      this.step = 'admin_code'
      return say('🔐 <b>Admin Control Panel</b>\n\nPlease enter the admin passcode:', getCancelKeyboard())
    }

    if (this.step === 'admin_code') {
      if (text.trim() === adminPass) {
        this.isAdmin = true
        this.step = 'idle'
        await this.ctx.storage.put('isAdmin', true)
        await bot(this.env, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {})
        const panel = await buildAdminPanelMessage(this.env)
        return say(panel.text, panel.keyboard, EFFECT_FIRE)
      }
      this.step = 'idle'
      return say('❌ <b>Access Denied:</b> Incorrect passcode.', getMainKeyboard(this.running))
    }

    if (cmd === '/admin_exit' || cmd === '/exit_admin') {
      this.isAdmin = false
      await this.ctx.storage.delete('isAdmin')
      return say('🚪 Admin panel session closed.', getMainKeyboard(this.running))
    }

    if (cmd === '/backup' || (cmd === '/admin' && parts[1] === 'backup')) {
      const isAuthed = this.isAdmin || (await this.ctx.storage.get<boolean>('isAdmin'))
      if (!isAuthed) return say('❌ Unauthorized. Enter /admin first.', getMainKeyboard(this.running))
      await say('⏳ <b>Generating CSV database backup...</b>')
      return sendCsvBackupToTelegram(this.env, chatId)
    }

    /* ─── Regular User Commands & Buttons ─── */
    if (cmd === '/start') {
      const isRunning = this.running
      const welcomeText = `<blockquote><b>⚡ Welcome to Solo AI Userbot</b></blockquote>\n\n` +
        `<b>Your personal Telegram account, supercharged with cutting-edge AI on Cloudflare Workers & D1 (SQL).</b>\n\n` +
        `🔒 <b>100% Private & Data Safe:</b>\n` +
        `• All credentials and sessions are encrypted with AES-256-GCM in Cloudflare D1.\n` +
        `• Runs directly on your personal Cloudflare account with zero external databases or loggers.\n` +
        `• Ultra-fast sub-second edge execution across 300+ cities globally.\n\n` +
        `✨ <b>What You Can Do:</b>\n` +
        `• <b>Smart AI Responses:</b> Send <code>.ai &lt;question&gt;</code> anywhere to edit-in intelligent answers.\n` +
        `• <b>Live Web Search:</b> Instant real-time facts via Tavily search.\n` +
        `• <b>Quote Stickers:</b> Reply with <code>.qt</code> to cook instant quote stickers.\n` +
        `• <b>Chat Cleanup:</b> Fast <code>.purge</code>, <code>.burn</code>, and <code>.wipe</code> tools.\n` +
        `• <b>Group Admin Suite:</b> Moderation commands with permission verification.\n\n` +
        `👇 <i>Tap below to check status, view all commands, or connect your account:</i>`
      return say(welcomeText, getMainKeyboard(isRunning), EFFECT_FIRE)
    }

    if (cmd === '/help' || text === '📖 Features & Help' || text.toLowerCase() === 'help') {
      return say(getHelpGuideText(), getMainKeyboard(this.running))
    }

    if (cmd === '/status' || text === '📊 Userbot Status' || text.toLowerCase() === 'status') {
      if (!this.running) {
        await this.boot().catch(() => {})
      }
      if (this.running) {
        const statusText = `<blockquote><b>🟢 Solo AI Userbot is Active & Running</b></blockquote>\n\n` +
          `• <b>Status:</b> Listening for <code>.ai</code>, <code>.ask</code>, <code>.qt</code>\n` +
          `• <b>Database:</b> Cloudflare D1 (SQL) synced\n` +
          `• <b>Owner Lock:</b> <code>${esc(this.uid)}</code>\n` +
          `• <b>Security:</b> Active AES-256-GCM session\n\n` +
          `<i>Tip: In any personal chat or group, send <code>.ai your question</code> to use your userbot!</i>`
        return say(statusText, getMainKeyboard(true), EFFECT_FIRE)
      } else {
        const statusText = `<blockquote><b>⚪ AI Userbot is Not Connected</b></blockquote>\n\n` +
          `No active session found. Tap <b>🔑 Connect Account</b> below to link your Telegram account.`
        return say(statusText, getMainKeyboard(false))
      }
    }

    if (cmd === '/logout' || text === '🚪 Disconnect / Logout' || text.toLowerCase() === 'logout') {
      try { await this.tg?.logOut() } catch {}
      try { await this.tg?.destroy() } catch {}
      this.tg = undefined; this.running = false; this.step = 'idle'
      this.phone = ''; this.hash = ''; this.twoFa = ''
      await dbQuery(this.env, 'DELETE FROM users')
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.delete('uid')
      const logoutText = `<blockquote><b>🗑️ Session Disconnected & Unlocked</b></blockquote>\n\n` +
        `Your userbot session has been logged out and all data cleared from Cloudflare D1.\n` +
        `The bot is now unlocked. Tap below anytime to reconnect.`
      return say(logoutText, getMainKeyboard(false), EFFECT_HEART)
    }

    if (cmd === '/login' || text === '🔑 Connect Account' || text.toLowerCase() === 'login') {
      this.step = 'phone'
      this.phone = ''
      this.hash = ''
      this.twoFa = ''
      const loginPrompt = `<blockquote><b>📱 Step 1 of 2: Phone Verification</b></blockquote>\n\n` +
        `Tap the <b>📱 Share Phone Number</b> button below or type your number with country code (e.g. <code>+1234567890</code>).`
      return say(loginPrompt, getPhoneKeyboard())
    }

    if (this.step === 'phone') {
      let rawPhone = ''
      if (contact?.phone_number) {
        rawPhone = contact.phone_number
      } else {
        rawPhone = text.replace(/[^\d+]/g, '')
      }
      if (!rawPhone) {
        return say('⚠️ Please tap <b>📱 Share Phone Number</b> or send a valid number with country code.', getPhoneKeyboard())
      }
      if (!rawPhone.startsWith('+')) rawPhone = '+' + rawPhone
      this.phone = rawPhone
      if (this.bootPromise) await this.bootPromise.catch(() => {})
      try { await this.tg?.destroy() } catch {}
      this.tg = undefined
      this.running = false
      const client = this.newClient()
      this.tg = client
      try {
        await client.connect()
        const sent: any = await client.sendCode({ phone: this.phone })
        this.hash = sent.phoneCodeHash
        this.step = 'code'
        const codePrompt = `<blockquote><b>📩 Step 2 of 2: Enter Verification Code</b></blockquote>\n\n` +
          `Telegram has sent a login code to your Telegram app for <code>${esc(this.phone)}</code>.\n\n` +
          `⚠️ <b>IMPORTANT:</b> Please send the code with <b>spaces between digits</b> (e.g., <code>1 2 3 4 5</code>) so Telegram does not cancel the code.`
        return say(codePrompt, getCancelKeyboard())
      } catch (err: any) {
        this.step = 'idle'
        console.error('sendCode error:', err)
        return say(`❌ <b>Failed to request verification code:</b>\n<code>${esc(err?.message || err)}</code>\n\nPlease check your phone number and try again.`, getMainKeyboard(this.running))
      }
    }

    if (this.step === 'code') {
      const code = text.replace(/\D/g, '')
      try {
        await this.tg!.signIn({ phone: this.phone, phoneCodeHash: this.hash, phoneCode: code })
      } catch (e: any) {
        if (String(e?.text || e?.message).includes('SESSION_PASSWORD_NEEDED')) {
          this.step = 'pass'
          const passPrompt = `<blockquote><b>🔐 Two-Factor Authentication (2FA) Required</b></blockquote>\n\n` +
            `Your account has a 2FA password enabled. Please send your password below.\n\n` +
            `<i>🛡️ Your password message will be deleted immediately for privacy.</i>`
          return say(passPrompt, getCancelKeyboard())
        }
        throw e
      }
      return this.finishLogin(chatId, say)
    }

    if (this.step === 'pass') {
      this.twoFa = text
      await bot(this.env, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {})
      await this.tg!.checkPassword(text)
      return this.finishLogin(chatId, say)
    }

    return say('Please select an option from the menu below 🙂', getMainKeyboard(this.running))
  }

  async finishLogin(chatId: number, say: (t: string, rm?: any, eff?: string) => Promise<any>) {
    const session = await this.tg!.exportSession()
    this.uid = String(chatId)
    await this.ctx.storage.put('uid', this.uid)

    // Solo lock: Wipe prior sessions and store exclusively the new owner
    await dbQuery(this.env, 'DELETE FROM users')
    await dbQuery(this.env,
      "INSERT OR REPLACE INTO users (tg_id, session, created_at) VALUES (?, ?, datetime('now'))",
      [this.uid, await encrypt(this.env, session)]
    )

    this.attach(this.tg!)
    await this.tg!.startUpdatesLoop().catch(() => {})
    this.running = true; this.step = 'idle'
    await this.ctx.storage.setAlarm(Date.now() + 300_000)

    const successMsg = `<blockquote><b>🎉 Solo Userbot Connected Successfully!</b></blockquote>\n\n` +
      `Your AI Userbot is now running 24/7 on your personal Cloudflare Worker.\n` +
      `This bot is now <b>locked exclusively to your account</b> (ID: <code>${this.uid}</code>).\n\n` +
      `🚀 <b>How to Use:</b>\n` +
      `Go to <b>any chat, DM, or group</b> and send:\n` +
      `• <code>.ai your question</code> — In-place AI answers\n` +
      `• <code>.ping</code> — Check userbot latency\n` +
      `• <code>.qt</code> — Reply to any message to make a quote sticker\n` +
      `• <code>.purge</code> / <code>.b</code> — Fast message cleanup\n\n` +
      `<i>Enjoy your private serverless AI userbot!</i>`
    await say(successMsg, getMainKeyboard(true), EFFECT_PARTY)
  }

  /** The actual userbot logic */
  attach(tg: TelegramClient) {
    tg.onNewMessage.add(async (msg: any) => {
      try {
        const isMine = msg.isOutgoing ||
          (msg.sender?.id && String(msg.sender.id) === String(this.uid)) ||
          (String(msg.chat.id) === String(this.uid))
        if (!isMine) return
        const textTrim = (msg.text || '').trim()
        if (!textTrim.startsWith('.')) return

        const msgKey = `${msg.chat.id}:${msg.id}`
        if (this.seenMsgs.has(msgKey)) return
        this.seenMsgs.add(msgKey)
        if (this.seenMsgs.size > 200) {
          const first = this.seenMsgs.values().next().value
          if (first) this.seenMsgs.delete(first)
        }

        const deps: CmdDeps = {
          env: this.env,
          uid: this.uid,
          turso: (env, sql, args) => dbQuery(env, sql, args),
          askAI,
          systemPrompt,
          esc,
          sanitize,
          stripTags,
          startedAt: this.startedAt,
        }

        if (/^\.ping$/i.test(textTrim)) {
          await handlePing(tg, msg, deps)
          return
        }

        const spamM = textTrim.match(/^\.(fs|s)\s*(?:\+\s*)?(\d+)(?:\s*(?:\+\s*)?([\s\S]*))?$/i)
        if (spamM) {
          await handleSpam(tg, msg, deps, spamM[1].toLowerCase() === 'fs', Number(spamM[2]), (spamM[3] || '').trim())
          return
        }

        const cloneM = textTrim.match(/^\.c\s*(?:\+\s*)?(\d+)\s*(?:\+\s*)?([\s\S]+)$/i)
        if (cloneM) {
          await handleClone(tg, msg, deps, Number(cloneM[1]), cloneM[2])
          return
        }

        if (/^\.id$/i.test(textTrim)) {
          await handleId(tg, msg, deps)
          return
        }

        if (/^\.qt$/i.test(textTrim)) {
          await handleQuote(tg, msg, deps)
          return
        }

        const modM = textTrim.match(/^\.(kick|ban|mute|warn|promote|p|demote)(?:\s*(?:\+\s*)?([\s\S]*))?$/i)
        if (modM) {
          await handleMod(tg, msg, deps, modM[1].toLowerCase(), (modM[2] || '').trim())
          return
        }

        const cleanM = textTrim.match(/^\.(purge|w|wipe|b|burn)(?:\s+([\s\S]*))?$/i)
        if (cleanM) {
          await handleCleanup(tg, msg, deps, cleanM[1].toLowerCase())
          return
        }

        const m = textTrim.match(/^\.(ai|ask)(?:\s+([\s\S]*))?$/i)
        if (!m) return
        await this.handle(tg, msg, (m[2] || '').trim(), m[1].toLowerCase())
      } catch (e) { console.error('handler error:', e) }
    })
  }

  async handle(tg: TelegramClient, msg: any, qIn: string, commandName = 'ai') {
    const peer = msg.chat.inputPeer || msg.chat.id
    const edit = async (htmlStr: string) => {
      try {
        await tg.editMessage({ message: msg, text: thtml(htmlStr) })
      } catch {
        try {
          await tg.editMessage({ chatId: peer, message: msg.id, text: thtml(htmlStr) })
        } catch {
          try {
            await tg.editMessage({ message: msg, text: html(htmlStr.replace(/\n/g, '<br>')) })
          } catch {
            await tg.editMessage({ chatId: peer, message: msg.id, text: stripTags(htmlStr) }).catch(() => {})
          }
        }
      }
    }

    try {
      await edit('<b>🤔 Thinking...</b>')
      const me = await tg.getMe().catch(() => null)
      const myName = me?.displayName || me?.username || 'Owner'
      const chatName = msg.chat?.displayName || (msg.chat as any)?.title || 'chat'
      const wantLong = /\b(detail|detailed|in depth|explain fully|long|poem|story|step by step)\b/i.test(qIn)

      let threadCtx = ''
      if (msg.replyToMessage?.id) {
        try {
          const [replied] = await tg.getMessages(peer, [msg.replyToMessage.id])
          if (replied) {
            const senderName = replied.sender?.displayName || replied.sender?.username || 'User'
            threadCtx = `[Replied message from ${senderName}: "${replied.text || '[media]'}" ]\n`
          }
        } catch {}
      }

      let recentCtx = ''
      try {
        const recents: string[] = []
        for await (const m of tg.iterHistory(peer, { limit: 6 })) {
          if (m.id === msg.id) continue
          const sName = m.sender?.displayName || m.sender?.username || 'User'
          const t = (m.text || '').slice(0, 150)
          if (t) recents.unshift(`${sName}: ${t}`)
        }
        if (recents.length) recentCtx = `[Recent chat context:\n${recents.join('\n')}\n]\n`
      } catch {}

      const promptSystem = systemPrompt(myName, chatName, wantLong)
      const userPrompt = `${threadCtx}${recentCtx}User Question: ${qIn || '(answer about the replied message)'}`

      const answerRaw = await askAI(this.env, promptSystem, userPrompt, wantLong)
      const sanitized = sanitize(answerRaw)
      await edit(sanitized || '<i>(no response)</i>')

      // Record message log without storing username
      try {
        await dbQuery(this.env,
          "INSERT INTO message_logs (tg_id, chat_id, command, created_at) VALUES (?, ?, ?, datetime('now'))",
          [String(this.uid || me?.id || ''), String(msg.chat.id), commandName]
        )
      } catch {}
    } catch (e: any) {
      console.error('AI handle error:', e)
      await edit(`<b>Error:</b> <code>${esc(e?.message || e)}</code>`)
    }
  }
}

/* ───────────── Glassmorphism Web Admin Dashboard ───────────── */
function renderWebAdminHtml(stats: AdminStats, pingMs: number, authCode: string): string {
  const topRows = stats.topUsers.length > 0
    ? stats.topUsers.map((u, i) => `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:600;color:#60a5fa;">#${i + 1}</td>
        <td style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);"><code>${esc(u.tgId)}</code></td>
        <td style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);font-weight:700;color:#34d399;">${u.count}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="3" style="padding:20px;text-align:center;color:#9ca3af;">No messages recorded yet</td></tr>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solo TG AI Userbot - Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top left, #1e1b4b, #09090b 60%);
      color: #f3f4f6;
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      padding: 30px 20px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    h1 { font-size: 26px; font-weight: 800; display: flex; align-items: center; gap: 10px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
      background: rgba(34,197,94,0.15);
      color: #4ade80;
      border: 1px solid rgba(34,197,94,0.3);
    }
    .badge-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px #4ade80; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: rgba(24, 24, 27, 0.7);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.3);
      transition: transform 0.2s;
    }
    .card:hover { transform: translateY(-2px); }
    .card-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; margin-bottom: 8px; }
    .card-val { font-size: 32px; font-weight: 800; color: #ffffff; }
    .card-sub { font-size: 12px; color: #6b7280; margin-top: 6px; }

    .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 30px; }
    .health-card {
      background: rgba(24, 24, 27, 0.7);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .health-name { font-weight: 600; font-size: 14px; }
    .status-pill {
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .status-ok { background: rgba(34,197,94,0.15); color: #4ade80; border: 1px solid rgba(34,197,94,0.3); }
    .status-err { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }

    .section-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
    .table-container {
      background: rgba(24, 24, 27, 0.7);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 30px;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th {
      background: rgba(255,255,255,0.03);
      padding: 12px 14px;
      font-size: 12px;
      text-transform: uppercase;
      color: #9ca3af;
      letter-spacing: 0.05em;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    code { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #a78bfa; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-secondary { background: rgba(255,255,255,0.08); color: #e5e7eb; border: 1px solid rgba(255,255,255,0.1); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>⚡ Solo AI Userbot Dashboard</h1>
        <p style="color:#9ca3af;font-size:13px;margin-top:4px;">Personal 24/7 AI Userbot on Cloudflare Workers & D1</p>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <span class="badge"><span class="badge-dot"></span> Edge Worker Active</span>
        <a href="/admin/backup?type=messages&code=${encodeURIComponent(authCode)}" class="btn btn-secondary">📥 Export CSV Logs</a>
        <a href="/admin?code=${encodeURIComponent(authCode)}" class="btn">🔄 Refresh</a>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">Bot Owner Lock</div>
        <div class="card-val" style="font-size:22px;"><code>${esc(stats.ownerId)}</code></div>
        <div class="card-sub">${stats.active ? '🟢 Userbot Paired & Running' : '⚪ Bot Unlocked / Idle'}</div>
      </div>
      <div class="card">
        <div class="card-title">Messages (24h)</div>
        <div class="card-val">${stats.dailyMsgs}</div>
        <div class="card-sub">Handled in last 24 hours</div>
      </div>
      <div class="card">
        <div class="card-title">Messages (7d)</div>
        <div class="card-val">${stats.weeklyMsgs}</div>
        <div class="card-sub">Handled past week</div>
      </div>
      <div class="card">
        <div class="card-title">All-Time Messages</div>
        <div class="card-val">${stats.allTimeMsgs}</div>
        <div class="card-sub">Total commands executed</div>
      </div>
    </div>

    <div class="section-title">⚡ Service Health</div>
    <div class="health-grid">
      <div class="health-card">
        <div>
          <div class="health-name">Cloudflare D1 (SQL)</div>
          <div style="font-size:12px;color:#9ca3af;">${stats.dbHealth.latencyMs}ms latency</div>
        </div>
        <span class="status-pill ${stats.dbHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.dbHealth.status ? '● Operational' : '● Offline'}
        </span>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Groq Qwen API</div>
          <div style="font-size:12px;color:#9ca3af;">${stats.groqHealth.latencyMs}ms latency</div>
        </div>
        <span class="status-pill ${stats.groqHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.groqHealth.status ? '● Operational' : '● Offline'}
        </span>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Tavily Web Search</div>
          <div style="font-size:12px;color:#9ca3af;">${stats.tavilyHealth.latencyMs}ms latency</div>
        </div>
        <span class="status-pill ${stats.tavilyHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.tavilyHealth.status ? '● Operational' : '● Offline'}
        </span>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Telegram Bot API</div>
          <div style="font-size:12px;color:#9ca3af;">${stats.tgHealth.latencyMs}ms latency</div>
        </div>
        <span class="status-pill ${stats.tgHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.tgHealth.status ? '● Operational' : '● Offline'}
        </span>
      </div>
    </div>

    <div class="section-title">🏆 Top User Interactions</div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Telegram ID</th>
            <th>Messages Sent</th>
          </tr>
        </thead>
        <tbody>
          ${topRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`
}

function renderLoginHtml(err = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login - Solo TG AI Userbot</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top, #1e1b4b, #09090b 70%);
      color: #f3f4f6;
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .box {
      background: rgba(24, 24, 27, 0.8);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 36px 30px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      text-align: center;
    }
    h2 { font-size: 22px; margin-bottom: 8px; font-weight: 700; }
    p { font-size: 13px; color: #9ca3af; margin-bottom: 24px; }
    input {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff;
      font-size: 18px;
      text-align: center;
      letter-spacing: 4px;
      outline: none;
      margin-bottom: 16px;
    }
    input:focus { border-color: #3b82f6; box-shadow: 0 0 12px rgba(59,130,246,0.5); }
    button {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      background: #2563eb;
      color: #fff;
      font-weight: 700;
      font-size: 15px;
      border: none;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .err { color: #f87171; font-size: 13px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>🔐 Admin Access</h2>
    <p>Enter the 4-digit security passcode</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <form method="GET" action="/admin">
      <input type="password" name="code" placeholder="••••" maxlength="10" required autofocus autocomplete="off">
      <button type="submit">Unlock Admin Panel</button>
    </form>
  </div>
</body>
</html>`
}

/* ───────────── Worker Entry (Solo) ───────────── */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const adminPass = env.ADMIN_CODE || '4847'

    // Web Admin Panel route
    if (url.pathname === '/admin') {
      const code = url.searchParams.get('code') || ''
      if (!code) {
        return new Response(renderLoginHtml(), { headers: { 'content-type': 'text/html;charset=UTF-8' } })
      }
      if (code !== adminPass) {
        return new Response(renderLoginHtml('Incorrect passcode!'), { status: 401, headers: { 'content-type': 'text/html;charset=UTF-8' } })
      }
      const t0 = performance.now()
      const stats = await getAdminStats(env)
      const ping = Math.round(performance.now() - t0)
      return new Response(renderWebAdminHtml(stats, ping, code), {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      })
    }

    // Web Admin CSV Backup download route
    if (url.pathname === '/admin/backup') {
      const code = url.searchParams.get('code') || ''
      if (code !== adminPass) {
        return new Response('Unauthorized', { status: 401 })
      }
      const type = (url.searchParams.get('type') || 'users') as 'users' | 'messages'
      const data = await generateCsvData(env, type)
      const dateStr = new Date().toISOString().slice(0, 10)
      const content = type === 'messages' ? data.messages : data.users
      const filename = type === 'messages' ? `message_logs_backup_${dateStr}.csv` : `users_backup_${dateStr}.csv`

      return new Response(content, {
        headers: {
          'content-type': 'text/csv;charset=UTF-8',
          'content-disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    // Restart DO instance to force-load latest code
    if (url.pathname === '/restart') {
      const stub = env.USERBOT.get(env.USERBOT.idFromName('solo'))
      try {
        await stub.fetch('https://do/restart')
      } catch (e) {
        // Crashed / restarted instance as intended
      }
      await new Promise(r => setTimeout(r, 1000))
      const wakeRes = await stub.fetch('https://do/wake').catch(() => null)
      return new Response(wakeRes ? await wakeRes.text() : 'restarting', { headers: { 'content-type': 'application/json' } })
    }

    // Wake / ping userbot on demand via HTTP
    if (url.pathname === '/wake' || url.pathname === '/ping') {
      const stub = env.USERBOT.get(env.USERBOT.idFromName('solo'))
      const res = await stub.fetch('https://do/ping')
      return new Response(await res.text(), { headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.SETUP_KEY) return new Response('forbidden', { status: 403 })
      await initTables(env)

      const r = await bot(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      })
      return new Response('setup done: ' + JSON.stringify(r))
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 })
      const u: any = await req.json()
      const m = u.message
      const stub = env.USERBOT.get(env.USERBOT.idFromName('solo'))
      if (m?.chat?.type === 'private' && m.from) {
        ctx.waitUntil(stub.fetch('https://do/msg', {
          method: 'POST',
          body: JSON.stringify({ chatId: m.chat.id, text: m.text, messageId: m.message_id, contact: m.contact }),
        }))
      } else if (u.callback_query) {
        const cq = u.callback_query
        const fromId = cq.from?.id
        if (fromId) {
          ctx.waitUntil(stub.fetch('https://do/callback', {
            method: 'POST',
            body: JSON.stringify({
              id: cq.id,
              chatId: cq.message?.chat?.id,
              messageId: cq.message?.message_id,
              data: cq.data,
              fromId,
            }),
          }))
        }
      }
      return new Response('ok')
    }

    return new Response('Solo TG AI Userbot ✅')
  },

  // Cron: 5-minute watchdog ping to keep solo userbot alive without quota exhaustion
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    const stub = env.USERBOT.get(env.USERBOT.idFromName('solo'))
    ctx.waitUntil(stub.fetch('https://do/wake'))
  },
}
