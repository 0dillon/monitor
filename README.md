# Opportunity Tracker Bot (WhatsApp)

[![CI](https://github.com/0dillon/monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/0dillon/monitor/actions/workflows/ci.yml)

Forward an opportunity (link, post, screenshot, flyer or PDF) to the bot's WhatsApp number. The bot:

- researches it on the web (official page, deadline, eligibility, requirements, benefits) and saves it
- tracks your progress from plain messages: "started #2", "submitted the Chevening one", "skip #5"
- answers questions: "what's due this week?", "what haven't I started?"
- reminds you for the last 3 days before each deadline: a digest at 09:00 and 19:00, then pings 6 hours and 1 hour before closing, for anything not yet submitted
- sends a full overview every Monday morning

Shortcuts: `/list`, `/soon`, `/help`.

## How it connects

It uses [Baileys](https://github.com/WhiskeySockets/Baileys) to link to WhatsApp as a **linked device**, the same way WhatsApp Web does. There are two ways to set it up:

**Recommended: a second number for the bot.** Put WhatsApp (or WhatsApp Business) on a spare number, such as an old SIM or the second slot of a dual-SIM phone, and link the bot to it. Set `PAIRING_NUMBER` to the bot's number and `OWNER_NUMBER` to your own. Save the bot as a contact and chat with it like anyone else. Reminders arrive as normal messages, so your phone buzzes, and the bot ignores messages from anyone except `OWNER_NUMBER`.

**No spare number: your own self-chat.** Leave `OWNER_NUMBER` empty and link the bot to your own WhatsApp. It only reads your "Message yourself" chat and ignores every other chat. The catch is that WhatsApp usually doesn't notify you about messages "from yourself", so reminders arrive silently.

> 📱 The phone that holds the bot's number must open WhatsApp at least every ~14 days, or WhatsApp unlinks the bot.

> ⚠️ Baileys is unofficial. For personal, low-volume use like this the risk is small, but WhatsApp could in theory restrict the linked session.

## Run locally

Requires Node 22.13+ and an [Anthropic API key](https://platform.claude.com).

```bash
cp .env.example .env    # fill in ANTHROPIC_API_KEY, TIMEZONE, PAIRING_NUMBER, OWNER_NUMBER
npm install
npm run dev
```

The console prints a pairing code. On the phone with the bot's number, go to **WhatsApp > Linked devices > Link a device > Link with phone number instead** and enter it. If `PAIRING_NUMBER` is empty, it prints a QR code to scan instead. The session is saved in `data/`, so you only link once.

Then send `/help` to the bot from your own WhatsApp (or to your "Message yourself" chat in self-chat mode).

## Deploy (Railway)

The bot must run 24/7 to send reminders, and it needs **persistent storage** for the WhatsApp session and database.

1. Push this folder to a GitHub repo.
2. On [Railway](https://railway.app): **New Project > Deploy from GitHub repo**. It builds using the `Dockerfile`.
3. Add a **Volume** to the service mounted at `/data`.
4. Under **Variables**, set `ANTHROPIC_API_KEY`, `TIMEZONE` and `PAIRING_NUMBER` (and `OWNER_NUMBER` if you're using a second number).
5. Open **Deploy Logs**, find the pairing code and enter it on your phone. Codes expire after about a minute. If you miss it, restart the service.

Any host with Docker and a persistent disk works too, for example a $4–6/month VPS:

```bash
docker build -t opp-bot .
docker run -d --name opp-bot --restart unless-stopped --env-file .env -v opp-bot-data:/data opp-bot
docker logs -f opp-bot
```

Avoid free tiers that sleep (e.g. Render free), because reminders won't fire while the bot is asleep.

## Troubleshooting

- **Pairing code expired or didn't work.** Codes only last about a minute. Restart the bot (or the Railway service) to get a fresh one, and make sure `PAIRING_NUMBER` is the number of the phone you're entering it on, with country code and no `+` or leading `0`.
- **Logs say "Logged out from WhatsApp".** The bot was unlinked, either from the phone or because the phone was offline for too long. It clears the old session and exits, so restart it to get a new pairing code.
- **The bot doesn't reply.** Check that `OWNER_NUMBER` is the number you're messaging from, in the same format. In self-chat mode, make sure you're writing in "Message yourself", not another chat.
- **❌ reaction and "Something went wrong".** The logs show the real error. The usual causes are a missing or wrong `ANTHROPIC_API_KEY`, or no credit on the Anthropic account.
- **Reminders at the wrong time.** Set `TIMEZONE` to your IANA zone, e.g. `Africa/Lagos`. The default is UTC.
- **Everything is gone after a redeploy.** The `/data` volume isn't attached. Without it, the session and database are wiped on every deploy.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `TIMEZONE` | `UTC` | IANA name, e.g. `Africa/Lagos`, `Europe/London` |
| `PAIRING_NUMBER` | — | Your number, digits only with country code. Empty = QR code |
| `OWNER_NUMBER` | — | Set only when the bot runs on a second number |
| `DIGEST_TIMES` | `09:00,19:00` | Daily "closing soon" digest times |
| `REMINDER_DAYS` | `3` | Days before a deadline that reminders start |
| `MODEL` | `claude-opus-5-5` | Claude model |

## Code map

- `src/whatsapp.ts`: WhatsApp connection, pairing, and reading text, images and PDFs
- `src/agent.ts`: Claude with web search/fetch plus tracker tools (save, update, list, delete)
- `src/reminders.ts`: digests, urgent pings, weekly overview
- `src/db.ts`: SQLite storage (built into Node, so no native modules)
