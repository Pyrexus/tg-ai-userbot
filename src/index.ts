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
