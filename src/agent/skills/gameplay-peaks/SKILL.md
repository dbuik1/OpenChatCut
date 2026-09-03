---
name: gameplay-peaks
description: Find highlight candidates in gaming and stream VODs from audio energy rather than transcript content, then cross-reference them with the transcript and scene cuts before proposing markers or clips. Use when the user asks for highlights, clutch moments, peaks, funny bits, or a rough cut of gameplay footage with their own commentary, and whenever find_highlights returns nothing useful because the strongest moments are not talking-head speech.
---

# Gameplay Peaks

Find candidate highlights in a gameplay or stream recording by measuring the audio, not by reading it.

`find_highlights` selects on transcript content and its selection prompt asks for talking-head moments, so a clutch play carried by a shout, a game cue and a burst of laughter is invisible to it. This workflow starts from the loudness envelope instead: `scripts/peaks.mjs` ranks sustained excursions above a rolling baseline, and the agent then decides which of those excursions are actually moments by checking them against the transcript and the visual scene cuts.

Audio energy is a candidate generator, never a verdict. A sneeze is loud. Always confirm a peak with a second signal before proposing it, and always propose — this workflow does not apply edits on its own.

## Required References

Load only what the current step needs:

- Read [references/cross-referencing.md](references/cross-referencing.md) before ranking peaks or building clip ranges.
- Read [references/running-the-script.md](references/running-the-script.md) before the first `run_skill_script` call, when ffmpeg cannot be found, or when the peak list is empty or implausibly long.

## Workflow

### 1. Establish what is being cut

Read the project. Identify the gameplay asset, its duration, whether it is transcribed, and whether commentary and game audio are on one mixed track or separate tracks.

Confirm with the user: how many moments they want, roughly how long each should be, whether the output should be markers on the current timeline or separate sequences, and whether the source is competitive play (short, sharp events) or something slower. Do not start a long analysis on a two-hour VOD without that.

Separate tracks are worth asking about. When commentary sits on its own track, run the script against that track's source file: the peaks are then reactions rather than explosions, which is usually what the user means by a highlight.

### 2. Get a local path to the media

The script reads a file from disk, so it needs a real path, not an asset id.

- The user's own recording (the OBS or capture output) is the best input when it still exists; ask for it.
- Otherwise map the asset's `/media/uploads/<name>` URL onto the app's media directory. In a default packaged install that is `%APPDATA%\OpenChatCut\public\media\uploads\<name>`; a custom data directory puts it at `<data dir>\media\uploads\<name>`, and a configured `MEDIA_DIR` overrides both.
- Confirm the path with the user rather than guessing between those. A wrong path fails immediately and costs a confirmation prompt.

### 3. Run the peak detector

```
run_skill_script skill="gameplay-peaks" command="node scripts/peaks.mjs <absolute-media-path>" timeout=120000
```

Every call needs the user's confirmation, so batch the options into one call rather than probing. Use `timeout=120000` for anything over an hour; measured cost is roughly 5.5 s per 40 minutes of source on a modern machine, so a two-hour VOD lands near 17 s, but a slow disk or a heavily compressed source can be several times that.

The script prints JSON on stdout and diagnostics on stderr:

```json
{
  "durationSeconds": 60.01,
  "options": { "thresholdDb": 6, "minDurationMs": 700, "minGapMs": 3000 },
  "peaks": [
    {
      "start": 44.95,
      "end": 48.25,
      "score": 0.963,
      "reason": "28.2 dB above a -55.3 dBFS baseline, sustained 3.25 s (mean +27.9 dB)",
      "peakAt": 47.4,
      "peakDb": -27,
      "baselineDb": -55.3,
      "durationSeconds": 3.25
    }
  ]
}
```

`start`, `end` and `peakAt` are seconds in the source media. `score` is 0–1 and is comparable within one source; it is not a quality judgment, only a measure of how far above the surrounding baseline the moment sits.

If the list is empty or has dozens of entries, adjust `--threshold-db` and `--min-duration-ms` once, using `references/running-the-script.md`. Do not iterate more than twice — a source that needs a third pass usually needs a different track instead.

### 4. Cross-reference every peak before believing it

For the top peaks only — ten at most, fewer for a short session — gather corroboration. This is the step that separates a moment from a loud noise.

- **Transcript.** Call `find_transcript` with a phrase from the peak, or `read_transcript` bounded to the surrounding range, and read what was said across the peak and the ten seconds after it. Excited, broken, or exclamatory speech over a peak is strong evidence. Calm narration over a peak usually means the loudness came from the game, which is weaker on its own. Silence over a peak means the game made the noise and the streamer did not react, which is the weakest case.
- **Scene boundaries.** Call `detect_scenes` once with `apply:"report"` on the gameplay item. Boundaries near a peak mark round ends, respawns, map transitions and kill cams. A peak that sits just before a boundary usually has its payoff on the far side of it; a peak immediately after one is often a new round rather than an event.
- **Frames.** For the candidates you intend to propose, one `view_asset_frames` call per candidate with at most six samples across the range. This catches the peaks that are a chair scrape, a doorbell, or a microphone bump.

Record for each surviving candidate: source range, peak time, score, what the transcript says, the nearest scene boundaries, and what the frames showed. Keep the source timestamps in everything you report.

`references/cross-referencing.md` has the weighting and the rejection gates.

### 5. Turn a peak into a moment

A peak marks the reaction, not the event. The event is before it and the payoff is after it.

Expand each candidate to the smallest range that makes sense on its own: the setup that explains what is about to happen, the peak itself, and the reaction or result that pays it off. In practice that is a few seconds before `start` and up to ten seconds after `end`, resolved onto a clean phrase or scene boundary rather than a round number. `--pad-ms` can widen the reported ranges symmetrically, but a boundary chosen against the transcript and scene cuts is better than a symmetric pad.

Drop candidates that need the previous two minutes to make sense, unless the user asked for a long-form cutdown.

### 6. Propose, then apply what is approved

Show the user the ranked list before touching the project: source range, duration, score, the evidence for each, and what you would do with it. Never apply on your own initiative, including markers.

Once approved:

- **Markers** — `manage_markers` with `action:"create"` and a `markers[]` batch, one per moment, `scope:"item"` and the gameplay `itemId` so they travel with the clip. Put the evidence in the note (`+28 dB peak, "oh my days that was so close", scene cut 2 s later`) and use one colour consistently so the pass is recognisable.
- **Clip sequences** — `manage_timelines` with `action:"create"` for each approved moment, then switch to each new timeline and place the range with `edit_item` `adds`, reusing the original `sourceAssetId` with `sourceStartFrame` and `sourceDurationInFrames`. Do not copy the long recording.
- **Splits** — `split_item` at a moment's boundaries only when the user asked to cut the master timeline; it is destructive to the existing edit in a way markers are not.

Convert seconds to frames with the timeline fps before calling anything: `frame = round(seconds × fps)`.

### 7. Report what the evidence was

Report the moments you proposed, the ones you rejected and why, the options the script ran with, and anything you could not verify. A peak with no transcript, no scene boundary and no frame check is a guess; say so rather than presenting it as a find.

## Rules

- Audio energy generates candidates; the transcript, scene cuts and frames decide which ones survive.
- Never auto-apply. Markers, sequences and splits all wait for approval.
- Keep every candidate traceable to a source timestamp and a measured number.
- Do not pad the requested count with low-score peaks. Five real moments beat ten with three noises among them.
- Loudness is relative to this recording. A quiet, softly spoken session still has peaks; a permanently shouted one has fewer meaningful ones.
- The script never edits anything, writes nothing outside stdout and stderr, and reads only the file it is given.
