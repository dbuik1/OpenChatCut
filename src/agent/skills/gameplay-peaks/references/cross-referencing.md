# Turning peaks into moments

A peak is a measurement: the audio got much louder than its surroundings and stayed there. Whether that was a highlight is a separate question, and the answer comes from the other signals in the project.

## What each signal is worth

**The peak itself** establishes that something happened and when. `score` orders peaks within one recording; it does not compare across recordings and it says nothing about what caused the loudness.

**The transcript** is the strongest corroborator for a commentary VOD, because the speaker's reaction is the thing the audience came for.

- Exclamatory, broken or repeated speech across the peak ("no way — no way — did you see that") is the best evidence available. Treat it as confirming.
- Narration that continues calmly through the peak means the game was loud, not the moment. Keep it only when the frames show something worth watching.
- Silence across the peak and for several seconds after it is the weakest case. Something exploded and the streamer did not care.
- Speech that arrives two to eight seconds *after* the peak often marks the real payoff: the explanation of what just happened. Extend the range rather than moving it.

**Scene boundaries** from `detect_scenes` give the structural grid: round ends, deaths, respawns, kill cams, map and menu transitions.

- A peak within a couple of seconds of a boundary is usually a round-ending event; the payoff is typically on the far side of the boundary.
- A peak just after a boundary is often the start of new action rather than an event within the old one.
- A stretch with no boundaries around a peak is continuous play — the range can be set purely on the transcript.

Run `detect_scenes` once with `apply:"report"` for the whole item and reuse the result. Do not call it per candidate.

**Frames** are the defect check, not the selection signal. Six samples across a candidate range are enough to catch a menu screen, a loading screen, a black frame, or an alt-tabbed desktop.

## Ranking

Rank on evidence agreement first and score second:

1. Peak plus excited speech plus a nearby scene boundary.
2. Peak plus excited speech.
3. Peak plus a scene boundary plus frames that clearly show an event.
4. Peak alone with a high score — propose only if the user wants more moments than the stronger tiers provide, and label it as unconfirmed.

Diversify before filling a count. Ten peaks from one firefight are one moment. Spread the selection across the session and across kinds of event: a clutch, a failure, a funny reaction and a good line make a better set than four kills.

## Rejection gates

Drop a candidate outright when:

- the frames show a menu, loading screen, black frame, or desktop across most of the range;
- the loudness is a microphone bump, a cough, a door, or a chair — audible in the frames' context or obvious from the transcript;
- the range only makes sense with several minutes of prior context;
- the transcript across it contains something the user would not want published;
- the peak is a stream alert, donation sound, or notification jingle that recurs at the same level throughout the recording — check whether the same `peakDb` shows up repeatedly with no speech.

Report rejections and their reason. A rejected candidate is useful information about the recording.

## Building the range

Set boundaries from evidence, in this order: a clean phrase boundary in the transcript, then a scene boundary, then the raw peak bounds.

A workable default before refinement is 3 s before `start` and 6 s after `end`, but only as a starting point to be resolved onto a real boundary. Competitive play tends to need less setup and more payoff; slower games need more setup.

Keep the setup only when the moment is confusing without it. Keep the reaction whenever the reaction is the point, which for commentary VODs is most of the time.

## Recording the decision

For each candidate carry through to the proposal:

```json
{
  "sourceRange": [44.95, 48.25],
  "peakAt": 47.4,
  "score": 0.963,
  "measurement": "28.2 dB above a -55.3 dBFS baseline, sustained 3.25 s",
  "speech": "oh my days that was so close honestly that was insane",
  "sceneBoundaries": [43.8, 50.1],
  "framesChecked": true,
  "proposedRange": [42.0, 54.0],
  "why": "clutch survival; reaction runs to 53 s, round ends at the 50 s boundary",
  "confidence": "confirmed"
}
```

`confidence` is `confirmed` (two or more signals agree), `probable` (one strong signal), or `unconfirmed` (peak only). Show it to the user; it is the difference between a find and a guess.
