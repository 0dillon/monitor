# Opportunity Tracker Bot (WhatsApp)

Forward an opportunity (link, post, screenshot, flyer or PDF) to your WhatsApp "Message yourself" chat. The bot:

- researches it on the web (official page, deadline, eligibility, requirements, benefits) and saves it
- tracks your progress from plain messages: "started #2", "submitted the Chevening one", "skip #5"
- answers questions: "what's due this week?", "what haven't I started?"
- reminds you for the last 3 days before each deadline: a digest at 09:00 and 19:00, then pings 6 hours and 1 hour before closing, for anything not yet submitted
- sends a full overview every Monday morning

Shortcuts: `/list`, `/soon`, `/help`.

## How it connects

It uses [Baileys](https://github.com/WhiskeySockets/Baileys) to link to WhatsApp as a **linked device**, the same way WhatsApp Web does. No extra number is needed: it listens only to your self-chat and ignores every other chat.

> ⚠️ Baileys is unofficial. For personal, low-volume use like this the risk is small, but WhatsApp could in theory restrict the linked session.

> 🔕 **Reminders in self-chat may not buzz your phone.** WhatsApp usually doesn't notify you about messages "from yourself". If you want proper notifications, link the bot to a second number (an old SIM, a family member's spare line, or a WhatsApp Business number on a dual-SIM phone). Then set `OWNER_NUMBER` to your own number and chat with the bot like any contact.

## Run locally

Requires Node 22.13+ and an [Anthropic API key](https://platform.claude.com).

```bash
cp .env.example .env    # fill in ANTHROPIC_API_KEY, TIMEZONE, PAIRING_NUMBER
npm install
npm run dev
```

The console prints a pairing code. On your phone go to **WhatsApp > Linked devices > Link a device > Link with phone number instead** and enter it. If `PAIRING_NUMBER` is empty, it prints a QR code to scan instead. The session is saved in `data/`, so you only link once.

Then open your "Message yourself" chat and send `/help`.

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
