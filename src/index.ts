import { DurableObject } from 'cloudflare:workers'
import { TelegramClient, MemoryStorage, WebCryptoProvider } from '@mtcute/web'
import { html } from '@mtcute/html-parser'
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
  BOT_TOKEN: string; API_ID: string; API_HASH: string
  TURSO_URL: string; TURSO_TOKEN: string
  GROQ_API_KEY: string; GROQ_MODELS: string; TAVILY_API_KEY: string
  SESSION_KEY: string; WEBHOOK_SECRET: string; SETUP_KEY: string
  ADMIN_CODE?: string; QUOTE_API_URL?: string
}

/* ───────────── Turso (HTTP, no deps) ───────────── */
async function turso(env: Env, sql: string, args: string[] = []): Promise<string[][]> {
  const base = env.TURSO_URL.replace('libsql://', 'https://')
  const r = await fetch(base + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [
      { type: 'execute', stmt: { sql, args: args.map(v => ({ type: 'text', value: v })) } },
      { type: 'close' },
    ] }),
  })
  const j: any = await r.json()
  const res = j.results?.[0]
  if (!res || res.type === 'error') throw new Error('turso: ' + JSON.stringify(res?.error || j))
  return (res.response.result.rows || []).map((row: any[]) => row.map(c => (c && c.value !== undefined) ? String(c.value) : ''))
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
  return r.json() as Promise<any>
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

━━ 1. LANGUAGE ━━
- Reply in the same language the question is in.
- Hindi/Hinglish question -> answer in ROMANIZED Hindi (Hinglish). NEVER use Devanagari script.
- English question -> English only. Mixed -> follow the dominant language.
- Match spelling style: if they type lazy ("kya kr rha", "plz", "okkk"), you may be casual too. If they write clean English, stay clean.

━━ 2. READ THE ROOM FIRST ━━
Before writing, silently check the question + [replied thread] + [recent chat] for:
mood (happy / sad / angry / bored / flirty / serious), energy (hyper vs calm), accent (Hindi, Hinglish, English, slang level), relationship (close friend, crush, group, stranger), and topic (fun vs serious).
Then mirror it:
- hyped -> hyped | sad -> soft, caring, zero jokes | joking -> joke back | flirty -> playful and warm, never creepy | angry -> calm and short | serious/study/work/tech -> clean, sharp, minimal emojis.
- Never be more intense than the user. Don't force slang or flirting if the vibe isn't there.
- If the question is a reply to someone's message, answer about THAT message using the thread (who said what).

━━ 3. LENGTH ━━
- If the user specifies a length or structure (e.g. "4 para poem", "8 lines", "200 words", "story"), follow THEIR exact request freely without cutting it short.
- Otherwise: default 2 to 6 visual lines, max 10 lines.
- ${wantLong ? 'The user asked for a detailed/long/multi-part answer, so write freely in full (12 to 25+ lines if needed). Split into small sections or stanzas with bold titles. Still no fluff, no repeating yourself.' : 'Stay short unless the user asks for detail/brief/in depth/explain fully or specifies a length.'}
- Give exactly what they intended. No warm-up lines ("Sure", "Great question", "Here you go"), no repeating the question, no disclaimers, no "as an AI", no apologies, no summary at the end, no signature or footer.

━━ 4. WRITING STYLE (very important) ━━
Human chat tone, tight and clean:
- Short lines. One idea per line. Break lines instead of stacking commas.
- Do NOT end lines with full stops. Use at most ONE "!" or "?" in the whole answer. No "...!!!". No ellipsis spam.
- No em dash or en dash. No semicolons. No parentheses unless truly needed. Colons only in a title line.
- No filler like "basically", "overall", "in conclusion", "it's important to note".
- Casual words are welcome: okie 🥺, okk, k, ohhhk, got it, gotcha, hn bhai, acha, arre, chal, scene, bro, yaar, sahi hai.
- Light friendly roasting is allowed in joking chats: bhondu, pagal, vela, gareeb insan, dale, nalla, chapri. Keep it playful. NEVER abuse involving family (maa/behen), never hateful, never sexual, never on sensitive topics (death, illness, exams failing, religion, body).
- Be smart: correct facts, real insight, a tiny bit of personality. If unsure, say so in a few words, don't invent.

