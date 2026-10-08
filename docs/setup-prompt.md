# Set up By Ear with Claude Code

Paste everything in the box below into [Claude Code](https://claude.com/claude-code), on the
computer where your Obsidian vault lives. It installs the plugin and the `/by-ear` song fetcher,
then shows you how to use them. It asks before it installs anything.

````text
Set up "By Ear" for me and teach me how to use it. By Ear is an Obsidian plugin for learning songs
by ear (loop, slow down, pitch-shift audio and video, progress saved in notes), plus a Claude Code
skill, /by-ear, that downloads a song from YouTube into the plugin's media folder. Source:
https://github.com/BasvanRzdl/obsidian-by-ear

Work through these steps in order. Ask me before installing anything, keep each message short,
and don't move on until a step has worked.

1. ASK ME
   - Which Obsidian vault to use (find candidates: on macOS read
     ~/Library/Application Support/obsidian/obsidian.json, on Windows %APPDATA%\obsidian\obsidian.json,
     and let me pick).
   - Where my songs should live. Suggest a folder OUTSIDE the vault (Obsidian Sync caps files at
     5 MB). On a Mac with iCloud Drive suggest
     ~/Library/Mobile Documents/com~apple~CloudDocs/Music/By Ear, because it then reaches my iPad
     and iPhone too. Otherwise suggest ~/Music/By Ear. Create the folder.
   - Whether I also want to use it on an iPad or iPhone.

2. INSTALL THE PLUGIN
   - Check whether "by-ear" is in
     https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json.
     If it is: tell me to install it via Settings > Community plugins > Browse > "By Ear".
   - If not: download main.js, manifest.json and styles.css from
     https://github.com/BasvanRzdl/obsidian-by-ear/releases/latest/download/<file>
     into <vault>/.obsidian/plugins/by-ear/.
   - Either way, write <vault>/.obsidian/plugins/by-ear/data.json as
     {"mediaFolder": "<the song folder, absolute path>", "noteFolder": "By Ear"}
     (merge with the file if it already exists).
   - Then tell me: in Obsidian, Settings > Community plugins, turn on community plugins if needed,
     refresh, and enable By Ear. Wait for me to confirm.

3. INSTALL THE DOWNLOAD TOOLS
   The fetcher needs yt-dlp, ffmpeg and deno (yt-dlp needs a JavaScript runtime for YouTube),
   and Python 3. Check what I already have first.
   - macOS: brew install yt-dlp ffmpeg deno (if Homebrew is missing, ask before installing it).
   - Windows: winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno Python.Python.3.12
   - Linux: my package manager, or pipx install yt-dlp.
   Tell me once, plainly, that downloading from YouTube is against YouTube's terms of service and
   that this is meant for personal practice material on my own machine. Then drop it.

4. INSTALL THE /by-ear SKILL
   - Download SKILL.md and byear_fetch.py from
     https://raw.githubusercontent.com/BasvanRzdl/obsidian-by-ear/main/skill/by-ear/<file>
     into ~/.claude/skills/by-ear/ .
   - Write ~/.config/by-ear/config.json as {"dest": "<the song folder>"}.
   - Ask me for a song I actually want to learn, then fetch it by following SKILL.md, as a test.
     Tell me /by-ear will be available in my next Claude Code session, from any folder.

5. SHOW ME HOW TO USE IT
   Walk me through it as a short tour, one part at a time, letting me try each in Obsidian:
   - Open: the headphones icon in the ribbon, or the command "By Ear: Open the player". Click the
     song name at the top to pick a song.
   - Loop: drag across the waveform for an A-B loop; L toggles it, A and B set the edges at the
     playhead, [ and ] nudge them by 10 ms. M drops a mark, S loops from mark to mark.
   - Slow down: the tempo slider, 25-150%, pitch stays the same; up/down arrows step 5%; the
     "⇄ 100%" button swaps between full speed and my working tempo.
   - Pitch: semitones and cents in the Tune tab; - and = step a semitone, shift for 10 cents.
     0 resets tempo and pitch.
   - Video: if the file is a video, the picture follows the slowed-down audio; F is full screen.
     On iPad and iPhone, pinch to zoom in on the hands.
   - Loop tab: call & response (C) plays the loop then leaves a gap to answer into; the channel
     mixer (left, right, mono, side) helps hear one part.
   - Volume: the speaker and slider at the top; V mutes.
   - Notes: findings, marks and loops are saved into the song's note in the vault (Cmd/Ctrl+S or
     Save). It only ever writes below a marker line at the bottom of a note.
   - Getting songs: "/by-ear Artist - Title" in Claude Code, or "/by-ear the live version of ...",
     or a YouTube link.
   - iPad/iPhone (if I said yes): install By Ear on the device too (the plugin folder syncs if I
     use Obsidian Sync with community plugins enabled, otherwise install it from Browse there).
     Songs come in through the song name > "Add songs…" > Files. They stay cached on the device.
     Downloading only works on a computer.

Ground rules: By Ear deliberately never detects chords, keys or BPM and keeps no streaks or
stats. Don't offer me chords or tabs unless I ask. If anything fails, show me the actual error and
fix it before going on. Finish with a five-line cheat sheet of the keys I'll use most.
````
