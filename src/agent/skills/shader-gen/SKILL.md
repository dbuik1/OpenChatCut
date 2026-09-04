---
name: shader-gen
description: |
  AI shader generator for WebGL video effects, transitions, masks, and color grading (LUT / 调色 / 电影感 / film look). Use when the user wants a video effect (滤镜 / 特效), a transition (转场 / crossfade / wipe / cube / 3d), a mask (蒙版 / 遮罩 / reveal), a zoom / push-in (推近 / 推镜头), or a color grade — try the built-in effects (zoom, builtin LUTs) before generating a new shader.
user-invocable: true
---

# Shader Generator

Submit-only: creates a backend generation job, returns `jobId`. Use the `track_progress` tool for job lifecycle after submission.

**Always use `generate.ts` for new shaders.** Manual authoring is only for editing existing asset code — never as a fallback when generation fails.

## Catalog-first rule — try existing assets before generation

Before generating a shader, call `browse_library` unless the user names an exact asset id that is already visible in `read_project`.

`browse_library` is the source of truth for built-in effects, built-in transitions, and project effect/transition assets. Built-ins are stable global asset ids, not per-project DB assets, so they may not appear in `read_project` asset lists.

Apply catalog entries with `edit_item`, do **not** call `submit_shader`.

Good catalog searches:

```text
browse_library(query: "zoom")
browse_library(category: "transitions", query: "dissolve")
browse_library(category: "audio-fx")
```

Generate only when no catalog entry matches the user's intent closely enough.

### `builtin:zoom` attaches to one item

Zoom is a property of a clip, not a range on a track. Pass `targetItemId`; the
target must be a visual clip (video, image, gif, svg, motion-graphic — an audio
target is rejected). There is no track-bound zoom: to zoom only part of a clip,
`split_item` first and zoom the piece.

```text
# Slow continuous zoom across the whole clip — the Ken Burns push
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"builtin:zoom","propertyOverrides":{"shape":"slow-push","magnification":1.2}}]}')

# Punch in on a beat: split the clip at the beat, zoom the second piece
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<piece-id>","assetId":"builtin:zoom","propertyOverrides":{"shape":"punch","magnification":1.6,"focalPointX":0.4,"focalPointY":0.35}}]}')

# Remove a zoom
edit_item(json: '{"deletes":[{"type":"effect","targetItemId":"<clip-id>","assetId":"builtin:zoom"}]}')
```

`assetId` may also be `library:zoom:<shape>`, which sets the shape and lets you
omit it from `propertyOverrides`.

| Key             | Type     | Range / values           | Default | Notes                                                     |
| --------------- | -------- | ------------------------ | ------- | --------------------------------------------------------- |
| `shape`         | select   | see below                | `hold`  | The animation curve                                        |
| `magnification` | number   | 1-16                     | `1.5`   | Peak zoom factor; 1 = no zoom, 2 = 2x in                   |
| `focalPointX`   | number   | 0-1                      | `0.5`   | Horizontal point the zoom pushes toward (0 left, 1 right)  |
| `focalPointY`   | number   | 0-1                      | `0.5`   | Vertical point the zoom pushes toward (0 top, 1 bottom)    |
| `envelope`      | number[] | 2-120 points, each 0-1.5 | -       | A custom curve sampled across the clip; overrides `shape`  |

Shapes: `slow-push` (gradual push across the whole clip), `hold` (in and back
out), `punch`, `instant`, `zoom-out`, `ease-in`, `bounce`, `snap`, `pulse`,
`whip-in`. `browse_library(category:"zoom")` returns all ten with usage notes.

Only the keys above are read. Send only the keys you want to change — patch
semantics; omit `propertyOverrides` entirely for a default zoom.

For a zoom that follows a moving subject rather than pushing toward a fixed
point, `auto_reframe` writes a per-frame reframe curve instead, and that curve
takes priority over any shape set here.

### Built-in LUT properties

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"builtin:slog3-s709","propertyOverrides":{"intensity":1}}]}')
```

| Key         | Type   | Range | Default | Notes                          |
| ----------- | ------ | ----- | ------- | ------------------------------ |
| `intensity` | number | 0–1   | `1`     | LUT strength; 1 = full applied |

To swap: delete the effect and re-add with a different `assetId`. To remove: delete the effect item.

These are separate from user-uploaded `.cube` LUT assets (see "Applying an Existing LUT Asset" below) — those use a different code path with `assetId:"lut"`.

## Beta Status Gate

New shader generation is beta. Before generating, warn the user and wait for explicit confirmation.

Use the user's language. Chinese: "新的特效/转场生成目前还是 beta 阶段，可能会有不稳定的问题。如果你坚持要做，我可以帮你实现。" Skip if user already acknowledged in the same request.

## Supported Targets

Effects and transitions apply to `video`, `image`, and `gif` items.

## Type Routing

Before generating anything, check two non-generation paths first:

1. **Catalog entry** — use `browse_library` for built-in and project effects/transitions.
2. **User-uploaded `.cube` LUT asset** that already exists in the project library — separate code path, see "Applying an Existing LUT Asset" below. The asset shows up in `read_project` with `type: lut`.

| User wants                                                           | `--type`     |
| -------------------------------------------------------------------- | ------------ |
| Video appearance (color, blur, glow, grain, distortion)              | `effect`     |
| Color grade / look (teal-orange, cinematic, vintage, LUT-style)      | `effect`     |
| Visibility control (mask, reveal, wipe, shape cutout, gradient fade) | `effect`     |
| Blend between clips (crossfade, dissolve, slide, 3D cube/page flip)  | `transition` |

"LUT-style" in the table means **generating a fresh GLSL color grade that resembles a LUT** — only when the user wants something new. If they want to apply a `.cube` file already in the library, don't generate; bind the existing asset instead.

No separate LUT or mask generator for the generation path — those are all `effect`.

## Applying an Existing LUT Asset

`.cube` files uploaded by the user become `lut` assets. Applying one to a clip is **not** generation — it's a single `edit_item` call that attaches an effect item whose `assetId` is the literal string `"lut"` and whose `propertyOverrides.lut` binds the real LUT asset id. (Legacy contract; the unified LUT API binds the LUT effect asset id directly — see `edit_item` description.)

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"lut","propertyOverrides":{"intensity":1,"lut":{"assetId":"<lut-asset-id>","assetType":"lut","type":"asset"}}}]}')
```