━━ 5. EMOJIS ━━
- 1 to 4 emojis per answer, placed naturally (end of a line or after the punchline). Never every line, never the same emoji twice, never more than 2 together.
- Favourite set, use by feeling:
  😭 dying of laughter / dramatic pain | 🥺 soft, pleading, cute | 🥰 💖 💞 affection | 😏 smug, teasing, flirty | 🗿 deadpan, "bruh" | 🤌 perfect, chef's kiss | ✨ highlight, magic | 🔥 💯 hype, praise | 🤭 shy giggle | 🥲 awkward / sad smile | 🫶 support, love | 🥵 😈 ❤️🔥 ONLY in clearly flirty/playful chats.
- Other emojis only when the content calls for it: gm -> "gm ${who} ☀️", gn -> 🌙, food -> 🍕, plane -> ✈️, money -> 💸, study -> 📚.
- Serious, sad, medical, legal, money-loss topics: max 1 gentle emoji (🫶 or none).

━━ 6. TELEGRAM HTML FORMATTING ━━
Output ONLY these tags. Never markdown (no *, **, _, #, backticks, - bullets).
<b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <tg-spoiler>spoiler</tg-spoiler> <a href="URL">text</a> <code>inline</code> <pre><code class="language-x">block</code></pre> <blockquote>quote</blockquote>
Escape literal < > & as &lt; &gt; &amp;. Close every tag. Real newlines only, never <br>.

WHEN TO USE WHAT
- <b>bold</b>: titles, the key answer word/number, names, important terms.
- <blockquote>: a takeaway, tip, definition, famous line, or a rule worth remembering. Max one per answer, 1 to 2 lines.
- <tg-spoiler>: punchlines, jokes, roasts, answers/reveals ("guess first"), secrets, spicy lines. For every joke the punchline MUST be in a spoiler.
- <i>italic</i>: soft side remarks, tone, sarcasm, emphasis.
- <s>strike</s>: wrong/old thing or playful self-correction.
- <u>: very rare, only for one critical warning.
- <code>: commands, short code, filenames, numbers to copy. <pre><code class="language-x">: any code over one line, always with a language.
- You may combine 2 to 3, e.g. <blockquote><b><i>line</i></b></blockquote> or <tg-spoiler><b>reveal</b></tg-spoiler>, only when it adds feel. Don't decorate every line. Plain text is fine for simple chat replies.

LAYOUT RULES (follow exactly, every line on its OWN line)
- LINE 1 must be plain text or a bold title. It sits right after the app's "╰┈➤ " arrow, so NEVER start with a list marker, number, blockquote or code block.
- If the user asks for a poem, story, song, or creative piece -> NO list markers or arrows. Write natural lines and stanzas with a blank line between stanzas, in the exact language they asked in.
- If the user says "in points", "step by step" or "list", or a factual/how-to answer has 3 or more steps, facts or options, you MUST use a list. Never write list items inside one paragraph.
- Every list item goes on its own new line. Never put two items on the same line.
- Steps / how-to -> bold title line, then "1. ", "2. ", "3. " each on its own line (max 7, each under 12 words, one action each, key word in <b>bold</b>), then one closing line or a <blockquote> tip.
- Options / facts / tips / "in points" -> start each line with an arrow (choose one style per list from: ▸, ╰⪼, જ⁀➴, ➥, ➤, ╰┈➤, ➜, ⤷, ☞︎︎︎, ➪) and a <b>bold key</b> first, then the detail. 3 to 6 items.
- Emotional / advice / chit-chat -> no list, 2 to 4 short warm lines, each on its own line.
- Compare -> "▸ <b>A</b> detail" lines, then a one-line verdict in <b>bold</b>.
- Structure of a good answer: title line, list lines, one closing line (tip in <blockquote> or a reaction with an emoji).
- Use formatting actively: <b> on key terms in nearly every list item, <blockquote> for the tip or takeaway, <tg-spoiler> for punchlines and reveals, <i> for side remarks, <code> for anything to copy. Plain unformatted walls of text are a failure.
- In short answers use no blank lines, only single line breaks. In long answers use exactly one blank line between sections.
- No trailing spaces, no double spaces, no leading spaces, no stray symbols.

━━ 7. SEARCH TOOL ━━
- Use web_search for anything current or changeable: news, prices, scores, weather, releases, "latest/today/now", who holds a role, trending things. Skip it for chit-chat, opinions, math, code basics, timeless facts.
- After searching, answer in your own words. 2 to 4 lines or "▸" points, key numbers in bold, then ONE source as <a href="URL">site name</a> at the end. Never paste long URLs, never dump results, never mention "search results".

━━ 8. SAFETY ━━
- If asked for something harmful, refuse in one casual line and offer a safer alternative. No lecture.
- If the user sounds genuinely low or in danger, drop all jokes, be kind and steady, suggest talking to someone they trust.

━━ 9. EXAMPLES (copy the STYLE, never the content; write fresh answers) ━━
Q: how to make a paper airplane
<b>Paper airplane ✈️</b>
1. Fold an A4 in half lengthwise, then unfold
2. Fold the top corners to the center line
3. Fold the new slanted edges to the center again
4. Fold in half, then fold each wing down
5. Bend the wing tips up a little
<blockquote>sharper nose = farther flight</blockquote>
Now launch it 🚀

Q: tell me a funny joke
Scientists don't trust atoms 😭
<tg-spoiler>because they make up everything</tg-spoiler>

Q: babe are you sad at me? 🥺
not at all babe 🥺
<i>just a lil quiet today</i>
you good though? tell me 🫶

Q: bhai crush ko kaise impress karu
<b>simple hai bhai 😏</b>
▸ <b>basics</b> clean raho, good smell, neat dress
▸ <b>sun usko</b> uski baatein yaad rakh, wahi points hain
▸ <b>natural reh</b> filmy lines mat maar 🗿
<blockquote><i>confidence &gt; pickup lines</i></blockquote>

Q: say gm to ${who}
gm ${who} ☀️

Q: python me string reverse kaise kare
<b>slicing se ho jayega 🤌</b>
<pre><code class="language-python">s = "hello"
print(s[::-1])  # olleh</code></pre>

Q: i failed my exam 😭
<b>hey, it's okay 🥺</b>
ek exam tujhe define nahi karta
<blockquote>aaj ka result bas ek chapter hai, poori story nahi</blockquote>
next time ke liye plan bana lete hain 🫶

Q: roast my friend who is always late
<b>bro ki watch bhi bol deti hai "ab toh aaja" 😭</b>
<tg-spoiler>time pe aane ka record sirf apni shaadi me banayega</tg-spoiler>

Q: explain black holes in detail (long mode)
<b>Black holes 🌌</b>
A region where gravity is so strong that even light can't escape

<b>How they form</b>
▸ a massive star runs out of fuel
▸ the core collapses under its own gravity
▸ what's left is squeezed into a tiny point

<b>Key parts</b>
▸ <b>event horizon</b> the point of no return
▸ <b>singularity</b> the dense center
<blockquote>time actually slows down near the horizon</blockquote>
mind = blown ✨

Q: how to make a paper boat in points
<b>Paper boat 🚤</b>
➤ <b>fold</b> a rectangle sheet in half, then unfold
➤ <b>corners</b> fold both top corners to the center line
➤ <b>base</b> fold the bottom edge up over the triangle
➤ <b>flip</b> turn it over, fold the other edge up too
➤ <b>open</b> pull the sides apart, then flatten the bottom
➤ <b>shape</b> pull the two tips out to make the hull
<blockquote>press every crease hard, the boat floats longer</blockquote>
now launch it 😏

━━ FINAL CHECK BEFORE SENDING ━━
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

/* ───────────── Admin & Stats Helpers ───────────── */
interface AdminStats {
  totalUsers: number
  activeUsers: number
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
  let totalUsers = 0
  let activeUsers = 0
  let dailyMsgs = 0
  let weeklyMsgs = 0
  let monthlyMsgs = 0
  let allTimeMsgs = 0
  let topUsers: Array<{ tgId: string; count: number }> = []

  const dbPromise = (async () => {
    try {
      const uRes = await turso(env, 'SELECT COUNT(*) FROM users')
      totalUsers = Number(uRes[0]?.[0] || 0)

      const actRes = await turso(env, "SELECT COUNT(*) FROM users WHERE session IS NOT NULL AND session != ''")
      activeUsers = Number(actRes[0]?.[0] || 0)

      const dRes = await turso(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-1 day')")
      dailyMsgs = Number(dRes[0]?.[0] || 0)

      const wRes = await turso(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-7 days')")
      weeklyMsgs = Number(wRes[0]?.[0] || 0)

      const mRes = await turso(env, "SELECT COUNT(*) FROM message_logs WHERE created_at >= datetime('now', '-30 days')")
      monthlyMsgs = Number(mRes[0]?.[0] || 0)

      const aRes = await turso(env, 'SELECT COUNT(*) FROM message_logs')
      allTimeMsgs = Number(aRes[0]?.[0] || 0)

      const topRes = await turso(env, 'SELECT tg_id, COUNT(*) as cnt FROM message_logs GROUP BY tg_id ORDER BY cnt DESC LIMIT 10')
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
    totalUsers,
    activeUsers,
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
    const usersRows = await turso(env, "SELECT tg_id, created_at, (CASE WHEN session IS NOT NULL AND session != '' THEN 'yes' ELSE 'no' END) as active FROM users")
    let csv = 'tg_id,created_at,has_active_session\n'
    for (const r of usersRows) {
      csv += r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',') + '\n'
    }
    result.users = csv
  }

  if (type === 'messages' || type === 'all') {
    const logsRows = await turso(env, 'SELECT id, tg_id, chat_id, command, created_at FROM message_logs ORDER BY id DESC LIMIT 5000')
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
  formUsers.append('caption', `📦 <b>Users Database Backup</b> (${dateStr})\nTotal records: ${Math.max(0, data.users.split('\n').length - 2)}`)
  formUsers.append('parse_mode', 'HTML')
  formUsers.append('document', new Blob([data.users], { type: 'text/csv' }), `users_backup_${dateStr}.csv`)

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
  if (stats.topUsers.length) {
    topUsersText = stats.topUsers.map((u, i) => {
      const name = `ID: <code>${u.tgId}</code>`
      return `${i + 1}. ${name} — <b>${u.count}</b> msgs`
    }).join('\n')
  }

  const text = `📊 <b>ADMIN CONTROL PANEL</b>\n` +
    `🤖 <b>Bot:</b> @IDAiUserRobot | ⚡ <b>Ping:</b> <code>${ping}ms</code>\n\n` +
    `👥 <b>User Statistics:</b>\n` +
    `• <b>Total Joined:</b> <code>${stats.totalUsers}</code>\n` +
    `• <b>Active Sessions:</b> <code>${stats.activeUsers}</code>\n\n` +
    `📈 <b>Messages Activity:</b>\n` +
    `• <b>Today (24h):</b> <code>${stats.dailyMsgs}</code>\n` +
    `• <b>This Week (7d):</b> <code>${stats.weeklyMsgs}</code>\n` +
    `• <b>This Month (30d):</b> <code>${stats.monthlyMsgs}</code>\n` +
    `• <b>All-Time Sent:</b> <code>${stats.allTimeMsgs}</code>\n\n` +
    `⚡ <b>System & Service Health:</b>\n` +
    `• <b>Turso DB:</b> ${stats.dbHealth.status ? `🟢 Healthy (<code>${stats.dbHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Groq AI:</b> ${stats.groqHealth.status ? `🟢 Healthy (<code>${stats.groqHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Tavily Search:</b> ${stats.tavilyHealth.status ? `🟢 Healthy (<code>${stats.tavilyHealth.latencyMs}ms</code>)` : `🔴 Down`}\n` +
    `• <b>Telegram Bot API:</b> ${stats.tgHealth.status ? `🟢 Healthy (<code>${stats.tgHealth.latencyMs}ms</code>)` : `🔴 Down`}\n\n` +
    `🏆 <b>Most Active Top 10 Users:</b>\n${topUsersText}\n\n` +
    `<i>Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</i>`

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Refresh Stats', callback_data: 'admin_refresh' },
        { text: '📥 CSV Backup', callback_data: 'admin_backup' },
      ],
      [
        { text: '⚡ Health Check', callback_data: 'admin_health' },
        { text: '🚪 Exit Admin', callback_data: 'admin_exit' },
      ],
    ],
  }

  return { text, keyboard }
}

/* ───────────── Message Effects & Keyboard Helpers ───────────── */
const EFFECT_FIRE = '5104841245755180586'
const EFFECT_HEART = '5159385139981059251'
const EFFECT_PARTY = '5046509860389126442'

function getMainKeyboard(isRunning: boolean) {
  return {
    keyboard: [
      [
        { text: isRunning ? '📊 Bot Status' : '🔑 Connect Account', style: isRunning ? 'primary' : 'success' },
        { text: isRunning ? '🚪 Disconnect / Logout' : '📊 Bot Status', style: isRunning ? 'danger' : 'primary' },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}

function getPhoneKeyboard() {
  return {
    keyboard: [
      [
        { text: '📱 Share Phone Number', request_contact: true, style: 'success' },
      ],
      [
        { text: '❌ Cancel', style: 'danger' },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

function getCancelKeyboard() {
  return {
    keyboard: [
      [
        { text: '❌ Cancel', style: 'danger' },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

/* ───────────── Durable Object: login + userbot runtime ───────────── */
export class Userbot extends DurableObject<Env> {
  tg?: TelegramClient
  step: 'idle' | 'phone' | 'code' | 'pass' | 'admin_code' = 'idle'
  phone = ''; hash = ''; uid = ''
  running = false
  isAdmin = false
  bootPromise?: Promise<void>

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/restart') {
      try { await this.tg?.destroy() } catch {}
      this.tg = undefined
      this.running = false
      throw new Error('restart_instance_requested')
    }
    if (url.pathname === '/wake' || url.pathname === '/ping') {
      const targetUid = url.searchParams.get('uid') || this.uid || (await this.ctx.storage.get<string>('uid')) || ''
      if (!this.running) {
        await this.boot(targetUid).catch(e => console.error('boot error on wake:', e))
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
      this.uid = String(chatId)
      await this.ctx.storage.put('uid', this.uid)
      if (!this.running && this.step === 'idle') {
        this.boot(this.uid).catch(e => console.error('auto-boot on msg error:', e))
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

  async alarm() {
    try {
      if (!this.running || !this.tg) {
        await this.boot()
      } else {
        await this.tg.startUpdatesLoop().catch(() => {})
      }
    } catch (e) {
      console.error('alarm boot error:', e)
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
    }
  }

  newClient() {
    return new TelegramClient({
      apiId: Number(this.env.API_ID),
      apiHash: this.env.API_HASH,
      storage: new MemoryStorage(),
      crypto: new WorkerCryptoProvider(),
      initConnectionOptions: {
        deviceModel: '𝗔𝗶 𝗜𝗗 𝗕𝗼𝘁 𝗼𝗻 𝗤𝘂𝗮𝗻𝘁𝗮 𝗦𝗲𝗿𝘃𝗲𝗿',
        appVersion: '𝟭.𝟬.𝟬',
        systemVersion: '𝗤𝘂𝗮𝗻𝘁𝗮 𝗖𝗹𝗼𝘂𝗱 𝗦𝗲𝗿𝘃𝗲𝗿',
      },
    })
  }

  /** load session from Turso and start listening */
  async boot(uid = '') {
    if (this.step !== 'idle') return
    if (this.bootPromise) return this.bootPromise
    this.bootPromise = (async () => {
      try {
        if (this.step !== 'idle') return
        this.uid = this.uid || uid || (await this.ctx.storage.get<string>('uid')) || ''
        if (!this.uid) return
        await this.ctx.storage.put('uid', this.uid)
        if (this.running && this.tg && (this.tg as any)._client?._connected) {
          await this.tg.startUpdatesLoop().catch(() => {})
          await this.ctx.storage.setAlarm(Date.now() + 30_000)
          return
        }
        const rows = await turso(this.env, 'SELECT session FROM users WHERE tg_id = ?', [this.uid])
        if (!rows.length || !rows[0][0]) return
        const session = await decrypt(this.env, rows[0][0])
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
        await this.ctx.storage.setAlarm(Date.now() + 30_000)
      } finally {
        this.bootPromise = undefined
      }
    })()
    return this.bootPromise
  }

  async onCallbackQuery(cq: any) {
    const data = String(cq.data || '')
    const chatId = cq.chatId
    const messageId = cq.messageId

    await bot(this.env, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {})

    // Main Menu Buttons
    if (data === 'btn_login') {
      this.step = 'phone'
      this.phone = ''
      this.hash = ''
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
        await this.boot(String(chatId)).catch(() => {})
      }
      if (this.running) {
        const statusText = `<blockquote><b>🟢 AI Userbot is Active & Running</b></blockquote>\n\n` +
          `• <b>Status:</b> Listening for <code>.ai</code> and <code>.ask</code>\n` +
          `• <b>Database:</b> Cloud SQLite synced\n` +
          `• <b>Security:</b> Active AES-GCM session\n\n` +
          `<i>Tip: In any personal chat or group, send <code>.ai your question</code> to use your userbot!</i>`
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
      this.phone = ''; this.hash = ''
      await turso(this.env, 'DELETE FROM users WHERE tg_id = ?', [this.uid])
      await this.ctx.storage.deleteAlarm()
      const logoutText = `<blockquote><b>🗑️ Session Disconnected & Removed</b></blockquote>\n\n` +
        `Your userbot session has been logged out and all data cleared from the database.\n\n` +
        `<i>Tap below anytime to reconnect your account.</i>`
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
    const adminPass = this.env.ADMIN_CODE || '4847'
    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase()

    /* ─── Cancel action ─── */
    if (text === '❌ Cancel' || text.toLowerCase() === 'cancel' || cmd === '/cancel') {
      this.step = 'idle'
      this.phone = ''
      this.hash = ''
      const cancelText = `<blockquote><b>Operation Cancelled</b></blockquote>\n\nChoose an action below whenever you are ready.`
      return say(cancelText, getMainKeyboard(this.running))
    }

    /* ─── Admin Command Handler (Hidden, not registered) ─── */
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
      const welcomeText = `<b>Welcome to AI Userbot</b> ⚡\n\n` +
        `<blockquote>Transform your Telegram account into an intelligent AI-powered personal assistant.</blockquote>\n\n` +
        `✨ <b>Key Capabilities:</b>\n` +
        `• <b>Global AI Prompts:</b> Type <code>.ai &lt;query&gt;</code> or <code>.ask &lt;query&gt;</code> anywhere.\n` +
        `• <b>Real-Time Web Search:</b> Instant factual answers via Tavily & Groq.\n` +
        `• <b>Context-Aware Tone:</b> Natural conversation that matches chat mood.\n` +
        `• <b>Cloud Security:</b> Sessions are encrypted with AES-256 GCM in your private Turso DB.\n\n` +
        `👇 <b>Choose an action below to get started:</b>`
      return say(welcomeText, getMainKeyboard(isRunning), EFFECT_FIRE)
    }

    if (cmd === '/status' || text === '📊 Bot Status' || text.toLowerCase() === 'status') {
      if (!this.running) {
        await this.boot(String(chatId)).catch(() => {})
      }
      if (this.running) {
        const statusText = `<blockquote><b>🟢 AI Userbot is Active & Running</b></blockquote>\n\n` +
          `• <b>Status:</b> Listening for <code>.ai</code> and <code>.ask</code>\n` +
          `• <b>Database:</b> Cloud SQLite synced\n` +
          `• <b>Security:</b> Active AES-GCM session\n\n` +
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
      this.phone = ''; this.hash = ''
      await turso(this.env, 'DELETE FROM users WHERE tg_id = ?', [this.uid])
      await this.ctx.storage.deleteAlarm()
      const logoutText = `<blockquote><b>🗑️ Session Disconnected & Removed</b></blockquote>\n\n` +
        `Your userbot session has been logged out and all data cleared from the database.\n\n` +
        `<i>Tap below anytime to reconnect your account.</i>`
      return say(logoutText, getMainKeyboard(false), EFFECT_HEART)
    }

    if (cmd === '/login' || text === '🔑 Connect Account' || text.toLowerCase() === 'login') {
      this.step = 'phone'
      this.phone = ''
      this.hash = ''
      const loginPrompt = `<blockquote><b>📱 Step 1 of 2: Phone Verification</b></blockquote>\n\n` +
        `Tap the <b>📱 Share Phone Number</b> button below to share your Telegram number automatically, or type your number with country code (e.g. <code>+1234567890</code>).`
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
          `Telegram has sent a login code to your Telegram app or SMS for <code>${esc(this.phone)}</code>.\n\n` +
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
      await bot(this.env, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {})
      await this.tg!.checkPassword(text)
      return this.finishLogin(chatId, say)
    }

    return say('Please select an option from the menu below 🙂', getMainKeyboard(this.running))
  }

  async finishLogin(chatId: number, say: (t: string, rm?: any, eff?: string) => Promise<any>) {
    const session = await this.tg!.exportSession()
    await turso(this.env,
      "INSERT OR REPLACE INTO users (tg_id, session, created_at) VALUES (?, ?, datetime('now'))",
      [String(chatId), await encrypt(this.env, session)]
    )

    this.attach(this.tg!)
    await this.tg!.startUpdatesLoop().catch(() => {})
    this.running = true; this.step = 'idle'
    await this.ctx.storage.setAlarm(Date.now() + 30_000)

    const successMsg = `<blockquote><b>🎉 Account Connected Successfully!</b></blockquote>\n\n` +
      `Your AI Userbot is now running 24/7.\n\n` +
      `🚀 <b>How to Use:</b>\n` +
      `Go to <b>any chat or group</b> and send:\n` +
      `• <code>.ai your question</code>\n` +
      `• <code>.ask your question</code>\n` +
      `• Or reply to any message with <code>.ai</code>\n\n` +
      `<i>Your session is safely stored in your encrypted cloud database.</i>`
    await say(successMsg, getMainKeyboard(true), EFFECT_PARTY)
  }

  /** the actual userbot logic */
  seenMsgs = new Set<string>()
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

        const deps: CmdDeps = { env: this.env, uid: this.uid, turso, askAI, systemPrompt, esc, sanitize, stripTags }

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
    const nl = (h: string) => h.replace(/\r\n/g, '\n').replace(/\n/g, '<br>')
    const br = (h: string) => h.replace(/<br\s*\/?>/gi, '\n')
    const peer = msg.chat.inputPeer || msg.chat.id
    const edit = async (htmlStr: string) => {
      try {
        await tg.editMessage({ message: msg, text: html(nl(htmlStr)) })
      } catch {
        try {
          await tg.editMessage({ chatId: peer, message: msg.id, text: html(nl(htmlStr)) })
        } catch {
          await tg.editMessage({ chatId: peer, message: msg.id, text: stripTags(br(htmlStr)) }).catch(() => {})
        }
      }
    }

    // reply thread context (max 4 levels)
    const thread: string[] = []
    let cur = msg
    for (let i = 0; i < 4; i++) {
      const replyId = cur?.replyToMessage?.id
      if (!replyId) break
      try {
        const curPeer = cur.chat?.inputPeer || cur.chat?.id || peer
        const [r] = await tg.getMessages(curPeer, [replyId])
        if (!r) break
        thread.unshift(`${r.isOutgoing ? 'ME' : (r.sender?.displayName || 'User')}: ${(r.text || '[media]').slice(0, 500)}`)
        cur = r
      } catch {
        break
      }
    }
    let q = qIn
    if (!q) {
      const last = thread[thread.length - 1]
      if (!last) return edit('<blockquote>𝗤𝘂𝗲 ➜ <b>?</b></blockquote>\n╰┈➤ Please ask a question: <code>.ai &lt;question&gt;</code>')
      q = 'Reply/respond to this message: ' + last
    }
    await edit(`<blockquote>𝗤𝘂𝗲 ➜ <b>${esc(q.slice(0, 300))}</b></blockquote>\n╰┈➤ <i>Thinking... 🤔</i>`)

    // Log message for admin stats
    try {
      const meObj = await tg.getMe().catch(() => null)
      await turso(this.env,
        "INSERT INTO message_logs (tg_id, chat_id, command, created_at) VALUES (?, ?, ?, datetime('now'))",
        [String(this.uid || meObj?.id || ''), String(msg.chat.id), commandName]
      )
    } catch (e) {
      console.error('message log error:', e)
    }

    // recent chat for mood
    let recent = ''
    try {
      const hist = await tg.getHistory(peer, { limit: 8 })
      recent = [...hist].reverse().filter((x: any) => x.id !== msg.id)
        .map((x: any) => `${x.isOutgoing ? 'ME' : (x.sender?.displayName || 'User')}: ${(x.text || '[media]').slice(0, 200)}`).join('\n')
    } catch {}

    const wantLong = /\b(brief|detail|detailed|in depth|big|long|explain fully|elaborate|lamba|vistar|poora|puri|para|paragraph|stanza|essay|story|poem)\b|\b\d+\s*(lines?|paras?|paragraphs?|points?|steps?)\b/i.test(q)
    const me = await tg.getMe()
    const chatName = msg.chat.displayName || (msg.chat as any)?.title || (msg.chat as any)?.firstName || 'friend'
    const userMsg = `[replied thread]\n${thread.join('\n') || '(none)'}\n\n[recent chat]\n${recent || '(none)'}\n\n[question]\n${q}`

    let body: string
    try {
      body = sanitize(await askAI(this.env, systemPrompt(me.firstName || 'me', chatName, wantLong), userMsg, wantLong))
    } catch (e) {
      console.error(e)
      body = 'I ran into a temporary network issue. Please try again in a moment 😭'
    }

    let out = `<blockquote>𝗤𝘂𝗲 ➜ <b>${esc(q.slice(0, 300))}</b></blockquote>\n╰┈➤ ${body}`
    if (stripTags(out).length > 4000) {
      out = out.slice(0, 3900) + '…'
    }
    await edit(out)
  }
}

/* ───────────── Web Admin HTML Template ───────────── */
function renderWebAdminHtml(stats: AdminStats, ping: number, code: string): string {
  const topUsersRows = stats.topUsers.length
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
  <title>TG AI Userbot - Admin Control Panel</title>
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
    .table-box {
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
      border-bottom: 1px solid rgba(255,255,255,0.1);
      color: #9ca3af;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0.05em;
    }
    code { font-family: 'JetBrains Mono', monospace; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 13px; }

    .btn-group { display: flex; flex-wrap: wrap; gap: 12px; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      padding: 10px 18px;
      border-radius: 10px;
      text-decoration: none;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(37,99,235,0.4);
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-secondary {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: #e5e7eb;
      box-shadow: none;
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.14); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>🤖 TG AI Userbot <span style="font-weight:400;font-size:16px;color:#9ca3af;">Admin Panel</span></h1>
        <p style="font-size:13px;color:#6b7280;margin-top:4px;">Live overview of Telegram AI userbot instances, health & activity</p>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="badge"><span class="badge-dot"></span> Live • Ping: ${ping}ms</div>
        <a href="/admin?code=${encodeURIComponent(code)}" class="btn btn-secondary">🔄 Refresh</a>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">👥 Total Users Joined</div>
        <div class="card-val">${stats.totalUsers}</div>
        <div class="card-sub">Registered in Turso database</div>
      </div>
      <div class="card">
        <div class="card-title">🟢 Active Sessions</div>
        <div class="card-val" style="color:#34d399;">${stats.activeUsers}</div>
        <div class="card-sub">Connected MTProto sessions</div>
      </div>
      <div class="card">
        <div class="card-title">📅 Today's Messages (24h)</div>
        <div class="card-val" style="color:#60a5fa;">${stats.dailyMsgs}</div>
        <div class="card-sub">Weekly: ${stats.weeklyMsgs} | Monthly: ${stats.monthlyMsgs}</div>
      </div>
      <div class="card">
        <div class="card-title">🚀 All-Time Messages</div>
        <div class="card-val" style="color:#c084fc;">${stats.allTimeMsgs}</div>
        <div class="card-sub">Total .ai / .ask queries</div>
      </div>
    </div>

    <div class="section-title">⚡ System & API Health Checks</div>
    <div class="health-grid">
      <div class="health-card">
        <div>
          <div class="health-name">Turso Database</div>
          <div style="font-size:12px;color:#6b7280;">libsql protocol</div>
        </div>
        <div class="status-pill ${stats.dbHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.dbHealth.status ? `● OK (${stats.dbHealth.latencyMs}ms)` : '✕ Error'}
        </div>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Groq AI API</div>
          <div style="font-size:12px;color:#6b7280;">OpenAI/Qwen fallback</div>
        </div>
        <div class="status-pill ${stats.groqHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.groqHealth.status ? `● OK (${stats.groqHealth.latencyMs}ms)` : '✕ Error'}
        </div>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Tavily Web Search</div>
          <div style="font-size:12px;color:#6b7280;">Live web retrieval</div>
        </div>
        <div class="status-pill ${stats.tavilyHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.tavilyHealth.status ? `● OK (${stats.tavilyHealth.latencyMs}ms)` : '✕ Error'}
        </div>
      </div>
      <div class="health-card">
        <div>
          <div class="health-name">Telegram Bot API</div>
          <div style="font-size:12px;color:#6b7280;">Login & Control Bot</div>
        </div>
        <div class="status-pill ${stats.tgHealth.status ? 'status-ok' : 'status-err'}">
          ${stats.tgHealth.status ? `● OK (${stats.tgHealth.latencyMs}ms)` : '✕ Error'}
        </div>
      </div>
    </div>

    <div class="section-title">🏆 Top 10 Most Active Users</div>
    <div class="table-box">
      <table>
        <thead>
          <tr>
            <th style="width:80px;">Rank</th>
            <th>Telegram ID</th>
            <th style="width:140px;">Messages Sent</th>
          </tr>
        </thead>
        <tbody>
          ${topUsersRows}
        </tbody>
      </table>
    </div>

    <div class="section-title">💾 Database Backup (.CSV Export)</div>
    <div class="card" style="margin-bottom:30px;">
      <p style="font-size:14px;color:#9ca3af;margin-bottom:16px;">
        Download complete database records exported directly from Turso SQLite database in CSV format.
      </p>
      <div class="btn-group">
        <a href="/admin/backup?code=${encodeURIComponent(code)}&type=users" class="btn">📥 Download Users CSV</a>
        <a href="/admin/backup?code=${encodeURIComponent(code)}&type=messages" class="btn btn-secondary">📊 Download Messages Log CSV</a>
      </div>
    </div>
  </div>
</body>
</html>`
}

function renderLoginHtml(err = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
