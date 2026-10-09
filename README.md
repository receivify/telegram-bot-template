# Receivify Telegram bot — one-click deploy

A Telegram bot for **[Receivify](https://receivify.io)**, the crypto payments API: your customers pay in crypto inside Telegram, and the bot confirms when the payment lands.

Your own branded Telegram bot that takes crypto payments. Your bot token stays
in **your** hosting account and is never shared with Receivify.

Free to run. Deploys in about five minutes.

---

## Do you actually need this?

There are three ways to take payments in Telegram, and this is the most involved
of them. Pick honestly:

| | Setup | Branding | Who holds the token |
|---|---|---|---|
| **Receivify's bot** | Nothing — link your chat once | Receivify | Receivify |
| **Connect your bot** | Paste one token in the dashboard | Yours | Receivify (encrypted) |
| **This template** | ~5 minutes, a GitHub + Cloudflare account | Yours | **You** |

Use this one if you want your own branding **and** you would rather not hand
anyone your bot token. Otherwise connect your bot in the dashboard — it does the
same thing in thirty seconds.

---

## What you need

- A Telegram bot from [@BotFather](https://t.me/BotFather) (2 minutes)
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (free)
- Your Receivify **API key** and **webhook secret**, from your dashboard

---

## Deploy

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
Copy the token — it looks like `123456789:AAHdqTcv...`.

### 2. Deploy the worker

```bash
git clone https://github.com/receivify/telegram-bot-template
cd telegram-bot-template
npm install -g wrangler
wrangler login
wrangler deploy
```

Wrangler prints your worker URL, something like
`https://receivify-bot.<your-name>.workers.dev`. Keep it.

### 3. Add your secrets

Never put these in a file. `wrangler secret put` stores them encrypted in
Cloudflare:

```bash
wrangler secret put BOT_TOKEN           # from BotFather
wrangler secret put RECEIVIFY_API_KEY   # from your Receivify dashboard
wrangler secret put WEBHOOK_SECRET      # from your Receivify dashboard
wrangler secret put TG_SECRET           # any long random string you invent
```

When you rotate the webhook secret in the dashboard, the old one stays valid for
a grace window. Put the old value in `WEBHOOK_SECRET_PREVIOUS` for that window so
deliveries already in flight still verify:

```bash
wrangler secret put WEBHOOK_SECRET_PREVIOUS
```

For `TG_SECRET`, generate one rather than typing something memorable:

```bash
openssl rand -hex 32
```

### 4. Point Telegram at your worker

Replace both placeholders with your own values:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://<YOUR-WORKER-URL>/telegram","secret_token":"<TG_SECRET>","allowed_updates":["message"]}'
```

You should get `{"ok":true,...}` back. If not, the error text says why — almost
always a typo in the URL.

### 5. Point Receivify at your worker

In your Receivify dashboard, add a webhook endpoint:

```
https://<YOUR-WORKER-URL>/receivify
```

Done.

---

## Using it

Create an invoice and include the buyer's Telegram chat id in `metadata` — that
is how the worker knows who to notify when the payment lands:

```bash
curl -X POST https://receivify.io/api/v1/invoices \
  -H "authorization: Bearer $RECEIVIFY_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "amount_fiat": "25.00",
    "currency": "GBP",
    "asset": "usdc",
    "chain": "base",
    "metadata": { "telegram_chat_id": "123456789" }
  }'
```

Then send the buyer `https://t.me/<YourBot>?start=pay_<invoice_id>`.

They tap it, your bot shows them the coin, the network, the address, the amount
and a QR code. When the payment confirms, your bot tells them.

---

## Why this file is so short

It contains **no business logic on purpose.** It asks the Receivify API and
renders what comes back — it never prices anything, never decides what counts as
confirmed, never derives an address.

A template with logic in it is a second copy of the bot, and second copies drift.
A field gets added, the hosted bot handles it, this one does not, and months
later you are debugging a bot that quietly stopped naming the network. Nobody
else would ever catch it, because nobody else runs your worker.

If you want to change what the bot *says*, edit the message strings. If you find
yourself wanting to add a *calculation*, that belongs in the API.

---

## Security notes

Three things this worker does that are easy to leave out, and expensive to:

- **Telegram's webhook is verified.** The URL is public, so without the
  `secret_token` check anyone could POST to it pretending to be Telegram.
- **Receivify's webhook signature is verified before anything is believed.**
  Without it, anyone could POST "payment received" and your own bot would tell a
  customer their money arrived when it never did.
- **Signatures older than five minutes are rejected.** Otherwise one captured
  signature is replayable forever, and a replayed `invoice.paid` tells a customer
  a second payment landed.

Your bot token lives only in Cloudflare's secret store. If you ever think it has
leaked, revoke it in BotFather with `/revoke` — that invalidates it immediately,
without involving us.

---

## Troubleshooting

**The bot does not answer.** Check `getWebhookInfo`; `last_error_message` usually
says exactly what is wrong:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

**It answers `/start` but not payment links.** The link must be
`?start=pay_<invoice_id>` — with the `pay_` prefix.

**Payments confirm but nobody is told.** The invoice needs
`metadata.telegram_chat_id`. Without it the worker has no one to message, and it
returns `ok` rather than guessing.

**`bad signature` in your worker logs.** `WEBHOOK_SECRET` does not match the one
in your Receivify dashboard, or a proxy in front of the worker is altering the
request body.
