![Logo](https://images2.imgbox.com/6c/31/E8jm3ZKg_o.png)

[![License](https://img.shields.io/badge/License-MIT-yellow)](https://github.com/Yanoee/DJDikkat_MusicBot/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-green?logo=node.js)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue?logo=discord)](https://discord.js.org/)
[![Lavalink](https://img.shields.io/badge/Lavalink-Audio-purple)](https://github.com/lavalink-devs/Lavalink)
[![Shoukaku](https://img.shields.io/badge/Shoukaku-v4-orange)](https://github.com/Deivu/Shoukaku)
[![Website](https://img.shields.io/badge/Website-djdikkat.com-blue)](https://www.djdikkat.com)
[![Free Forever](https://img.shields.io/badge/Free-Forever-brightgreen)](https://www.djdikkat.com)

# 🎧 DJ DIKKAT — Free Discord Music Bot

A free, open source Discord music bot with Spotify and YouTube support.  
No ads. No premium. No BS. Built by one person, free for everyone.

---

[🌐 Website](https://www.djdikkat.com) • [📨 Invite Bot](https://discord.com/oauth2/authorize?client_id=1457783766771564688&permissions=36793408&integration_type=0&scope=bot+applications.commands) • [⭐ Vote on Top.gg](https://top.gg/bot/1457783766771564688) • [❤️ Support on Patreon](https://www.patreon.com/Yanoee) • [💻 Report a Bug](https://github.com/Yanoee/DJDikkat_MusicBot/issues)

---

## 🔧 Features

- **Multi-source playback** — Search by name, paste a YouTube, Spotify, or SoundCloud URL. Tracks, albums, and playlists all work. YouTube Music is tried first, YouTube second, SoundCloud as final fallback.
- **Spotify support** — Resolves Spotify tracks, albums, and full playlists to YouTube via the Spotify Web API. No Spotify premium account needed on your end.
- **Interactive player card** — A persistent embed in your text channel with live controls. No need to type commands — everything is a button click.
- **3-state loop** — Cycles Off → Track → Queue → Off. Toggle any time from the player card or `/play`.
- **Queue shuffle** — Fisher-Yates shuffle applied instantly, reflected live in the card.
- **Play history** — Per-guild log of up to 200 tracks with timestamps and requester info. Paginated and sent to your DM via `/history`.
- **Stats tracking** — Per-guild stats: most-played songs, top users, daily and weekly breakdowns. Data older than 30 days is pruned automatically.
- **Auto-disconnect** — Bot leaves after 5 minutes of idle. No manual cleanup needed.
- **Idle player card** — When the queue empties, the card stays with a live countdown and a "Play Again" button for the last track.
- **Clean chat** — Player card is deleted and reposted fresh with each new song. Stale cards from previous sessions are cleaned up on startup.
- **Auto-leave on empty voice** — Bot disconnects immediately when the last human leaves the voice channel.
- **Voice channel status** — Updates the voice channel status to show the currently playing track.
- **Weekly announcements** — Sends an informational embed to each guild every 7 days (dismissible by admins).
- **Owner welcome DM** — When added to a new server, the owner gets a DM with a quick-start guide and required permissions list.
- **Per-guild data isolation** — History, stats, and settings live in separate JSON files per guild. One guild can never touch another's data.

---

## 📟 Commands

| Command | Description |
|---|---|
| `/play <query>` | Search by name or paste a YouTube, Spotify, or SoundCloud URL. Tracks, albums, and playlists all work. Queue cap: 5 tracks. |
| `/pause` | Pause or resume the current track. |
| `/skip` | Skip the current track immediately. |
| `/stop` | Stop playback and clear the queue. Bot stays in voice. |
| `/queue` | Show the current queue with requester info. Paginated, 10 tracks per page. |
| `/history` | View recently played tracks for this server. Paginated, sent via DM. |
| `/stats` | Show music stats — top songs, top users, today's top, and weekly top. Auto-deletes after 3 minutes if nothing is playing. |
| `/disconnect` | Stop everything and disconnect the bot from voice. |
| `/health` | *(Admin only)* Full health report sent via DM — Discord ping, RAM, CPU, Lavalink node stats, uptime, yt-cipher status, and last update info. |

### Player Card Buttons

When music is playing, a rich embed appears in your text channel:

**Row 1**

| Button | Action |
|---|---|
| ⏸ / ▶️ | Pause / Resume |
| ⏭️ | Skip to next track |
| ⏹️ | Stop playback |

**Row 2**

| Button | Action |
|---|---|
| 🔁 / 🔂 | Cycle loop mode (Off → Track → Queue → Off) |
| 🔀 | Shuffle the queue |
| 📜 | View the queue |
| 🧹 | Clear the queue |

**When idle (queue empty)**

| Button | Action |
|---|---|
| ⏮️ Play Again | Re-queue the last played track |
| 🔌 | Disconnect the bot |

> Buttons have a 5-second per-user cooldown to prevent spam.

---

## 🛠 Tech Stack

- **Debian 12 (Bookworm)** — production server environment
- **Node.js ≥ 18** — runtime
- **Discord.js v14** — Discord API wrapper
- **Shoukaku v4** — Lavalink client for Node.js
- **Lavalink** — audio streaming backend
- **Spotify Web API** — track metadata and resolution for Spotify links
- **dotenv** — environment variable management
- **Plain JavaScript** — no framework, no bloat

---

## 🚀 Self-Hosting

### Requirements

- Node.js ≥ 18
- A running [Lavalink](https://github.com/lavalink-devs/Lavalink) server
- A Discord bot token from the [Developer Portal](https://discord.com/developers/applications)
- *(Optional)* Spotify API credentials for Spotify link support — get them at [developer.spotify.com](https://developer.spotify.com/dashboard)

### Steps

**1. Clone the repo**
```bash
git clone https://github.com/Yanoee/DJDikkat_MusicBot.git
cd DJDikkat_MusicBot
```

**2. Install dependencies**
```bash
npm install
```

**3. Configure environment**
```bash
cp .env.example djdikkat/.env
```
Open `djdikkat/.env` and fill in your values. The bot looks for `.env` inside the `djdikkat/` folder.

**4. Set up Lavalink**

Download and run a [Lavalink server](https://github.com/lavalink-devs/Lavalink/releases). Point `LAVALINK_HOST`, `LAVALINK_PORT`, and `LAVALINK_PASSWORD` in your `.env` at it.

**5. Deploy slash commands (first run only)**

Set `DEPLOY_COMMANDS=true` in your `.env` before the first launch. You can remove or set it to `false` after commands are registered.

**6. Start the bot**
```bash
npm start
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Your Discord bot token |
| `LAVALINK_HOST` | ✅ | — | Lavalink server hostname (e.g. `localhost` or an IP) |
| `LAVALINK_PORT` | ✅ | — | Lavalink server port (e.g. `2333`) |
| `LAVALINK_PASSWORD` | ✅ | — | Lavalink server password |
| `LAVALINK_SECURE` | No | `false` | Set to `true` to use WSS/HTTPS for Lavalink |
| `SPOTIFY_CLIENT_ID` | No | — | Spotify app client ID — enables Spotify link support |
| `SPOTIFY_CLIENT_SECRET` | No | — | Spotify app client secret — enables Spotify link support |
| `BOT_INTERNAL_PORT` | No | `3001` | Port for the internal localhost HTTP API |
| `DEPLOY_COMMANDS` | No | `false` | Set to `true` to (re)deploy slash commands on startup |

### Required Bot Permissions

Make sure the bot has these permissions in your music channel:

`Connect` · `Speak` · `Send Messages` · `Embed Links` · `Read Message History`

---

## 🖤 Dedication

This project is dedicated to **DJ Dikkat (Mehmet Aykın)**.  
It is not official, not affiliated, and not monetized, just a small personal tribute built with respect.

---

## ❤️ Support the Project

DJ DIKKAT is free forever. If it saved you from paying for another bot, consider supporting on Patreon.

→ [patreon.com/Yanoee](https://www.patreon.com/Yanoee)

Every patron helps keep the server running. Nothing is ever required.

---

## 📜 License

[MIT](LICENSE) — do what you want, just don't claim it's yours.

### Author
- [@Yanoee](https://www.github.com/Yanoee)
