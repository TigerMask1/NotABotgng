<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# NotABot — AI Discord Personality + Economy Game

Two bots, one server, full chaos. **NotABot** is a chronically-online AI personality that talks, jokes, plays games and chats like a real person. **BusinessBot** is the in-server economy game (Botcoin, wagers, forging, auctions) that NotABot also plays as a normal user.

---

## ⚙️ Setup

**Prerequisites:** Node.js 20+

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Description | Required |
|---|---|---|
| `DISCORD_TOKEN` | Bot token for **NotABot** (the AI personality bot) | ✅ Yes |
| `BUSINESS_BOT_TOKEN` | Bot token for **BusinessBot** (the economy game bot). Create a **separate** Discord Application for this. Without it, BusinessBot will show as **Offline**. | ✅ Yes (for economy) |
| `GEMINI_API_KEY` | Your Gemini API key (from [Google AI Studio](https://aistudio.google.com)) | ✅ Yes |
| `FIREBASE_PROJECT_ID` | Firebase project ID (for persistent memory & economy data) | ✅ Yes |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email | ✅ Yes |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key | ✅ Yes |
| `YT_CLIENT_ID` | YouTube OAuth2 client ID | ⚪ Optional |
| `YT_CLIENT_SECRET` | YouTube OAuth2 client secret | ⚪ Optional |
| `YT_REFRESH_TOKEN` | YouTube refresh token | ⚪ Optional |
| `DISCORD_CLIENT_ID` | Discord app client ID (for Web Dashboard OAuth2) | ⚪ Optional |
| `DISCORD_CLIENT_SECRET` | Discord app client secret (for Web Dashboard OAuth2) | ⚪ Optional |

> **Why two Discord bots?**
> NotABot and BusinessBot are two separate Discord Application tokens. You need to create both on the [Discord Developer Portal](https://discord.com/developers/applications), get their tokens, and add both to your server.

### 3. Run locally
```bash
npm run dev
```

Both bots will auto-start if their tokens are present in the environment.

---

## 📜 BusinessBot Commands

| Command | Description |
|---|---|
| `!daily` | Claim your daily Botcoin |
| `!profile` | View your balance, net worth, and inventory |
| `!wager @user <amount>` | Bet against someone (coinflip) |
| `!accept` | Accept an incoming wager |
| `!forge` | Spend 2000 Botcoin to forge a random item |
| `!auction <item> <start_bid>` | Put an item up for auction |
| `!bid <item> <amount>` | Bid on an active auction |
| `!bounty @user <amount>` | Put a bounty on someone |
| `!leaderboard` | See the richest users |
| `!challenge @user <amount> <terms>` | Create a 1v1 custom challenge |
| `!yield <id>` | Surrender a challenge you created |

---

## 🤖 NotABot Admin Commands

| Command | Description |
|---|---|
| `!help` | Show all available commands |
| `!pause <mins>` | Pause NotABot for N minutes |
| `!resume` | Resume NotABot |
| `!listenbot @Bot` | Allow NotABot to see messages from a specific bot |
| `!mutebot @Bot` | Stop NotABot from seeing a specific bot's messages |
| `!listenhere` | Restrict NotABot to the current channel only |
| `!listenall` | Let NotABot talk in all channels again |

---

## 🌐 Deployment

This app is designed to run as a hosted Express server. Hosted on [Google AI Studio](https://ai.studio/apps/849c428b-925e-4163-b2b5-8c04361fb670).

```bash
npm run build   # compile TypeScript
npm start       # run in production
```
