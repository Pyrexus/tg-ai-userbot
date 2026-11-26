import { TelegramClient, InputMedia } from '@mtcute/web'
import { html } from '@mtcute/html-parser'

export interface CmdDeps {
  env: any
  uid: string
  turso: (env: any, sql: string, args?: string[]) => Promise<string[][]>
  askAI: (env: any, system: string, userMsg: string, wantLong: boolean) => Promise<string>
  systemPrompt: (owner: string, chatName: string, wantLong: boolean) => string
  esc: (s: string) => string
  sanitize: (h: string) => string
  stripTags: (h: string) => string
}

const nl = (h: string) => h.replace(/\r\n/g, '\n').replace(/\n/g, '<br>')
const br = (h: string) => h.replace(/<br\s*\/?>/gi, '\n')

async function editMsg(tg: TelegramClient, msg: any, peer: any, htmlStr: string, stripTags: (s: string) => string) {
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

export async function handleSpam(tg: TelegramClient, msg: any, deps: CmdDeps, fast: boolean, rawCount: number, rawText: string) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const count = Math.min(30, Math.max(1, rawCount || 1))
  const replyId = msg.replyToMessage?.id
  let sendText = rawText
  let useHtml = false

  if (!sendText && replyId) {
    const [replied] = await tg.getMessages(peer, [replyId]).catch(() => [null])
    if (replied?.sender) {
      const s = replied.sender
      sendText = s.username ? `@${s.username}` : `<a href="tg://user?id=${s.id}">${deps.esc(s.displayName || 'User')}</a>`
      useHtml = !s.username
    }
  }
  if (!sendText) {
    await editMsg(tg, msg, peer, '<b>Usage: .s 10 hello</b>', deps.stripTags)
    return
  }

  await tg.deleteMessagesById(peer, [msg.id], { revoke: true }).catch(() => {})
  const payload: any = useHtml ? html(sendText) : sendText
  const opts = replyId ? { replyTo: replyId } : undefined

  if (fast) {
    await Promise.all(Array.from({ length: count }, () => tg.sendText(peer, payload, opts).catch(() => {})))
  } else {
    for (let i = 0; i < count; i++) {
      await tg.sendText(peer, payload, opts).catch(() => {})
      if (i < count - 1) await new Promise(r => setTimeout(r, 750))
    }
  }
}

export async function handleClone(tg: TelegramClient, msg: any, deps: CmdDeps, rawCount: number, text: string) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const count = Math.min(100, Math.max(1, rawCount || 1))
  const repeated = Array(count).fill(text.trim()).join(' ').slice(0, 3950)
  await editMsg(tg, msg, peer, `<b>${deps.esc(repeated)}</b>`, deps.stripTags)
}

export async function handleId(tg: TelegramClient, msg: any, deps: CmdDeps) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const replyId = msg.replyToMessage?.id
  let target: any = msg.sender
  if (replyId) {
    const [replied] = await tg.getMessages(peer, [replyId]).catch(() => [null])
    if (replied?.sender) target = replied.sender
  }
  const ct = (msg.chat as any).chatType
  let joinedStr = 'N/A'
  if (target?.id && (ct === 'group' || ct === 'supergroup' || ct === 'channel' || ct === 'gigagroup')) {
    const member = await tg.getChatMember({ chatId: peer, userId: target.inputPeer || target.id }).catch(() => null)
    if (member?.joinedDate) joinedStr = member.joinedDate.toISOString().slice(0, 10)
  }

  const uname = target?.username ? `@${target.username}` : 'None'
  const chatTitle = msg.chat.displayName || (msg.chat as any)?.title || 'Private Chat'
  const info = `<b>👤 User Info</b>\n` +
    `• <b>Name:</b> ${deps.esc(target?.displayName || 'Unknown')}\n` +
    `• <b>User ID:</b> <code>${target?.id || 'N/A'}</code>\n` +
    `• <b>Username:</b> ${deps.esc(uname)}\n` +
    `• <b>Chat:</b> ${deps.esc(chatTitle)} (<code>${msg.chat.id}</code>)\n` +
    `• <b>Joined:</b> <code>${joinedStr}</code>`
  await editMsg(tg, msg, peer, info, deps.stripTags)
}

