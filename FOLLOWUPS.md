# Follow-ups / Polish backlog

Things that work but need a second pass, or known limitations to revisit.
Newest session at top. Don't let this rot — delete items when done.

## Session 2026-07-03 — fast transitions + Trigger/Door + scale fix

### Fast scene transitions (persistent game) — Stage 3 NOT done
Stages 0–2 shipped: game persists, scene rebuilds in place via `scene.restart()`
(see CLAUDE.md §0). Behind `FAST_TRANSITIONS` flag in `ScenePanel.tsx` (currently ON).
- **Stage 3 open:** route `GoToLayoutWithLoad` (the loader boot) in-place too; add
  **CHOOSABLE music** (persist vs stop per transition — user wants a toggle on the
  Door config + the GoToLayout/GoToLayoutWithLoad actions; music is scene-scoped in
  `SoundManager` and disposed on SHUTDOWN, so "persist" needs a game-level/module
  music channel that survives restart); then retire the `FAST_TRANSITIONS` flag.
- **Leak audit (do before retiring the flag):** grep every `scene.events.on` /
  `scene.input.on` / `cam.on` in the runProject builder for a matching `.once(SHUTDOWN,
  off)` — a missed one leaks a listener per transition. Regression harness: loop A→B→A
  ~20× and watch `game.textures.getTextureKeys().length`, `world.colliders` count,
  listener counts stay flat; `__peakyGame` is the SAME object across transitions.
- **Optional:** a "unload textures not used by the new scene" pass to cap GPU memory
  (persistent game keeps every visited texture resident — bounded, but grows to the
  union of all visited assets). Trades some speed on return. Only if memory bites.

### Partially addresses Persistence BUG3 (transient objects)
Weather sprite splashes are now stamped `peaky.soTransient` and skipped by
`collectRuntimeSpriteObjects` (`eval.ts`) — fixes "phantom dizzle sprites on scene
entry". The GENERAL fix (bullets, other fire-and-forget `CreateSpriteObject` VFX)
still needs the same opt-out on those spawn paths — see BUG3 below.

## Session 2026-07-06 — v0.0.1 release audit (fixes landed)

All audit blockers + should-fixes are FIXED in `d863af6` + `4c6aa06`; the
dead-code sweep (~5,000 lines incl. ActionRow/EventsSection + legacy event
store cluster) and component docs landed after. See CLAUDE.md §0-pre for the
full list. DONE from earlier sections: the diagnostic SaveSlot/Load/capture
log spam is STRIPPED; weather-splash transient marking partially addresses
BUG3 (weather only).

### Still open for/after v0.0.1 (release-notes list)
- Fast transitions Stage 3: loader in-place + CHOOSABLE music (persist/stop
  toggle on Door + GoToLayout) + retire `FAST_TRANSITIONS` flag. Exported
  games still use cold destroy+reboot transitions (functional, heavier).
- Persistence BUG3 general case (bullets / fire-and-forget CreateSpriteObject
  VFX resurrect on load — needs the `peaky.soTransient`-style opt-out on
  those spawn paths) and BUG4 (tilemap serialize dumps ALL placements —
  save bloat).
- H3 freeze-cull ghost-fire; SmartTween rotation desync; periodic ~2s frame
  spike with many NPCs; localStorage ~5MB save ceiling (error is surfaced).
- Optional: texture-unload pass on transition if GPU memory ever bites
  (persistent game keeps every visited texture resident — bounded).

## Session 2026-06-29 — lighting + weather + audit

New components: **LightSource** (textured additive glow — edge modes smooth/hard/
noisy/wave, feather, flicker, center gizmo in BlueprintPreview), **Weather**
(rain/snow — screen/world space, topdown/sidescroller mode, kill-tags, splash
simple/sprite, size/speed jitter, rotation, wind). VisionMask now cuts Sprite
Objects too. Removed BlobShadow and the Weather `preset` field.

### Fixed in the audit pass (this session)
- **`routeOverlayToCamera` leak** — it added every routed overlay to
  `Sprite._fxObjects` with no removal. Now drops the ref on the overlay's
  `destroy` event (was leaking Weather splash pixels permanently).
- **Weather `margin = size + 8` string-concat** when `size` came as an inspector
  string → broke the off-screen bound. Coerced.
- **Weather `_killRects`** recomputed every frame (getBounds per tagged object);
  now cached, recomputed every 8th frame.
- **LightSource texture cache** keyed per `feather*100`/`amount*100` → a slider
  sweep minted ~100 256² textures. Quantized to 0.1 steps (~11 buckets).
- **Persistence BUG1** — deferred tilemap `_init` + `deserialize` double-spawned
  BigTile/animated placements (`_destroyBigTilePlacement` no-ops on un-built
  resources). `deserialize` now resets `L.bigTilePlacements`/`animatedTilePlacements`.
