# Translating DJ DIKKAT

Thanks for helping! DJ DIKKAT speaks English and Turkish today. With your help it can speak your language too, in Discord and on [djdikkat.com](https://www.djdikkat.com/translate). Every translator is credited on the site's [Translate page](https://www.djdikkat.com/translate).

You don't need to know how to code. You only change text in two files.

## The two files

| File | What it is | Size |
|---|---|---|
| [`translations/bot/en.json`](translations/bot/en.json) | Everything the bot says in Discord: replies, the player card, buttons, DMs | about 200 lines |
| [`translations/website/en.json`](translations/website/en.json) | The website and the web panel | about 580 lines |

Turkish (`tr.json` next to them) is a full example of a finished translation.

## Step by step

1. **Request the language.** Open a [language request](https://github.com/Yanoee/DJDikkat_MusicBot/issues/new?template=language-request.yml), or give a 👍 to the request that already exists. Say there that you'll translate it, so nobody does the same work twice.
2. **Fork this repo** (the Fork button at the top right of GitHub).
3. **Copy both `en.json` files** to your language code, in the same folders, for example `translations/bot/de.json` and `translations/website/de.json`. Use the two-letter code, and add the country only when it matters: `pt-BR`, `zh-TW`.
4. **Translate the text on the right of each line.** Never change the part on the left.
   ```json
   "skip.done": "⏭️ Skipped!",          ← English
   "skip.done": "⏭️ Übersprungen!",     ← German: only the right side changed
   ```
5. **Open a pull request.** A check runs straight away and lists anything missing or broken. Fix those, push again, and the check turns green.
6. **That's it.** Once it's merged, your language goes live in the bot and on the site, and you're added to the translators list.

You can send the bot file first and the website later. Partial pull requests are welcome.

## Keep these exactly as they are

- **Placeholders in curly brackets**: `{name}`, `{count}`, `{server}`. They're replaced with real values. Move them where your grammar needs them, but don't translate or remove them.
- **Formatting**: `**bold**`, `*italic*`, `` `code` ``, line breaks (`\n`), and emoji.
- **HTML in the website file**: `<strong>`, `<code>`, `<a …>`. Translate the text between the tags, keep the tags.
- **Slash commands**: `/play`, `/panel`, `/language`. Discord shows them in English.
- **Names**: DJ DIKKAT, Dakka Records, Discord, Spotify, YouTube, SoundCloud.

## Plurals

Some lines come in pairs that end in `_one` and `_other`:

```json
"card.tracks_one": "{count} track",
"card.tracks_other": "{count} tracks",
```

Fill in both. If your language uses the same word for both, write it twice.

## How it should sound

- Write the way a native speaker would say it, not word for word. If an English line sounds odd in your language, say the same thing your way.
- Keep it short and friendly. Many lines are buttons or small labels in Discord.
- Use the informal "you" if your language has one; Turkish uses *sen*, not *siz*.
- Not sure what a line means or where it shows up? Ask in your language request, or open an [issue](https://github.com/Yanoee/DJDikkat_MusicBot/issues).

## When the English text changes

New lines appear in `en.json` from time to time. The check then lists them as missing in every language. Anyone can add the translation in a small pull request.
