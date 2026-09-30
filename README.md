![Logo](https://images2.imgbox.com/6c/31/E8jm3ZKg_o.png)

[![License](https://img.shields.io/badge/License-MIT-yellow)](https://github.com/Yanoee/DJDikkat_MusicBot/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-green?logo=node.js)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue?logo=discord)](https://discord.js.org/)
[![NodeLink](https://img.shields.io/badge/NodeLink-Audio-purple)](https://github.com/PerformanC/NodeLink)
[![Shoukaku](https://img.shields.io/badge/Shoukaku-v4-orange)](https://github.com/Deivu/Shoukaku)
[![Website](https://img.shields.io/badge/Website-djdikkat.com-blue)](https://www.djdikkat.com)
[![Free Forever](https://img.shields.io/badge/Free-Forever-brightgreen)](https://www.djdikkat.com)

# 🎧 DJ DIKKAT - Free Discord Music Bot

A free, open source Discord music bot with Spotify and YouTube support.  
No ads. No premium. No BS. Built by one person, free for everyone.

---

[🌐 Website](https://www.djdikkat.com) • [📨 Invite Bot](https://discord.com/oauth2/authorize?client_id=1457783766771564688&permissions=36793408&integration_type=0&scope=bot+applications.commands) • [⭐ Vote on Top.gg](https://top.gg/bot/1457783766771564688) • [❤️ Support on Patreon](https://www.patreon.com/Yanoee) • [💻 Report a Bug](https://github.com/Yanoee/DJDikkat_MusicBot/issues)

---

## 🔧 Features

- **Multi-source playback** - Search by name, paste a YouTube, Spotify, or SoundCloud URL. Tracks, albums, and playlists all work. YouTube Music is tried first, YouTube second, SoundCloud as final fallback.
- **Smart search** - `/play` suggests the top matches while you type; pick one to play exactly that track. Plain-text searches trust YouTube Music's ranking, match whole words (Turkish letters optional: `baris manco donence` finds *Dönence*), and skip covers, remixes, live and nightcore versions unless you ask for them.
- **Clean links** - A video link opened from a Mix or playlist plays just that video. Mobile and `https://`-less links work, and a broken or unsupported link tells you why instead of playing something random.
- **Spotify support** - Resolves Spotify tracks, albums, and full playlists to YouTube via the Spotify Web API. No Spotify premium account needed on your end.
- **Interactive player card** - A persistent embed in your text channel with live controls. No need to type commands - everything is a button click.
- **3-state loop** - Cycles Off ~ Track ~ Queue ~ Off. Toggle any time with the loop button on the player card.
- **Queue shuffle** - Fisher-Yates shuffle applied instantly, reflected live in the card.
- **Play history** - Every play is kept in the database with timestamp and requester info. `/history` shows the newest 200, paginated and sent to your DM.
- **Stats tracking** - Per-guild stats: most-played songs, top users, daily and weekly breakdowns. All-time totals are kept forever; daily breakdowns older than 30 days are pruned automatically.
- **Auto-disconnect** - Bot leaves after 5 minutes of idle. No manual cleanup needed.
- **Idle player card** - When the queue empties, the card stays with a live countdown and a "Play Again" button for the last track.
- **Clean chat** - Player card is deleted and reposted fresh with each new song. Stale cards from previous sessions are cleaned up on startup.
- **Auto-leave on empty voice** - Bot disconnects immediately when the last human leaves the voice channel.
- **Voice channel status** - Updates the voice channel status to show the currently playing track.
- **Weekly announcements** - Sends an informational embed to each guild every 7 days (dismissible by admins).
- **Owner welcome DM** - When added to a new server, the owner gets a DM with a quick-start guide and required permissions list.
- **MariaDB storage** - History, stats, settings, and admin state live in MariaDB (schema in `djdikkat/schema.sql`, created automatically on startup). Every row is keyed by guild, so resetting one guild never touches another's data. Nightly gzipped backups via `updater/backup-db.sh`.

---

## 📟 Commands

| Command | Description |
|---|---|
| `/play <query>` | Search by name (with live suggestions) or paste a YouTube, Spotify, or SoundCloud URL. Tracks, albums, and playlists all work. Queue cap: 25 tracks. |
| `/pause` | Pause or resume the current track. |
| `/skip` | Skip the current track immediately. |
| `/stop` | Stop playback and clear the queue. Bot stays in voice. |
| `/queue` | Show the current queue with requester info. Paginated, 10 tracks per page. You need to be in the bot's voice channel. |
| `/history` | View the newest 200 plays for this server. Paginated, sent via DM. |
| `/stats` | Show music stats - top songs, top users, today's top, and weekly top. Auto-deletes after 3 minutes if nothing is playing. |
| `/disconnect` | Stop everything and disconnect the bot from voice. |
| `/health` | *(Admin only)* Full health report sent via DM - Discord ping, RAM, CPU, NodeLink stats, uptime, and last update info. |

> Commands have a 5-second per-server cooldown (adjustable in the admin panel).

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
| 🔁 / 🔂 | Cycle loop mode (Off ~ Track ~ Queue ~ Off) |
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

- **Debian 12 (Bookworm)** - production server environment
- **Node.js ≥ 24** - runtime, runs the TypeScript directly (type stripping, no build step)
- **Discord.js v14** - Discord API wrapper
- **Shoukaku v4** - NodeLink/Lavalink client for Node.js
- **NodeLink** - audio streaming backend
- **Spotify Web API** - track metadata and resolution for Spotify links
- **MariaDB 10.11** + **mysql2** - persistent storage
- **TypeScript** - strict, type-checked with `npm run typecheck`; no framework, no bloat

### 🗄 Database setup (self-hosting)

Since v5.0.0 the bot stores its data in MariaDB instead of JSON files.

```sql
CREATE DATABASE djdikkat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'djdikkat'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON djdikkat.* TO 'djdikkat'@'localhost';
```

Add to `djdikkat/.env`: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Tables are created on first start.
Then `npm install` and `npm start` (reads `djdikkat/.env`). `npm run typecheck` runs the TypeScript compiler without emitting anything; `npm test` runs the search engine checks.

---

## 🖤 Dedication

This project is dedicated to **DJ Dikkat (Mehmet Aykın)**.  
It is not official, not affiliated, and not monetized, just a small personal tribute built with respect.

---

## ❤️ Support the Project

DJ DIKKAT is free forever. If it saved you from paying for another bot, consider supporting on Patreon.

~ [patreon.com/Yanoee](https://www.patreon.com/Yanoee)

Every patron helps keep the server running. Nothing is ever required.

---

## 📜 License

[MIT](LICENSE) - do what you want, just don't claim it's yours.

### Author
- [@Yanoee](https://www.github.com/Yanoee)
