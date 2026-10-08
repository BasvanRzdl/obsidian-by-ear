#!/usr/bin/env python3
"""
byear_fetch.py -- put a song from YouTube into your By Ear folder.

Keeps the video only when the picture is worth watching (hands on an instrument), and falls back
to an mp3 when it is a still album cover or a slideshow -- there is no point carrying 60 MB of a
JPEG that never moves.

    python3 byear_fetch.py --search "Artist - Title"      # list candidates, download nothing
    python3 byear_fetch.py <url> --name "Artist - Title"  # fetch one
    python3 byear_fetch.py --audit                        # check what is already in the folder

Where files go, first match wins: --dest, $BY_EAR_DIR, ~/.config/by-ear/config.json
({"dest": "..."}), then ~/Music/By Ear.

Needs yt-dlp, ffmpeg (with ffprobe) and a JavaScript runtime such as deno: since November 2025
yt-dlp needs one for full YouTube support.

Downloading from YouTube is against its terms of service. This is for personal practice
material on your own machine; that call is yours to make.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

CONFIG = Path.home() / ".config" / "by-ear" / "config.json"
FALLBACK_DEST = Path.home() / "Music" / "By Ear"

# Above this fraction of frozen picture, the video is a still or a slideshow. Real footage
# measures near 0%, stills and slideshows 78-100%, so there is plenty of daylight around 50%.
STATIC_ABOVE = 0.50

# Codec first, resolution second. H.264 is hardware-decoded on every Mac, iPad and iPhone; AV1 is
# not on older ones (an A12 iPad or an Intel Mac software-decodes it, and the picture goes soft
# while the stretcher competes for the CPU). H.264 tops out at 1080p on YouTube, which is plenty.
VIDEO_FORMAT = (
    "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/"
    "bv*[vcodec^=avc1]+ba/"
    "bv*[vcodec^=vp9][height<=1080]+ba/"
    "bv*[height<=1080]+ba/"
    "b[ext=mp4]/b"                     # progressive 360p, the last resort
)
MIN_HEIGHT = 480

# YouTube serves different formats to different player clients and refuses some of them. The
# mweb client can only offer 360p without a PO token, so it is asked last, not first.
CLIENTS = [None, "web_embedded", "tv_embedded", "mweb"]


def default_dest():
    if os.environ.get("BY_EAR_DIR"):
        return Path(os.environ["BY_EAR_DIR"]).expanduser()
    if CONFIG.exists():
        try:
            d = json.loads(CONFIG.read_text()).get("dest")
            if d:
                return Path(d).expanduser()
        except (OSError, ValueError):
            pass
    return FALLBACK_DEST


def need(tool):
    if shutil.which(tool) is None:
        sys.exit(f"{tool} not found. Install it first (macOS: brew install {tool}).")


def ytdlp(args, browser, client=None, capture=True):
    cmd = ["yt-dlp", "--no-playlist"]
    if browser:
        cmd += ["--cookies-from-browser", browser]
    if client:
        cmd += ["--extractor-args", f"youtube:player_client={client}"]
    cmd += args
    if capture:
        return subprocess.run(cmd, capture_output=True, text=True)
    return subprocess.run(cmd)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def search(query, browser, n=6):
    """Candidates only. Choosing between a studio version, a live cut and a lesson is a judgement."""
    r = ytdlp(["--flat-playlist", "--dump-single-json", f"ytsearch{n}:{query}"], browser)
    if r.returncode != 0:
        sys.exit(f"Search failed:\n{r.stderr.strip()[:500]}")
    for e in json.loads(r.stdout).get("entries", []):
        d = int(e.get("duration") or 0)
        print(json.dumps({
            "title": e.get("title"),
            "channel": e.get("channel") or e.get("uploader"),
            "length": f"{d // 60}:{d % 60:02d}",
            "views": e.get("view_count"),
            "url": e.get("url") if str(e.get("url", "")).startswith("http")
                   else f"https://www.youtube.com/watch?v={e.get('id')}",
        }, ensure_ascii=False))


def metadata(url, browser):
    r = ytdlp(["--dump-single-json", url], browser)
    if r.returncode != 0:
        err = r.stderr.strip()
        hint = ""
        if "Sign in to confirm" in err or "403" in err:
            hint = "\nYouTube wants a signed-in browser: retry with --browser chrome (or firefox)."
        sys.exit(f"yt-dlp could not read that URL:\n{err[:500]}{hint}")
    d = json.loads(r.stdout)
    return {
        "title": d.get("title", "untitled"),
        "uploader": d.get("uploader") or d.get("channel") or "",
        "duration": int(d.get("duration") or 0),
        "has_video": any(f.get("vcodec") not in (None, "none") for f in d.get("formats", [])),
    }


def safe_name(s):
    s = re.sub(r"[/\\:*?\"<>|]", "-", s)
    s = re.sub(r"\s+", " ", s).strip().strip(". ")
    return s[:120] or "untitled"


def frozen_fraction(path):
    """Fraction of the file where the picture does not change. None if unmeasurable."""
    dur = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", str(path)]).stdout.strip()
    try:
        total = float(dur)
    except ValueError:
        return None
    if total <= 0:
        return None
    r = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
             "-vf", "freezedetect=n=0.003:d=2", "-map", "0:v:0", "-f", "null", "-"])
    frozen = sum(float(m.group(1)) for m in re.finditer(r"freeze_duration:\s*([\d.]+)", r.stderr))
    return min(frozen / total, 1.0)


def fetch(url, dest, name, want_video, browser, strict=True):
    dest.mkdir(parents=True, exist_ok=True)
    out = str(dest / (name + ".%(ext)s"))
    # --force-overwrites is load-bearing: without it yt-dlp skips a file that already exists and
    # reports success, so re-fetching a bad copy silently keeps it.
    if want_video:
        args = ["-f", VIDEO_FORMAT, "--merge-output-format", "mp4", "--force-overwrites",
                "--embed-metadata", "-o", out, url]
    else:
        args = ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0",
                "--force-overwrites", "--embed-metadata", "--embed-thumbnail", "-o", out, url]

    for i, client in enumerate(CLIENTS):
        if i:
            print(f"  ...refused, retrying as {client}")
        if ytdlp(args, browser, client=client, capture=False).returncode == 0:
            break
    else:
        msg = ("\nEvery client was refused. Label-owned uploads do this, and so do bursts. Try "
               "again in a minute, add --browser chrome, or update: yt-dlp -U")
        if strict:
            sys.exit(msg)
        print(msg)
        return None

    hits = [p for p in dest.glob(name + ".*")
            if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mp3", ".m4a")]
    return sorted(hits)[0] if hits else None


def picture_spec(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", str(path)])
    bits = r.stdout.strip().split(",") if r.returncode == 0 else []
    if len(bits) < 3:
        return None
    try:
        return {"codec": bits[0], "width": int(bits[1]), "height": int(bits[2])}
    except ValueError:
        return None


def report_picture(path):
    spec = picture_spec(path)
    if not spec:
        return
    print(f"  picture   {spec['width']}x{spec['height']}  {spec['codec']}")
    if spec["height"] < MIN_HEIGHT:
        print(f"  !         only {spec['height']}p -- nothing better was offered. Worth re-running later.")
    if spec["codec"] in ("av01", "av1"):
        print("  !         AV1 -- older iPads and Intel Macs cannot hardware-decode it. Re-run for H.264.")


def embedded_url(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format_tags=comment",
             "-of", "default=nw=1:nk=1", str(path)])
    out = r.stdout.strip() if r.returncode == 0 else ""
    return out if out.startswith("http") else None


def audit(dest, refetch, browser):
    """What is actually in the folder -- because a bad download reports success too."""
    files = sorted(dest.glob("*.mp4"))
    if not files:
        print(f"No videos in {dest}")
        return
    bad = []
    print(f"{len(files)} video(s) in {dest}\n")
    for f in files:
        spec = picture_spec(f)
        if not spec:
            print(f"  ?     {f.stem} -- could not probe")
            continue
        why = []
        if spec["height"] < MIN_HEIGHT:
            why.append(f"{spec['height']}p")
        if spec["codec"] in ("av01", "av1"):
            why.append("AV1")
        print(f"  {'!' if why else 'ok'}    {f.stem}")
        print(f"        {spec['width']}x{spec['height']}  {spec['codec']}"
              + ("  <- " + ", ".join(why) if why else ""))
        if why:
            bad.append(f)
    if not bad:
        print("\nEverything is H.264 at a usable size.")
        return
    print(f"\n{len(bad)} of {len(files)} worth fetching again.")
    if not refetch:
        print("Re-run with --refetch to replace them in place.")
        return
    for f in bad:
        url = embedded_url(f)
        if not url:
            print(f"\n  skip  {f.stem} -- no source link in the file")
            continue
        print(f"\n  again {f.stem}\n        {url}")
        got = fetch(url, dest, f.stem + " (refetch)", True, browser, strict=False)
        if not got:
            print("        failed -- the original is untouched")
            continue
        f.unlink()
        got.rename(f)
        report_picture(f)


def to_mp3(src):
    dst = src.with_suffix(".mp3")
    r = run(["ffmpeg", "-hide_banner", "-y", "-i", str(src),
             "-vn", "-c:a", "libmp3lame", "-q:a", "0", str(dst)])
    return dst if r.returncode == 0 and dst.exists() else None


def mb(p):
    return p.stat().st_size / 1_048_576


def main():
    ap = argparse.ArgumentParser(description="Put a song from YouTube into your By Ear folder.")
    ap.add_argument("url", nargs="?", help="YouTube link")
    ap.add_argument("--search", metavar="QUERY", help="List candidates for 'Artist - Title'")
    ap.add_argument("--name", help='Filename, e.g. "Artist - Title"')
    ap.add_argument("--audio", action="store_true", help="Audio only, skip the picture check")
    ap.add_argument("--video", action="store_true", help="Keep the video, skip the picture check")
    ap.add_argument("--keep-both", action="store_true", help="Static picture: keep the mp4 too")
    ap.add_argument("--dest", help="Folder to save into (see the top of this file)")
    ap.add_argument("--browser", help="Read YouTube cookies from this browser (chrome, firefox...)")
    ap.add_argument("--audit", action="store_true", help="Check the videos already in the folder")
    ap.add_argument("--refetch", action="store_true", help="With --audit: re-download the bad ones")
    args = ap.parse_args()
    dest = Path(args.dest).expanduser() if args.dest else default_dest()

    if args.search:
        need("yt-dlp")
        search(args.search, args.browser)
        return 0
    if args.audit:
        need("ffprobe")
        audit(dest, args.refetch, args.browser)
        return 0
    if not args.url:
        ap.error("give a URL, or use --search / --audit")
    if args.audio and args.video:
        sys.exit("pick one of --audio / --video")
    need("yt-dlp")
    need("ffmpeg")

    meta = metadata(args.url, args.browser)
    name = safe_name(args.name or (
        f"{meta['uploader']} - {meta['title']}" if meta["uploader"] else meta["title"]))
    mins, secs = divmod(meta["duration"], 60)
    print(f"  title     {meta['title']}\n  uploader  {meta['uploader']}")
    print(f"  length    {mins}:{secs:02d}\n  filename  {name}\n")

    audio_only = args.audio or not meta["has_video"]
    got = fetch(args.url, dest, name, want_video=not audio_only, browser=args.browser)
    if got is None:
        sys.exit("download reported success but no file appeared")
    print()

    if audio_only or args.video:
        print(f"  kept      {got.name}  ({mb(got):.0f} MB) -- {'forced with --video' if args.video else 'audio only'}")
        report_picture(got)
        print(f"  -> {dest}")
        return 0

    frac = frozen_fraction(got)
    if frac is None or frac < STATIC_ABOVE:
        why = "could not measure the picture" if frac is None else "real footage, worth watching"
        print(f"  kept      {got.name}  ({mb(got):.0f} MB) -- {why}")
        report_picture(got)
        print(f"  -> {dest}")
        return 0

    print(f"  check     picture frozen {frac:.0%} of the time")
    mp3 = to_mp3(got)
    if mp3 is None:
        print(f"  !         could not extract audio -- keeping {got.name}")
        return 0
    kind = "a slideshow" if frac < 0.98 else "a still image"
    print(f"  kept      {mp3.name}  ({mb(mp3):.1f} MB) -- {kind}, picture discarded")
    if args.keep_both:
        print(f"  kept      {got.name}  ({mb(got):.1f} MB) -- --keep-both")
    else:
        got.unlink()
    print(f"  -> {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