export async function handlePing(tg: TelegramClient, msg: any, deps: CmdDeps) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const t0 = Date.now()
  await editMsg(tg, msg, peer, '<b>🏓 Pinging...</b>', deps.stripTags)
  const me = await tg.getMe().catch(() => null)
  const ms = Date.now() - t0
  const uname = me?.username ? `@${me.username}` : (me?.id ? `#${me.id}` : 'me')
  await editMsg(tg, msg, peer, `<b>🏓 ${deps.esc(uname)} · Pong!</b> <code>${ms}ms</code>`, deps.stripTags)
}

export async function handleMod(tg: TelegramClient, msg: any, deps: CmdDeps, rawCmd: string, arg: string) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const editHtml = (s: string) => editMsg(tg, msg, peer, s, deps.stripTags)

  const ct = (msg.chat as any).chatType
  if (ct !== 'group' && ct !== 'supergroup' && ct !== 'channel' && ct !== 'gigagroup') {
    return editHtml('<b>This command only works in groups or channels</b>')
  }

  const replyId = msg.replyToMessage?.id
  if (!replyId) {
    return editHtml("<b>Reply to a user's message first</b>")
  }
  const [replied] = await tg.getMessages(peer, [replyId]).catch(() => [null])
  const target: any = replied?.sender
  if (!target?.id) {
    return editHtml('<b>Could not resolve target user from replied message</b>')
  }

  const cmd = rawCmd === 'p' ? 'promote' : rawCmd
  const meMember = await tg.getChatMember({ chatId: peer, userId: 'me' }).catch(() => null)
  if (!meMember || (meMember.status !== 'creator' && meMember.status !== 'admin')) {
    return editHtml('<b>Missing rights: You are not an admin in this chat</b>')
  }
  if (meMember.status === 'admin' && meMember.permissions) {
    if ((cmd === 'ban' || cmd === 'kick' || cmd === 'mute' || cmd === 'warn') && !meMember.permissions.banUsers) {
      return editHtml('<b>Missing admin right: Ban Users (banUsers)</b>')
    }
    if ((cmd === 'promote' || cmd === 'demote') && !meMember.permissions.addAdmins) {
      return editHtml('<b>Missing admin right: Add New Admins (addAdmins)</b>')
    }
  }

  const targetPeer = target.inputPeer || target.id
  const targetName = deps.esc(target.displayName || 'User')

  try {
    if (cmd === 'kick') {
      await tg.kickChatMember({ chatId: peer, userId: targetPeer })
      return editHtml(`<b>👢 Kicked ${targetName}</b> (<code>${target.id}</code>)`)
    }

    if (cmd === 'ban') {
      await tg.banChatMember({ chatId: peer, participantId: targetPeer })
      let roast = `<b>${targetName}</b> got yeeted out of here forever 💀\n<i>better luck next server</i>`
      try {
        const aiRoast = await deps.askAI(
          deps.env,
          'Write a brutal, funny 2-line ban roast in Telegram HTML (<b>, <i>). No disclaimers, max 2 lines.',
          `Banning user ${target.displayName || 'User'}${arg ? ` for: ${arg}` : ''}`,
          false
        )
        if (aiRoast) roast = deps.sanitize(aiRoast)
      } catch {}
      return editHtml(`<b>🔨 Banned ${targetName}</b> (<code>${target.id}</code>)\n${roast}`)
    }

    if (cmd === 'mute') {
      const tm = arg.match(/^(\d+)\s*(m|h|d)$/i)
      if (!tm) return editHtml('<b>Usage: .mute 10m / 1h / 1d</b>')
      const val = Number(tm[1])
      const unit = tm[2].toLowerCase()
      const secs = unit === 'm' ? val * 60 : (unit === 'h' ? val * 3600 : val * 86400)
      const until = new Date(Date.now() + Math.max(35, secs) * 1000)
      await tg.restrictChatMember({
        chatId: peer,
        userId: targetPeer,
        restrictions: { sendMessages: true, sendMedia: true, sendStickers: true, sendGifs: true, sendGames: true, sendInline: true, embedLinks: true, sendPolls: true },
        until,
      })
      return editHtml(`<b>🔇 Muted ${targetName} for ${deps.esc(arg)}</b>`)
    }

    if (cmd === 'warn') {
      await deps.turso(deps.env, 'CREATE TABLE IF NOT EXISTS warns (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, user_id))')
      const rows = await deps.turso(deps.env, 'SELECT count FROM warns WHERE chat_id = ? AND user_id = ?', [String(msg.chat.id), String(target.id)])
      const newCount = Number(rows[0]?.[0] || 0) + 1
      const reason = arg || 'No reason provided'
      if (newCount >= 3) {
        await deps.turso(deps.env, 'DELETE FROM warns WHERE chat_id = ? AND user_id = ?', [String(msg.chat.id), String(target.id)])
        await tg.banChatMember({ chatId: peer, participantId: targetPeer })
        return editHtml(`<b>⚠️ Warn 3/3 — ${targetName} has been BANNED!</b>\n<b>Reason:</b> ${deps.esc(reason)}`)
      }
      await deps.turso(deps.env, 'INSERT OR REPLACE INTO warns (chat_id, user_id, count) VALUES (?, ?, ?)', [String(msg.chat.id), String(target.id), String(newCount)])
      return editHtml(`<b>⚠️ Warned ${targetName} (${newCount}/3)</b>\n<b>Reason:</b> ${deps.esc(reason)}`)
    }

    if (cmd === 'promote') {
      await tg.editAdminRights({
        chatId: peer,
        userId: targetPeer,
        rights: { changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, manageCall: true, manageTopics: true },
      })
      return editHtml(`<b>⚡ Promoted ${targetName} to Admin</b>`)
    }

    if (cmd === 'demote') {
      await tg.editAdminRights({
        chatId: peer,
        userId: targetPeer,
        rights: { changeInfo: false, postMessages: false, editMessages: false, deleteMessages: false, banUsers: false, inviteUsers: false, pinMessages: false, addAdmins: false, anonymous: false, manageCall: false, other: false, manageTopics: false },
      })
      return editHtml(`<b>⬇️ Demoted ${targetName} from Admin</b>`)
    }
  } catch (e: any) {
    return editHtml(`<b>Action failed:</b> <code>${deps.esc(e?.message || e)}</code>`)
  }
}

