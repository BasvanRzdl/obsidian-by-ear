declare module "signalsmith-stretch" {
  /** A scheduled change. All fields optional; see the Signalsmith Stretch web README. */
  export interface StretchSchedule {
    /** AudioContext time at which this change takes effect. */
    output?: number;
    /**
     * When the library prunes and re-anchors its time map, defaulting to the *worklet's* own
     * clock rather than the AudioContext's. Undocumented in the README but read by `schedule()`,
     * and the two clocks are not the same one — which is worth having a name for when a
     * re-schedule behaves differently on mobile.
     */
    outputTime?: number;
    /** Whether the node is processing audio. */
    active?: boolean;
    /** Position in the input buffer, in seconds. */
    input?: number;
    /** Playback rate, e.g. 0.5 == half speed. */
    rate?: number;
    /** Pitch shift in semitones. Fractional values are allowed, so cents = semitones / 100. */
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    /** Auto-loop region, in seconds. Disabled when both are equal. */
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioNode {
    /** Current position within the input buffer, in seconds. */
    readonly inputTime: number;
    setUpdateInterval(seconds: number, callback?: (time: number) => void): void;
    schedule(change: StretchSchedule): void;
    start(when?: number): void;
    stop(when?: number): void;
    /** Append buffers, one typed array per channel. Resolves to the new buffer end time. */
    addBuffers(buffers: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    /** Every remote method is proxied over the worklet port, so this is async like the rest. */
    latency(): Promise<number>;
    configure(options: {
      blockMs?: number | null;
      intervalMs?: number;
      splitComputation?: boolean;
      preset?: "default" | "cheaper";
    }): void;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions
  ): Promise<StretchNode>;
}
