---
name: by-ear
description: Fetch a song from YouTube into the By Ear folder for the By Ear Obsidian plugin. Use when the user says /by-ear, names a song to learn ("get me Little Wing by Hendrix"), or pastes a YouTube link to practise from. Keeps the video when there are hands to watch, an mp3 when it is a still.
---

# /by-ear: get a song ready to learn

The user learns songs by ear with the **By Ear** Obsidian plugin. Its player reads media from one
folder on this computer. This skill puts a song in that folder.

Usage: `/by-ear Artist - Title`, or `/by-ear <youtube url>`, optionally with words like
*"the live version"*, *"a lesson"*, *"audio only"*.

The script is `byear_fetch.py`, next to this file. Run it with `python3` (on Windows: `python`).
It works out the destination folder itself (`~/.config/by-ear/config.json`, written at setup).

## Step 1: find the right upload (skip if given a URL)

```bash
python3 ~/.claude/skills/by-ear/byear_fetch.py --search "Artist - Title"
```

This prints up to six candidates as JSON lines and downloads nothing. **Pick one yourself**; only
ask the user to choose when it is genuinely ambiguous:

- Default: the original recording by the original artist, preferring the official channel.
- "live", "lesson", "cover", "playthrough", "isolated" in the request changes the pick to match.
  A lesson or a live film is worth more to a learner than a studio track: there are hands in it.
- Skip compilations, "1 hour" loops, slowed/reverb edits, and anything far longer than the song.

Say which one you chose in one line, with the channel and length.

## Step 2: fetch it

```bash
python3 ~/.claude/skills/by-ear/byear_fetch.py "<url>" --name "Artist - Title"
```

**Always pass `--name "Artist - Title"`.** YouTube titles make useless filenames, and the plugin's
song list sorts by name.

| Flag | When |
|---|---|
| `--audio` | the user wants sound only, **or the title says "Official Audio" / "Visualizer" / "Lyric video"**: those often animate a still photo with film grain, which the motion check reads as footage |
| `--video` | keep the picture no matter what the check says |
| `--keep-both` | still picture, but keep the mp4 anyway |
| `--browser chrome` | YouTube says "Sign in to confirm you're not a bot", or every client is refused |

The script downloads, measures how much of the picture actually moves, and throws the picture
away when it is a still or a slideshow (real footage measures about 0% frozen, stills 78 to 100%).

## Step 3: report

Two or three lines: what was kept, how big, why (footage or still), and that it is now in the
By Ear player's song list. **Don't paste the download progress.** If the script warned about
360p or AV1, say so and offer to try another upload.

On iPad or iPhone the file has to reach the device. If the folder is in iCloud Drive it is
already there: in the plugin, tap the song name, then **Add songs…**, and pick it from Files.

## Other jobs

- `--audit` checks every video already in the folder (codec and size); `--audit --refetch`
  re-downloads the bad ones in place.
- `yt-dlp -U` (or `brew upgrade yt-dlp`) fixes most sudden failures: YouTube changes often.

## Guardrails

- **Fetch, never analyse.** Do not offer chords, keys, tabs or BPM, and do not suggest
  chord-detection apps. The point of learning by ear is that the user finds them. If they
  explicitly ask for chords, that is a separate request: say where they came from and that they
  need checking against the recording.
- **Never write out lyrics.**
- Downloading from YouTube is against YouTube's terms of service. Mention it once, at setup;
  after that it is the user's call. Never upload or share the files.
- **No phone.** This runs on a computer only; there is no reliable way to run yt-dlp on iOS.
