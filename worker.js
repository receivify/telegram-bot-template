/**
 * ============================================================================
 * RECEIVIFY TELEGRAM BOT — one-click deploy template
 * ============================================================================
 *
 * Your own branded Telegram bot, on your own hosting, with your bot token never
 * leaving your account. Deploys to Cloudflare Workers (free tier) in about five
 * minutes.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS DELIBERATELY THIN, AND MUST STAY THAT WAY
 * ---------------------------------------------------------------------------
 * It contains NO business logic. It does not price anything, does not decide
 * what a payment is worth, does not know what a confirmation is. It asks the
 * Receivify API and renders what comes back.
 *
 * That is not laziness — it is the whole design. A fat template is a second
 * implementation of the bot, and a second implementation drifts: a field gets
 * added, the hosted bot handles it, this copy does not, and months later a
 * merchant is debugging a bot that quietly stopped naming the network. Nobody
 * would catch it, because nobody runs this code but them.
 *
 * If you find yourself wanting to add a calculation here, it belongs in the API.
 *
 * ---------------------------------------------------------------------------
 * ROUTES
 * ---------------------------------------------------------------------------
 *   POST /telegram    Telegram's webhook.  Handles `/start pay_<invoice_id>`.
 *   POST /receivify   Receivify's webhook. Tells the buyer their payment landed.
 *
 * Secrets (set with `wrangler secret put`, never committed):
 *   BOT_TOKEN          from @BotFather
 *   RECEIVIFY_API_KEY  from your Receivify dashboard
 *   TG_SECRET          any long random string; proves Telegram called you
 *   WEBHOOK_SECRET     your Receivify webhook signing secret
 *   WEBHOOK_SECRET_PREVIOUS  optional; the old secret during a rotation window
 *   API_BASE           optional; defaults to https://receivify.io
 */

const TG = 'https://api.telegram.org'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== 'POST') return new Response('ok')
    if (url.pathname === '/telegram') return handleTelegram(request, env)
    if (url.pathname === '/receivify') return handleReceivify(request, env)
    return new Response('not found', { status: 404 })
  },
}

/** Constant-time compare. Never `===` on a secret — that leaks it by timing. */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a ?? ''))
  const y = new TextEncoder().encode(String(b ?? ''))
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

async function tg(env, method, body) {
  const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => ({ ok: false }))
}

const api = (env) => (env.API_BASE || 'https://receivify.io').replace(/\/$/, '')

/* ----------------------------------------------------------------- telegram */

async function handleTelegram(request, env) {
  /* Telegram's webhook URL is public: anyone who learns it can POST a body
     claiming to be any chat. This header is the only proof the request really
     came from Telegram, so it FAILS CLOSED when unset. */
  if (!env.TG_SECRET || !safeEqual(request.headers.get('x-telegram-bot-api-secret-token'), env.TG_SECRET)) {
    return new Response('ok')   // never 4xx — Telegram retries those forever
  }

  const update = await request.json().catch(() => null)
  const msg = update?.message || update?.edited_message
  const chatId = msg?.chat?.id
  const text = msg?.text
  if (!chatId || !text?.startsWith('/')) return new Response('ok')

  const [head, arg] = text.slice(1).trim().split(/\s+/)
  const command = head.split('@')[0].toLowerCase()   // Telegram appends @BotName in groups

  if (command === 'start' && arg?.startsWith('pay_')) {
    await showPayment(env, chatId, arg.slice(4))
    return new Response('ok')
  }

  await tg(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Send me a payment link to get started.',
  })
  return new Response('ok')
}

/**
 * Render a payment.
 *
 * EVERY FIELD COMES FROM THE API — the amount, the address, the network, the QR.
 * This function chooses none of them, which is what keeps it correct when a new
 * chain is added without this file ever changing.
 */
