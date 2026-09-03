# Classifying candidates

`candidates.mjs` produces a shortlist by frequency. Frequency is not a verdict: the commonest word in a gaming VOD is often a game term. This reference is how to decide.

## The test

A token is a filler when removing every occurrence leaves the sentence saying the same thing, only faster. If removal changes the meaning, weakens a claim, or breaks the grammar, it is not a filler — however often it appears.

Apply the test to the examples the script returned, not to the word in the abstract. Three contexts spread across the recording are usually enough to see which use dominates.

## Usually fillers in commentary

Discourse markers and hedges that carry no information in speech: `like` (as a hedge or quotative filler), `basically`, `literally`, `actually`, `honestly`, `obviously`, `essentially`, `kinda`, `sorta`, `anyway`, `whatever`, `right` (as a tag), `yeah` (as a sentence-opener), `okay` (as a sentence-opener), `so` (as a sentence-opener), `well` (as a sentence-opener), `dude`, `bro`, `man` (as address).

Every one of these has a meaningful use as well. That is why the examples matter.

## Never fillers

- Negations and their contractions: `no`, `not`, `never`, `don't`, `can't`.
- Quantities, numbers, times, scores.
- Names, teams, weapons, maps, abilities, items.
- Callouts and directions: `left`, `behind`, `push`, `rotate`, `top`, `A`, `B`.
- Verbs and nouns carrying the action: `got`, `down`, `killed`, `plant`, `revive`.
- Words the removal of which inverts or weakens a claim: `just` in "just barely", `only`, `almost`.

When a token appears in both roles, err towards keeping it and tell the user why. A cut that removes meaning is worse than a filler that survives.

## Borderline cases and how to resolve them

**`so`** — an opener ("so, we're dropping bank") is filler; a connective ("so we rotated") carries causality. Usually high-count and mixed. Propose it only when the examples are overwhelmingly openers, and say the split you saw.

**`right`** — the tag ("hold this angle, right") is filler; the direction ("he's on your right") is a callout that must survive. In gaming footage this one is dangerous; default to keeping it.

**`just`** — a softener ("I just think") is filler; a minimiser ("just barely made it") is meaning. Usually keep.

**`okay` and `yeah`** — as openers they are filler; as answers or beats between thoughts they are part of the delivery, and cutting all of them can make speech sound clipped. Consider proposing them and letting the user decide.

**`like`** — usually the clearest win in modern speech, and usually the highest count. Check the examples for comparisons ("moves like a tank") and quotatives ("I was like, no way"). The quotative is meaningful in narration even though it is grammatically a filler; if the speaker tells stories, flag it.

## Repetition patterns

The `repetitions` list reports doubled tokens: "wait wait", "okay okay", "going going". They are real tics and cutting them tightens delivery, but `extraFillers` matches tokens, not pairs, so adding `wait` would also cut every meaningful "wait".

Report these separately, with timestamps, as candidates for `delete_text` on specific occurrences. Removing the second and third instance of a doubled word and keeping the first preserves the meaning and removes the stammer.

## What to show the user

A table beats prose:

| Token | Count | Per 1000 | Example | Verdict |
| --- | --- | --- | --- | --- |
| like | 12 | 28.6 | "…dropping bank again [like] we always do…" | filler |
| basically | 11 | 26.2 | "…okay so [basically] we are dropping bank…" | filler |
| right | 9 | 21.4 | "…hold this angle [right] like literally…" | keep — also used as a direction |

Then the repetition list, then the built-in fillers already handled, then the proposed `extraFillers` string exactly as it will be passed. The user should be able to approve by reading one screen.