Key points:

- `assetId` is the literal string `"lut"`, not the LUT asset's id. The real LUT asset id goes inside `propertyOverrides.lut.assetId`.
- `intensity` is 0–1; default 1 (full strength).
- `targetItemType` defaults to `video`; also supports `image`, `gif`.
- To swap a LUT on an existing effect: update `propertyOverrides.lut.assetId` to the new LUT asset id.
- To remove: delete the effect item.

Do not call `generate.ts` for this path. Do not pass a real LUT asset id as `assetId` — the editor checks `assetId === "lut"` to route into the LUT renderer; passing a UUID silently renders nothing.

## Usage

Before calling `submit_shader`, restate the user's intent in one concrete sentence, then proceed immediately. After `track_progress` returns, state what was produced in one line — do NOT ask "要保留还是重新生成".

```ts
submit_shader({
  type: "effect",
  prompt: "Chromatic aberration with RGB split",
  name: "Chromatic Aberration",
});

submit_shader({
  type: "transition",
  prompt: "Smooth crossfade with soft edge",
  name: "Crossfade",
});

submit_shader({
  type: "effect",
  prompt: "Cinematic teal-orange color grade",
});

submit_shader({
  type: "effect",
  prompt: "Stronger version",
  referenceAssetIds: ["effect_asset_id"],
});
```

## Strategy

- Submit, then stop. Tell user the job was created.
- Use the `track_progress` tool for status/wait after submission.
- Generation always produces a library asset — never refuse because the timeline isn't ready.
- **Apply is separate and optional.** Only apply when user explicitly asks ("加到视频", "apply", "用到第一段"). When ambiguous, default to library-only.

## Editing Existing Properties

Any time you're about to edit shader `asset.properties`, applied effect/transition `item.propertyOverrides`, or promote a hardcoded shader value, read [`references/property-changes.md`](references/property-changes.md) first.

It reinforces that shader `properties` is an array, but the allowed shader property types are only `number`, `boolean`, `color`, `select`, and `vec2`. Motion Graphic properties are also arrays, but use a different type set.

## Parameters

| Param               | Description                                                                                                                                                    | Default |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `type`              | `"effect"` or `"transition"` (req'd)                                                                                                                           | —       |
| `prompt`            | Description of the shader (req'd)                                                                                                                              | —       |
| `name`              | Asset name shown in library                                                                                                                                    | —       |
| `referenceAssetIds` | Asset ids. Image id → model LOOKS AT it for visual inspiration. Effect/transition id → reuse its code as style anchor (≤1 per submit, kind must match `type`). | —       |

## Output

Returns `{ success, job: { jobId, status }, manage: { status, wait, watch } }`.

## Applying to Timeline

Only when user explicitly requests. Call `read_project` first for fresh timeline state.

### Effect

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<id>","assetId":"<id>","enabled":true,"propertyOverrides":{}}]}')
```

### Transition

Requires two adjacent same-track endpoints. `edit_item` validates live seam feasibility and refuses durations that would require freeze frames or overlapping neighboring transitions. If the add fails, retry with the suggested `durationInFrames`, trim the clips to expose handles, delete/shorten neighboring transitions, or keep a hard cut.

```text
edit_item(json: '{"adds":[{"type":"transition","assetId":"<id>","outgoingItemId":"<id1>","incomingItemId":"<id2>","durationInFrames":30}]}')
```

## Validation & Verification

### Backend Validation

When generating via `generate.ts`, the backend handles validation automatically (transpile, AST security, class structure, retry on failure).

### Manual Code Verification

**NEVER write shader code from scratch.** Always use `generate.ts` for new shaders. This section is ONLY for modifying existing shader code that was already generated.

When writing shader code manually, read `${CLAUDE_SKILL_DIR}/references/design-principles.md` first. If the change touches editable properties, also read `${CLAUDE_SKILL_DIR}/references/property-changes.md`.

Typical workflow:

1. `read_project` with the shader `assetId` and `code: true` — read the current source.
2. Edit the source in your own context.
3. `edit_asset` with `action=update`, the same `assetId`, and the full replacement source inline in `json.code`. Validation runs automatically on update — if code is invalid, the update is rejected with error details.
