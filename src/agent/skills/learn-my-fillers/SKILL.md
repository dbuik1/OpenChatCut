---
name: learn-my-fillers
description: Learn one speaker's own verbal tics from their transcript instead of relying on the fixed um/uh list, get the proposed filler list approved, and pass it to clean_script as extraFillers. Use when the user asks to cut their filler words, verbal tics, crutch words, or "the way I say like all the time", or when clean_script's built-in filler removal leaves the habits that actually clutter their commentary.
---

# Learn My Fillers

**Requires a build whose `clean_script` accepts an `extraFillers` parameter.** The stock tool strips a fixed list — `um`, `uh`, `er`, `hmm` and their variants — and nothing else, so a speaker whose tic is "basically" or "like" gets no benefit from it. This workflow learns the speaker's own list and passes it in.

If `clean_script` rejects `extraFillers`, do not silently fall back to the fixed list and do not start deleting words one at a time. Stop, tell the user the build does not support it, and hand them the learned list with its counts so they can apply it another way — `delete_text` on specific occurrences, or a later build. The learning is still worth having; the application is what is missing.

## Required References

- Read [references/classification.md](references/classification.md) before deciding which candidates are fillers.

## Workflow

### 1. Get a transcript

The clip must be transcribed. If it is not, run `transcribe_track` first.

Read it with `read_transcript`, paging with `offset` and `limit` until the whole recording is covered. Keep the phrase text and each phrase's start time.

A short recording — under about 300 words — is not worth this workflow. Habits need repetition to be visible, and below that the counts are noise. Say so and use plain `clean_script` instead.

### 2. Shortlist the candidates

`scripts/candidates.mjs` does the counting: it normalises tokens exactly as `isFiller` does (lowercase, then strip everything outside a–z and CJK), drops the words `clean_script` already handles and the grammatical words a mechanical cut must never remove, and returns the frequent short tokens that remain with up to three example contexts each. That keeps the classification step to a few dozen entries instead of the whole transcript.

Two ways to run it, depending on what this build has:

**Sandbox (preferred, no manual step).** `run_code` can write files inline, so write the transcript and the script into the sandbox and run them there:

```
run_code command="node candidates.mjs transcript.json"
  files=[
    {"path": "transcript.json", "content": "{\"phrases\":[{\"start\":0,\"text\":\"…\"}]}"},
    {"path": "candidates.mjs", "content": "…the contents of scripts/candidates.mjs…"}
  ]
```

The script is already in context — every file in an installed skill directory is loaded when the skill is loaded — so no fetching is needed.

**Local.** `run_skill_script` has no way to receive inline data: the command string is split on whitespace and there is no stdin. It can only be used when the transcript is already a file on disk, which means asking the user to save it:

```
run_skill_script skill="learn-my-fillers" command="node scripts/candidates.mjs transcript.json"
```

with `transcript.json` saved into `%USERPROFILE%\.openchatcut\skills\learn-my-fillers\`. Every call needs a confirmation, so only take this route when the sandbox is unavailable.

If neither is available, do the counting yourself over the paged transcript — same normalisation, same exclusions — and carry on from step 3. It costs context but it is not wrong.

**Input shape.** The script accepts `{"words": [{"text","start"}]}`, `{"phrases": [{"text","start"}]}`, `{"segments": […]}`, a bare array of those objects or of strings, or one long string. `start` may also be `startMs`, `from`, `fromMs`, `startSeconds` or `fromSeconds`; bare `start` is read as milliseconds. Times only label the examples. `scripts/sample-transcript.json` is a worked example of the phrase shape.

**Options.** `--min-count` (default 3), `--max-len` (12), `--limit` (40), `--examples` (3), `--context-words` (4). Raise `--min-count` for a long VOD where everything crosses 3; lower it for a short one.

### 3. Classify only the shortlist

Read `references/classification.md`, then split the candidates into filler and meaningful. Judge each token on its examples, not on the word in the abstract: "like" as a hedge is a filler, "like" in "moves like a tank" is not, and the count tells you which use dominates.

Two things the script hands you that matter here:

- `immediateRepeats` and the `repetitions` list flag doubled words — "wait wait", "okay okay", "no no no". Stammer repetition is usually worth cutting even when the word itself is meaningful, but `extraFillers` matches tokens, not pairs: adding `wait` would cut every "wait", including the ones that carry meaning. Report repetitions to the user as something to handle with `delete_text` at specific timestamps, not through `extraFillers`.
- `alreadyHandled` shows how often the built-in fillers occur. Include it in the report so the user can see what the default pass is already doing.

Never propose a word that changes meaning when removed: negations, quantities, names, game terms, directions, callouts.

### 4. Get approval — always

Show the user the proposed list before applying anything:

- each token, its count, its rate per thousand words, and one example context;
- what the transcript loses if it goes;
- the candidates you considered and rejected, briefly, so they can overrule you;
- the repetition patterns as a separate list needing separate handling.

Ask them to confirm, remove or add. This list changes how their voice sounds; it is not a detail to decide for them. Do not call `clean_script` before they answer.

### 5. Apply the approved list

```
clean_script only="fillers" extraFillers="like,basically,literally" cutPadMs=120
```

Pass `itemId` for a single clip or `track` for a whole track. `cutPadMs` of 100–150 keeps the cuts from sounding clipped. The whole call is one undo step.

Then verify before reporting success: `read_transcript` over a couple of the affected ranges, and if the user wants to hear it, `view_timeline_frames` proves nothing about audio — say plainly that the check was textual.

If `extraFillers` is rejected, follow the degradation note at the top of this file.

### 6. Offer to keep the list

The learned list is the useful artefact and it is stable across recordings from the same speaker. Offer to record it — in a project note, a marker, or their own notes — so the next session can start from it rather than re-learning. Re-run the learning pass when their speaking changes, not every session.

## Rules

- Count mechanically, classify with judgment, apply only with approval.
- Only tokens that survive the user's review reach `extraFillers`.
- Never remove a word that changes meaning; when unsure, leave it in and say why.
- Report counts and examples, not adjectives. "like, 12 times in 420 words" is a fact the user can act on.
- One `clean_script` call for the approved list, so one undo puts it all back.
