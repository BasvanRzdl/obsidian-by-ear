/**
 * The picture, slaved to the audio clock.
 *
 * ⚠️ Why this phase exists at all: watching hands is the reason the plugin was built. Transcribe!
 * already shows video on the Mac, and there is no free video-capable player on iPad or iPhone --
 * so until this works on mobile, the project has not closed the gap it was started to close.
 *
 * **The video never keeps time.** It is a display, not a clock. The engine's stretched, pitch-shifted
 * output is the only timeline that means anything, so every frame this asks the engine where the
 * music is and drags the picture there if it has wandered. Phase 1 deliberately derives the playhead
 * from the segment that was scheduled rather than from worklet messages -- no message latency, no
 * 100 ms quantisation -- and that decision was taken *for* this file: a clock that is not guessing
 * is a clock the picture cannot drift from.
 *
 * ⚠️ Correcting on every frame would be worse than not correcting at all. Assigning `currentTime`
 * makes the decoder seek, and a seek every 16 ms is a stutter, on iOS especially. So the picture is
 * left alone inside a tolerance and only pulled back when it has genuinely slipped -- and the
 * tolerance is deliberately wider than a frame, because being a frame out is invisible and seeking
 * to fix it is not.
 */

/** Wider than one frame at 30fps and far narrower than anything an eye tracks against sound. */
export const DRIFT_TOLERANCE = 0.12;
/** Below this, a correction is more disruptive than the error it fixes. */
export const SEEK_DEADBAND = 0.04;

/**
 * Whether the picture has slipped far enough to be worth a seek.
 *
 * Pulled out as a pure function so the judgement can be tested without a browser: this is the one
 * decision in the file that is a trade-off rather than plumbing, and getting it wrong in either
 * direction is bad in a way that is hard to see -- too tight and the video stutters constantly, too
 * loose and the hands are visibly behind the sound.
 */
export function needsSeek(drift: number, playing: boolean): boolean {
	return Math.abs(drift) > (playing ? DRIFT_TOLERANCE : SEEK_DEADBAND);
}

export class VideoScreen {
	private el: HTMLVideoElement;
	private url: string | null = null;
	private ready = false;

	constructor(private host: HTMLElement) {
		this.el = host.createEl("video", { cls: "by-ear-video" });
		this.el.muted = true; // The sound comes from the worklet. Always.
		this.el.playsInline = true;
		this.el.preload = "auto";
		this.el.controls = false;
		// Belt and braces: a muted video is still an audio source as far as iOS is concerned, and a
		// second opinion about the audio session is the last thing this needs.
		this.el.volume = 0;
		this.hide();
	}

	get element(): HTMLVideoElement {
		return this.el;
	}

	/**
	 * Points the picture at a blob of the original file.
	 *
	 * Takes a Blob rather than bytes on purpose: on iOS the cache already holds one, so nothing is
	 * copied, and the browser is free to keep it on disk rather than in memory -- which matters on a
	 * phone holding a decoded song in the worklet at the same time.
	 */
	async load(blob: Blob): Promise<LoadResult> {
		this.unload();
		this.url = URL.createObjectURL(blob);
		/*
		 * ⚠️ The URL goes on a `<source>` element, not on `src`.
		 *
		 * Two reasons, both WebKit. It is the documented workaround for blob URLs that stopped
		 * loading in video elements from iOS 17.4.1, and it is the only place a `type` can be
		 * *declared* rather than inferred -- a blob URL has no file name, so `src` leaves WebKit
		 * guessing from a Blob type it may not consult.
		 */
		const source = this.el.createEl("source");
		source.src = this.url;
		if (blob.type) source.type = blob.type;
		this.host.addClass("has-video");
		this.el.removeClass("is-hidden");

		/*
		 * ⚠️ Resolves on success, on failure, *and* on a timeout.
		 *
		 * The audio has already decoded by the time this runs, so the song is playable whatever
		 * happens here. A codec the browser will not touch usually fires `error` -- but "usually" is
		 * not good enough when the alternative is `openSong` awaiting a promise that never settles
		 * and the player sitting on "Reading…" for ever. The sound is what matters; the picture is
		 * allowed to fail, and is not allowed to hang.
		 */
		this.el.load(); // A <source> added after the fact is only picked up on an explicit load().

		/*
		 * ⚠️ Reports *why*, not just whether.
		 *
		 * v0.5.1 said "sound only" and nothing else, which was enough to know it had failed and
		 * useless for knowing what to change -- so the next fix was another guess. The four
		 * MediaError codes distinguish the possibilities that need different answers: a rejected
		 * source (4) is a type or container problem, a network error (2) points at the blob URL
		 * itself and WebKit's range-request handling, a decode error (3) is a codec, and a timeout
		 * means it stalled without ever deciding.
		 */
		const outcome = await new Promise<LoadResult>((resolve) => {
			const settle = (result: LoadResult) => {
				window.clearTimeout(timer);
				this.el.removeEventListener("loadeddata", onData);
				this.el.removeEventListener("error", onError);
				resolve(result);
			};
			const onData = () => settle({ ok: true });
			const onError = () => settle({ ok: false, why: describe(this.el.error), blob });
			const timer = window.setTimeout(
				() => settle({ ok: false, why: "timed out with no error reported", blob }),
				10000
			);
			this.el.addEventListener("loadeddata", onData);
			this.el.addEventListener("error", onError);
		});

		if (!outcome.ok) {
			this.unload();
			return outcome;
		}
		this.ready = true;
		return outcome;
	}

	unload(): void {
		this.ready = false;
		this.el.querySelectorAll("source").forEach((s) => s.remove());
		this.el.removeAttribute("src");
		this.el.load();
		if (this.url) URL.revokeObjectURL(this.url);
		this.url = null;
		this.hide();
	}

	private hide(): void {
		this.host.removeClass("has-video");
		this.el.addClass("is-hidden");
	}

	get hasPicture(): boolean {
		return this.ready;
	}

	/**
	 * One frame of following. `at` is where the engine says the music is.
	 *
	 * `playbackRate` carries the tempo so the picture runs at the right speed between corrections;
	 * without it the video would race ahead at 75% tempo and be dragged back constantly, which is
	 * exactly the stutter the tolerance exists to avoid.
	 */
	follow(at: number, playing: boolean, rate: number): void {
		if (!this.ready) return;

		if (Math.abs(this.el.playbackRate - rate) > 0.001) {
			// Browsers clamp this; asking for something silly throws in some engines.
			try {
				this.el.playbackRate = rate;
			} catch {
				/* out of range: the tolerance below will carry it */
			}
		}

		if (needsSeek(at - this.el.currentTime, playing)) this.el.currentTime = at;

		if (playing && this.el.paused) {
			void this.el.play().catch(() => undefined);
		} else if (!playing && !this.el.paused) {
			this.el.pause();
		}
	}

	destroy(): void {
		this.unload();
		this.el.remove();
	}
}

export type LoadResult = { ok: true } | { ok: false; why: string; blob: Blob };

/** Turns a MediaError into something that names the next thing to try. */
function describe(error: MediaError | null): string {
	if (!error) return "failed with no error attached";
	switch (error.code) {
		case 1:
			return "aborted";
		case 2:
			return "network error reading the blob (WebKit range-request handling)";
		case 3:
			return "decode error — the container opened but the video track would not decode";
		case 4:
			return "source not supported — wrong or missing type, or a codec WebKit will not take";
		default:
			return `error code ${error.code}`;
	}
}