export async function handleCleanup(tg: TelegramClient, msg: any, deps: CmdDeps, cmd: string) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const editBold = (text: string) => editMsg(tg, msg, peer, `<b>${deps.esc(text)}</b>`, deps.stripTags)

  const replyId = msg.replyToMessage?.id
  const mode = cmd === 'purge' ? 'purge' : (cmd === 'w' || cmd === 'wipe' ? 'wipe' : 'burn')

  // purge requires a reply only in groups; in DMs it purges everything from start
  const ct = (msg.chat as any).chatType
  const isDm = !ct || ct === 'private' || ct === 'user'
  if (mode === 'purge' && !replyId && !isDm) {
    return editBold('Reply to a message to purge from there')
  }

  const myId = deps.uid || String((await tg.getMe().catch(() => null))?.id || '')
  const isOwnerDmBlocked = mode === 'purge' && Boolean(deps.uid && String(msg.chat.id) === String(deps.uid) && String(msg.sender?.id || '') !== String(deps.uid))

  if (mode === 'wipe' && !isDm) {
    const member = await tg.getChatMember({ chatId: peer, userId: 'me' }).catch(() => null)
    if (member && member.status !== 'creator' && member.status !== 'admin') {
      return editBold('Missing admin right: Admin status required to wipe bot messages')
    }
    if (member && member.status === 'admin' && member.permissions && !member.permissions.deleteMessages) {
      return editBold('Missing admin right: Delete Messages (deleteMessages)')
    }
  }

  await editBold(mode === 'purge' ? 'Purging...' : (mode === 'wipe' ? 'Wiping...' : 'Burning...'))

  const ids: number[] = []
  try {
    const limit = mode === 'purge' ? 1000 : 500
    for await (const m of tg.iterHistory(peer, { limit })) {
      if (m.id === msg.id || m.isService) continue
      if (replyId && m.id < replyId) break
      // In DMs, isOutgoing may be unreliable — also check by sender id
      const senderId = m.sender?.id ? String(m.sender.id) : ''
      const isSelf = Boolean(m.isOutgoing || senderId === myId || (isDm && !senderId))
      if (isOwnerDmBlocked) {
        if (isSelf) ids.push(m.id)
      } else if (mode === 'purge') {
        ids.push(m.id)
        if (replyId && m.id === replyId) break
      } else if (mode === 'wipe') {
        if ((m.sender as any)?.isBot || Boolean(m.viaBot)) ids.push(m.id)
      } else {
        if (isSelf) ids.push(m.id)
      }
    }
  } catch (e) {
    console.error('cleanup scan error:', e)
  }

  let deleted = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    // In DMs revoke:true fails for the other person's messages; use revoke:false
    const tryDelete = async (idList: number[], revoke: boolean) => {
      await tg.deleteMessagesById(peer, idList, { revoke })
      return idList.length
    }
    try {
      deleted += await tryDelete(chunk, !isDm)
    } catch {
      for (const id of chunk) {
        try {
          deleted += await tryDelete([id], !isDm)
        } catch {
          if (!isDm) {
            try { deleted += await tryDelete([id], false) } catch {}
          }
        }
      }
    }
  }

  if (isOwnerDmBlocked) return editBold("Don't try to be over smart in front of Lord 😌")
  if (mode === 'purge') return editBold(`${deleted} msg deleted, purge`)
  if (mode === 'wipe') return editBold(`${deleted} bot msg deleted`)
  return editBold(`${deleted} self msg deleted`)
}

