<p align="center">
  <a href="https://www.djdikkat.com"><img src=".github/readme/hero.png" alt="DJ DIKKAT, free music bot for Discord" width="100%"></a>
</p>

<p align="center">
  <a href="https://www.djdikkat.com/invite"><img src="https://img.shields.io/badge/Add_to_Discord-b5651d?style=for-the-badge&logo=discord&logoColor=white" alt="Add to Discord"></a>
  <a href="https://www.djdikkat.com"><img src="https://img.shields.io/badge/djdikkat.com-3b82c4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website"></a>
  <a href="https://www.djdikkat.com/vote"><img src="https://img.shields.io/badge/Vote_on_Top.gg-1c1a17?style=for-the-badge" alt="Vote on Top.gg"></a>
  <a href="https://www.djdikkat.com/patreon"><img src="https://img.shields.io/badge/Patreon-1c1a17?style=for-the-badge&logo=patreon&logoColor=white" alt="Patreon"></a>
  <a href="https://www.djdikkat.com/translate"><img src="https://img.shields.io/badge/Translate-1c1a17?style=for-the-badge&logo=googletranslate&logoColor=white" alt="Translate"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-26-3b82c4?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 26">
  <img src="https://img.shields.io/badge/TypeScript-strict-3b82c4?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/discord.js-14-3b82c4?style=flat-square&logo=discord&logoColor=white" alt="discord.js 14">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-5e5a54?style=flat-square" alt="MIT license"></a>
</p>

**DJ DIKKAT** is a free Discord music bot, made in memory of **DJ Dikkat (Mehmet Aykın)**, a rapper from Şanlıurfa. It plays YouTube, Spotify and SoundCloud, and comes with its own web panel, welcome cards and moderation tools.

No premium, no ads, no vote locks. Built by one person, free for everyone.

<br>

<img src=".github/readme/01-music.png" alt="01 Music" width="100%">

<p align="center"><img src=".github/readme/player-card.png" alt="The player card in Discord: artwork, title, progress bar and a row of icon buttons" width="90%"></p>

| | |
|:---:|---|
| 🎵 | **Every source.** Search by name with live suggestions, or paste a YouTube, Spotify or SoundCloud link: tracks, albums, playlists and Spotify artists. |
| 🎛️ | **One player card.** Artwork, a moving progress bar and one row of buttons. It reposts itself for every new song, so it never gets buried in chat. |
| 🔁 | **Loop and shuffle.** Loop one track or the whole queue, shuffle any time. |
| 📜 | **Queue of 25.** See what's next, reorder it, or jump straight to any song from the web panel. |
| 🔍 | **Smart search.** Finds the original, not the cover, remix or nightcore version, forgives typos and works without Turkish letters (`baris manco` finds *Barış Manço*). |
| 📊 | **History and stats.** Top tracks, top listeners and your server's busiest hours. |
| 🔌 | **Tidy.** Leaves when the channel empties or goes quiet for 5 minutes. |

<br>

<img src=".github/readme/02-panel.png" alt="02 Web panel" width="100%">

Type `/panel` in your server and you get a private login link. Everything below runs in your browser at [djdikkat.com](https://www.djdikkat.com).

| | |
|:---:|---|
| ▶️ | **Player.** Search, queue, skip and seek while you listen in Discord. Drag songs to reorder, click one to play it now. |
| 💾 | **Playlists and history.** Save songs and play them again with one click. |
| 📈 | **Stats.** Plays per day and per hour, top tracks and top listeners with their avatars. |
| 🛡️ | **Permissions.** DJ roles, music channels, and who can use each command where. |
| 🎨 | **Settings.** The bot's language and your server's own player card colour. |

Only people with **Manage Server** can change settings, and the bot checks that again on every action.

<br>

<img src=".github/readme/03-welcome.png" alt="03 Welcome and moderation" width="100%">

<p align="center"><img src=".github/readme/welcome-card.png" alt="A welcome card for a new member" width="80%"></p>

| | |
|:---:|---|
| 🖼️ | **Welcome cards.** A picture card, a text message or both, posted in a channel and/or sent as a DM. Your colour, your background. |
| 🚪 | **Leave messages** when someone leaves. |
| 🏷️ | **Auto-role** for new members, after membership screening. |
| 🔗 | **Link blocker and word filter**, built on Discord's own AutoMod, so they keep working even if the bot is offline. |

<br>

<img src=".github/readme/04-commands.png" alt="04 Commands" width="100%">

| Command | What it does |
|---|---|
| `/play` | Play a song: a name (with live suggestions) or a YouTube / Spotify / SoundCloud link |
| `/pause` | Pause or resume |
| `/skip` | Skip the current track |
| `/stop` | Stop the music and clear the queue. The bot stays in voice |
| `/disconnect` | Make the bot leave the voice channel |
| `/queue` | Show the queue, 10 songs per page |
| `/history` | The newest 200 plays of your server, sent to your DMs |
| `/stats` | Music stats for your server |
| `/language` | English or Türkçe for this server |
| `/panel` | A one-time link to your server's web panel |
| `/health` | The bot's health report, sent to your DMs |

**The player card's buttons:** pause / resume, skip, stop, loop (off, one track, the whole queue) and the queue, which opens your private queue view with shuffle, clear and a link to the web panel.

<br>

<img src=".github/readme/05-stack.png" alt="05 Under the hood" width="100%">

- **Node.js 26** runs the TypeScript directly (type stripping, no build step). Strict types, no framework.
- **discord.js 14** with Discord's newer message layout for the player and setup cards.
- **NodeLink** streams the audio, driven through **Shoukaku 4**. Spotify links resolve through the Spotify Web API.
- **MariaDB** keeps history, stats and server settings, with nightly backups.
- **@napi-rs/canvas** draws the player, welcome and launch cards in the website's style.
- **djdikkat.com** is PHP 8.2 behind nginx and Cloudflare, with a small ops daemon for the owner's admin panel.

<br>

<img src=".github/readme/06-translate.png" alt="06 Translate" width="100%">

DJ DIKKAT speaks English and Turkish. Want it in your language? No coding needed: you translate two files, an automatic check catches anything missing, and you're credited on [djdikkat.com/translate](https://www.djdikkat.com/translate).

👉 **[Request a language](https://github.com/Yanoee/DJDikkat_MusicBot/issues/new?template=language-request.yml)** · **[Read the guide](TRANSLATING.md)**

<br>

<img src=".github/readme/07-support.png" alt="07 Free forever" width="100%">

DJ DIKKAT is free and stays free. Every server bill comes out of one hobby developer's pocket. If the bot saves you from paying for another one, you can help keep it running:

- ❤️ Support on **[Patreon](https://www.djdikkat.com/patreon)**. Nothing is ever required.
- ⬆️ Vote on **[Top.gg](https://www.djdikkat.com/vote)** so more servers find it.
- 🐛 Found a bug? **[Open an issue](https://github.com/Yanoee/DJDikkat_MusicBot/issues)**.

### 🖤 Dedication

This project is dedicated to **DJ Dikkat (Mehmet Aykın)**. It is not official and not affiliated, just a small personal tribute built with respect.

### License

[MIT](LICENSE): do what you want, just don't claim it's yours. Made by [@Yanoee](https://github.com/Yanoee).