- **Persistence BUG2** — LoadSlot destroyed live spawned objects absent from the
  save, which wiped **boot-spawned** objects (OnSceneStart → CreateObject). That
  removal is gone (trade-off: an in-session post-save spawn isn't culled on load).

### Still open (flagged, not fixed)
- **Persistence BUG3 — transient objects persist.** `FireProjectile` bullets and
  fire-and-forget `CreateSpriteObject` VFX get a spawnId / `peaky.soRuntime`, so
  they're captured by SaveSlot + `captureSpawnedForScene` and **recreated** on
  load/return (bullets resurrect frozen — velocity isn't saved; splash VFX
  reappear). Needs a "transient / no-persist" opt-out on those spawn paths.
- **Persistence BUG4 — tilemap serialize dumps ALL placements.** `serialize()`
  doesn't diff BigTile/animated placements vs authored, so any single edit
  re-emits the whole authored set, and `deserialize` re-creates them with NEW
  random ids → save bloat ∝ authored-placement count + unstable placement ids.
  Fix: snapshot authored placement ids in init (like `_authoredTiles`), serialize
  only the delta.
- **VisionMask B2** — under an active `cutoutLayers` filter, a sprite object with
  no stamped layer name is EXCLUDED, but the comment claims fallback-to-eligible.
  Pick one (the runtime sprite-object darkness-sheet case can silently not cut).
- **VisionMask B1** — sprite objects destroyed by non-animated paths stay in
  `peaky.placementsBySpriteId` as dead GOs, rescanned each frame (guarded by
  `!go.scene`, so no crash — just wasted work).
- **LightSource A2** — `createCanvas` returning null (alloc failure) returns a key
  with no texture → additive missing-texture box. A3 — baked textures never freed
  (now bounded by the quantize, acceptable).
- **Weather edge cases** — `speed: 0` or `angle: ±90` → particles freeze (no fall);
  cosmetic. Worldview 0×0 at attach → 1-frame clump at origin, self-heals.
- **localStorage quota** — `spawnedByScene` + `tileEditsByScene` ride in every
  save; a big multi-level world can approach ~5MB (failure is surfaced loudly).

## Session 2026-06-28 — persistence + tile placement

### Tile placement (needs polish)
- **Visual picker "misses tiles" (UNRESOLVED).** User reported the BigTile/Animated
  picker doesn't show all tiles they have on a tilemap. The picker scans the
  tilemap's primary + `extraTilesetIds`, falling back to all tilesets only when
  none resolve (`LogicGraphCanvas.tsx` `tilePicker` memo + `tilemapBigTilesByName`).
  Re-confirm with a concrete count (how many defined vs shown) and whether the
  tilemap uses one tileset or several.
- **Animated-tile thumbnail.** Renders via `BigTilePreview` + `animFrameRegion(frame0)`.
  Confirm it renders in: tileset tab, node picker, AND the placed tile in-game.
  User flagged a missing thumbnail somewhere — pin down which surface.
- **BigTile names** just added (`BigTile.name`, TilesetTab input, runtime name→id in
  `placeBigTile`). Verify names round-trip and the picker stores id (runtime resolves).
- **`Set Tile` (single tile) has no visual picker** — intentional (game uses big/animated
  only) but the raw `index` field is confusing. Consider hiding the cell-based
  `PlaceBigTile`/`SetTile` nodes from the palette if only the world variants are wanted.
- **`PlaceBigTile` (cell c,r) still in palette** alongside `Place BigTile (world x,y)`.
  Two near-identical nodes; the cell one needs C/R nobody computes. Maybe deprecate.

### Diagnostic logging to REMOVE once persistence is trusted
- `eval.ts` SaveSlot/LoadSlot: `Save "x" → N sprites…` / `Load "x" → …` count lines.
- `eval.ts` `captureSpawnedForScene`: `Captured N runtime objects + M tilemap edit sets…`.
- `runProject.ts` replay block: `Entering scene id="…" — N carried-over…`.
All `level: "warn"` so they spam the Output Log on every save/transition.

### Persistence limitations (by design for v1 — revisit if needed)
- **Tile serialize captures ALL placements** (authored + runtime); deserialize
  clears + rebuilds. Correct but heavier than a delta for maps with many authored
  BigTiles. Optimize to runtime-delta if save size becomes an issue.
- **Tile regrow timers NOT persisted.** A tile mid-regrow loads in its final state
  (destroyed stays destroyed); no countdown resume. User accepted this.
- **Spawned-object runtime tags not restored.** `AddTag` at runtime is lost on
  recreate — only the BP's own tags come back. (`eval.ts` LoadSlot / runProject replay.)
- **Autosave is 3 minutes** (TopBar.tsx) — up to 3 min lost on a browser *crash*
  (normal close is guarded by beforeunload). User chose this cadence.

### Carried over from earlier
- **H3 freeze-cull ghost-fire** (audit): a `cullMode:"freeze"` sprite stays tag-indexed
  but stops flushing its bus, so `EmitSignalTo`-by-tag can ghost-fire on wake.
  Fix: flush the bus for frozen sprites in the cull path (`Sprite.ts` ~840 / `Game.ts`).
- **H6 param-resolver hardening** — assistant-only; parked for beta.
