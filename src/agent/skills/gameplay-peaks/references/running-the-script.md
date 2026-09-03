# Running peaks.mjs

## The call

```
run_skill_script skill="gameplay-peaks" command="node scripts/peaks.mjs C:\Users\me\Videos\vod.mkv" timeout=120000
```

The working directory is locked to the skill directory, so `scripts/peaks.mjs` is always the right relative path. The media path is separate and may point anywhere on disk.

Constraints that shape how this script is written and called:

- Only whitelisted binaries run, and interpreters may only execute a script file inside the skill directory. There is no `node -e`, no shell, and no way to pass data in on stdin — arguments are the only input channel.
- The command string is split on whitespace, so a path containing spaces cannot be passed through `run_skill_script`. Ask the user to move or copy the file to a space-free path, or run the script from a terminal.
- The environment holds only `PATH` and `HOME`, so the app's `OPENCHATCUT_FFMPEG` setting is not visible to the script. It finds ffmpeg on its own; see below.
- Timeout defaults to 60 s and is capped at 120 s. Output is capped at 512 KB, which `--max 20` stays far inside.
- On Windows `bash` and `sh` need Git Bash, which may not be installed. Use `node`.

## How ffmpeg is found

In order, stopping at the first that answers `-version`:

1. `--ffmpeg <path>` on the command line. If this one fails, the script fails — it does not fall back, because a named binary that is silently replaced hides the mistake.
2. `ffmpeg-path.txt` in the skill directory, if present: a single line holding the path. Same hard-fail behaviour. This is the rescue hatch when nothing else resolves — the user can create it in Notepad.
3. `OPENCHATCUT_FFMPEG` or `FFMPEG_PATH` from the environment. Set when the script is run from a terminal; absent under `run_skill_script`.
4. Plain `ffmpeg` from `PATH`.
5. The binary the desktop app ships (`ffmpeg-static`), looked for under the usual install roots. The user profile is recovered from the working directory, which `run_skill_script` locks to `%USERPROFILE%\.openchatcut\skills\gameplay-peaks`, so three levels up is the profile: `%USERPROFILE%\AppData\Local\Programs\OpenChatCut\resources\app\node_modules\ffmpeg-static\ffmpeg.exe` and the `Program Files` equivalents.

If it reports `no usable ffmpeg found`, list the paths it tried back to the user and ask them for the path to `ffmpeg.exe`, then either pass `--ffmpeg` or ask them to save it into `ffmpeg-path.txt`.

## Options and when to change them

| Option | Default | Raise it when | Lower it when |
| --- | --- | --- | --- |
| `--threshold-db` | 6 | Too many candidates; loud, constantly active game audio | Nothing found; softly spoken commentary |
| `--min-duration-ms` | 700 | Gunshots and UI blips are being reported | Reactions are short and clipped |
| `--min-gap-ms` | 3000 | One firefight is arriving as five candidates | Distinct moments are being merged |
| `--bridge-ms` | 400 | A reaction with a breath in it is splitting in two | Unrelated events are joining up |
| `--baseline-s` | 30 | Loudness drifts slowly across the session | Level changes fast, e.g. lobby to match |
| `--floor-db` | -50 | A noisy room floor is producing candidates | A very quietly recorded source finds nothing |
| `--pad-ms` | 0 | You want breathing room in the reported ranges | — |
| `--max` | 20 | — | You only want the top few |

Change one thing at a time and stop after two attempts. If the result is still wrong, the input is wrong: mixed game audio drowning the commentary, or a track that should have been analysed separately.

## Reading the diagnostics

stderr carries three lines: the ffmpeg binary chosen, the decoded duration, and the number of candidates. Both a decoded duration that does not match the source and `ffmpeg found no audio track` point at the input file, not at the thresholds.

## Method, briefly

One ffmpeg pass decodes the file to mono 8 kHz 16-bit PCM; the script computes 100 ms RMS windows every 50 ms, takes a 30 s rolling median as the baseline, and keeps runs that stay at least 6 dB above it for at least 700 ms, bridging dips under 400 ms and merging runs less than 3 s apart. The median baseline is what stops a long burst from raising the bar it is measured against.

The score combines peak excess (60%), mean excess (40%) and a small bonus for duration, mapped through fixed constants rather than normalised against the loudest moment found — so the same source and options always give the same numbers, and adding a louder moment does not renumber the others.

## Checking it still works

The script has no test fixture of its own; a synthetic file is the quickest check. From a terminal (not `run_skill_script`, which cannot chain commands):

```
ffmpeg -y -f lavfi -i "anoisesrc=color=pink:r=48000:d=60:seed=7,volume=-40dB" ^
  -f lavfi -i "sine=f=220:d=2.5:r=48000,volume=-8dB,adelay=8000,apad=whole_dur=60" ^
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0:duration=first[a]" -map "[a]" -t 60 check.wav
node scripts/peaks.mjs check.wav
```

One candidate starting at about 8.0 s means the chain works end to end.