export async function handleQuote(tg: TelegramClient, msg: any, deps: CmdDeps) {
  const peer = msg.chat.inputPeer || msg.chat.id
  const editHtml = (s: string) => editMsg(tg, msg, peer, s, deps.stripTags)

  const replyId = msg.replyToMessage?.id
  if (!replyId) {
    return editHtml('<b>Reply to a message with .qt to make a quote</b>')
  }

  await editHtml('<b>🍳 Quote is getting cooked...</b>')

  const [replied] = await tg.getMessages(peer, [replyId]).catch(() => [null])
  if (!replied) {
    return editHtml('<b>Could not fetch the replied message</b>')
  }

  const isOwnerProtected = Boolean(deps.uid && String(replied.sender?.id || '') === String(deps.uid) && String(msg.sender?.id || '') !== String(deps.uid))
  const quoteSender = isOwnerProtected ? msg.sender : replied.sender
  const protectText = 'Kiddo 🤡\nDont mess with owner 🙂↕️'
  const quoteText = isOwnerProtected ? protectText : (replied.text || '[media]')

  const apiUrl = String(deps.env?.QUOTE_API_URL || 'https://tg-quote-api.100coldice.workers.dev').replace(/\/$/, '')
  try {
    let replyMessage: any = undefined
    if (!isOwnerProtected) {
      const nestedId = replied.replyToMessage?.id
      if (nestedId) {
        const [nested] = await tg.getMessages(peer, [nestedId]).catch(() => [null])
        if (nested) {
          replyMessage = {
            name: nested.sender?.displayName || 'User',
            text: (nested.text || '[media]').slice(0, 500),
          }
        }
      }
    }

    const payload = {
      type: 'quote',
      format: 'webp',
      ext: 'webp',
      backgroundColor: '#1b1429',
      width: 512,
      height: 768,
      scale: 2,
      emojiBrand: 'apple',
      messages: [
        {
          entities: isOwnerProtected ? [{ type: 'bold', offset: 0, length: quoteText.length }] : [],
          avatar: true,
          from: {
            id: quoteSender?.id || 1,
            name: quoteSender?.displayName || 'User',
            ...(quoteSender?.username ? { username: quoteSender.username } : {}),
          },
          text: quoteText.slice(0, 4000),
          ...(replyMessage ? { replyMessage } : {}),
        },
      ],
    }

    const res = await fetch(`${apiUrl}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`Quote API HTTP ${res.status}`)
    const ct = res.headers.get('content-type') || ''
    let bytes: Uint8Array
    if (ct.includes('application/json')) {
      const j: any = await res.json()
      const b64 = j.result?.image || j.image
      if (!b64) throw new Error('Invalid Quote API JSON response')
      bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    } else {
      bytes = new Uint8Array(await res.arrayBuffer())
    }
    const isPng = ct.includes('png')
    await tg.sendMedia(peer, InputMedia.sticker(bytes, {
      fileName: isPng ? 'quote.png' : 'quote.webp',
      fileMime: isPng ? 'image/png' : 'image/webp',
    }), { replyTo: replyId })
    await tg.deleteMessagesById(peer, [msg.id], { revoke: true }).catch(() => {})
    return
  } catch (e: any) {
    return editHtml(`<b>Quote API failed:</b> <code>${deps.esc(e?.message || e)}</code>\n<i>Set QUOTE_API_URL to your quote-api instance</i>`)
  }
}
