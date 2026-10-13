"use client";

/**
 * A page-wide freeze/resume switch for whatever speech Guru is playing right now.
 *
 * Speaking is driven beat-by-beat: `playBlob` (Sarvam audio) and `speakBrowser`
 * (speechSynthesis) each register a handle for the one utterance they own, then
 * unregister when it ends. Pausing freezes the current utterance in place so a
 * resume carries on from the same spot — the awaited playback promise simply
 * never resolves while paused, which stalls the whole turn (the beat queue waits
 * on it) until the voice is let go again.
 *
 * The `paused` flag outlives any single handle: if a pause lands in the gap
 * before the next beat's audio starts, that beat registers into a paused world
 * and is frozen immediately, so the pause holds across beat boundaries.
 */

type PlaybackHandle = {
  pause: () => void;
  resume: () => void;
};

let current: PlaybackHandle | null = null;
let paused = false;

/**
 * Register the utterance now playing. Returns an unregister function the caller
 * runs when the utterance ends. If a pause is already in effect, the freshly
 * registered utterance is frozen at once.
 */
export function registerPlayback(handle: PlaybackHandle): () => void {
  current = handle;
  if (paused) handle.pause();
  return () => {
    if (current === handle) current = null;
  };
}

/** Freeze the current utterance (and any that starts before the next resume). */
export function pausePlayback(): void {
  if (paused) return;
  paused = true;
  current?.pause();
}

/** Let the current utterance carry on from where it was frozen. */
export function resumePlayback(): void {
  if (!paused) return;
  paused = false;
  current?.resume();
}

/** True while speech is frozen — polled by caption pacers so they stop too. */
export function isPlaybackPaused(): boolean {
  return paused;
}