async function showPayment(env, chatId, invoiceId) {
  const res = await fetch(`${api(env)}/api/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: { authorization: `Bearer ${env.RECEIVIFY_API_KEY}` },
  })
  if (!res.ok) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'That payment link is not valid. Ask the seller for a new one.' })
    return
  }
  const inv = await res.json()

  if (!['pending', 'confirming', 'partial'].includes(inv.status)) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'That invoice is no longer accepting payment.' })
    return
  }

  const lines = ['*Send exactly*', '', `${inv.amount_decimal} ${String(inv.asset).toUpperCase()}`]
  if (inv.amount_fiat && inv.fiat_currency) lines.push(`≈ ${inv.amount_fiat} ${inv.fiat_currency}`)
  if (inv.chain) {
    /* Naming the network is not optional. Sending USDT on the wrong chain is the
       most expensive mistake a buyer can make, and it is permanent. */
    lines.push('', `*Network:* ${inv.chain} — sending on any other network will lose the funds`)
  }
  lines.push('', '*To this address:*', `\`${inv.address}\``)

  /* The QR travels as the photo and the details as its caption, so one message
     carries both. Sent separately they can be scrolled apart, and a buyer
     checking a code against the wrong address is the confusion this avoids. */
  const sent = await tg(env, 'sendPhoto', {
    chat_id: chatId,
    photo: `${api(env)}/pay/${inv.id}/qr.png`,
    caption: lines.join('\n'),
    parse_mode: 'Markdown',
  })

  // If the image could not be fetched, the address still has to reach them.
  if (!sent?.ok) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' })
  }
}

/* ---------------------------------------------------------------- receivify */

/**
 * Receivify's webhook: a payment settled.
 *
 * THE SIGNATURE IS VERIFIED BEFORE ANYTHING IS BELIEVED. This is a public URL,
 * and without the check anyone could POST "payment received" and have your own
 * bot tell a customer their money arrived when it never did.
 */
async function handleReceivify(request, env) {
  const raw = await request.text()
  const header = request.headers.get('x-receivify-signature')

  /* Try the current secret, then the previous one. Rotating the secret in the
     dashboard keeps the old one valid for a grace window; set
     WEBHOOK_SECRET_PREVIOUS during that window so in-flight deliveries signed
     with the old secret are not rejected. */
  const secrets = [env.WEBHOOK_SECRET, env.WEBHOOK_SECRET_PREVIOUS].filter(Boolean)
  let verified = false
  for (const secret of secrets) {
    if (await verifySignature(secret, header, raw)) { verified = true; break }
  }
  if (!verified) return new Response('bad signature', { status: 401 })

  // The envelope is `{ event, sequence, created_at, data }` — the name is in `event`.
  const event = JSON.parse(raw)
  if (event?.event !== 'invoice.paid') return new Response('ok')

  /* The webhook's `data` is a slim snapshot (id, status, base-unit amounts,
     address) — it does NOT carry your metadata, the asset or a display amount.
     Fetch the invoice itself for those: it is the authoritative record. */
  const invoiceId = event?.data?.id
  if (!invoiceId) return new Response('ok')
  const res = await fetch(`${api(env)}/api/v1/invoices/${encodeURIComponent(invoiceId)}`, {
    headers: { authorization: `Bearer ${env.RECEIVIFY_API_KEY}` },
  })
  // A 5xx makes Receivify retry the delivery later, which is what we want.
  if (!res.ok) return new Response('lookup failed', { status: 502 })
  const inv = await res.json()

  /* You put this there. Pass `metadata: { telegram_chat_id: <id> }` when you
     create the invoice; it is how this worker knows which human to tell. */
  const chatId = inv?.metadata?.telegram_chat_id
  if (!chatId) return new Response('ok')

  await tg(env, 'sendMessage', {
    chat_id: chatId,
    parse_mode: 'Markdown',
    text: `✅ *Payment confirmed*\n\n${inv.amount_decimal} ${String(inv.asset).toUpperCase()} received. Thank you.`,
  })
  return new Response('ok')
}

/**
 * Verify `x-receivify-signature: t=<unix>,v1=<hex>`.
 *
 * The signed payload is `<timestamp>.<raw body>` — the RAW bytes, before any
 * JSON parsing. Re-serialising the object first changes key order and
 * whitespace, and the signature then never matches; that is the single most
 * common way this check is got wrong.
 */
async function verifySignature(secret, header, body) {
  if (!secret || !header) return false

  const parts = Object.fromEntries(
    String(header).split(',').map((p) => p.trim().split('=').map((s) => s.trim())),
  )
  const ts = parts.t
  const given = parts.v1
  if (!ts || !given) return false

  /* Reject anything older than five minutes. Without this, a signature captured
     once is replayable forever — and a replayed `invoice.paid` tells a customer
     a second payment landed. */
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts))
  if (!Number.isFinite(age) || age > 300) return false

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return safeEqual(hex, given)
}
