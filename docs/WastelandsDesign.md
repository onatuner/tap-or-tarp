# Design Document: The Wastelands Campaign

## Context

A new campaign called "The Wastelands" needs to be added. It introduces damage tracking, a points/scoring system with multipliers, and player levels. These mechanics must be implemented as **generic, reusable systems** so future campaigns can use them, while keeping Wastelands-specific configuration in a **separate file**.

---

## New Files

| File | Purpose |
|------|---------|
| `lib/game-modes/campaign-presets/wastelands.js` | Wastelands preset config: scoring formula, multiplier tables, level thresholds |
| `__tests__/wastelands.test.js` | Tests for damage tracking, scoring, levels, multipliers, win condition |

## Modified Files

| File | Changes |
|------|---------|
| `lib/game-modes/base.js` | Add `onPlayerLifeChanged()` hook + `getActingPlayerId()` helper |
| `lib/game-modes/campaign.js` | Add damage/scoring/level infrastructure to `CampaignState`; register Wastelands preset; wire life-change hook; add `total_points` win condition |
| `public/index.html` | Add campaign stats display HTML |
| `public/client.js` | Add `updateCampaignStats()` function, wire into `updateGameUI()` |
| `public/style.css` | Campaign stats bar styling |

---

## Server-Side Changes

### 1. Life-Change Hook in `base.js`

**In `updatePlayer()` (line 870):** Capture life delta and call a new virtual method.

```js
// Before:
if (updates.life !== undefined) {
  player.life = Math.max(MIN_LIFE, Math.min(MAX_LIFE, updates.life));
}

// After:
if (updates.life !== undefined) {
  const oldLife = player.life;
  player.life = Math.max(MIN_LIFE, Math.min(MAX_LIFE, updates.life));
  if (player.life !== oldLife) {
    this.onPlayerLifeChanged(playerId, oldLife, player.life);
  }
}
```

**New virtual method** (next to existing `onGameComplete()` at line 81):

```js
onPlayerLifeChanged(playerId, oldLife, newLife) {
  // No-op in base class. Override in subclasses.
}
```

**New helper method** (generic, useful for any attribution logic):

```js
getActingPlayerId() {
  if (this.interruptingPlayers.length > 0) {
    return this.interruptingPlayers[this.interruptingPlayers.length - 1];
  }
  if (this.targetingState === TARGETING.STATES.RESOLVING) {
    return this.originalActivePlayer;
  }
  return this.activePlayer;
}
```

**Note:** Timeout penalties (`resolveTimeoutChoice` line 501) and admin revive (`revivePlayer` line 978) modify `player.life` directly — they bypass `updatePlayer()`, so the hook does NOT fire for system-imposed changes. This is correct behavior.

### 2. Generic Scoring Infrastructure in `CampaignState` (campaign.js)

**New fields** in constructor (initialized per player):
- `damageTracker` — `{ [playerId]: { [targetId]: totalDamage } }`
- `playerPoints` — `{ [playerId]: number }`
- `playerLevels` — `{ [playerId]: number }`

**New methods on `CampaignState`:**
- `recordDamage(attackerId, targetId, amount)` — adds to damageTracker
- `getTotalDamage(playerId)` — sum of all damage dealt by player
- `getUniqueDamagedCount(playerId)` — count of unique targets damaged
- `calculatePoints(playerId)` — delegates to `config.scoringFormula(this, playerId)` if defined, else returns 0
- `calculateLevel(points)` — walks `config.levelThresholds` array if defined, else returns 1
- `recalculateAllScores()` — recalculates points and levels for all players
- `finalizeRoundScoring()` — recalculates scores, saves accumulated points into `playerStats[id].accumulatedPoints`, resets `damageTracker` for next round

**Serialization:** Add `damageTracker`, `playerPoints`, `playerLevels` to `toJSON()`. Restore with defaults in `fromState()`. Re-attach `scoringFormula` and `levelThresholds` from the preset registry on restore (functions can't be JSON-serialized).

### 3. Wire Hook in `CampaignGameSession`

**Override `onPlayerLifeChanged`:**
- If `newLife >= oldLife`: ignore (healing, not damage)
- If `status !== 'running'`: ignore
- Compute `damage = oldLife - newLife`
- Get `actingPlayerId = this.getActingPlayerId()`
- Skip if acting player is the same as target (self-damage) or null
- Call `this.campaign.recordDamage(actingPlayerId, targetPlayerId, damage)`
- Call `this.campaign.recalculateAllScores()`

**Modify `onGameComplete`:** Call `this.campaign.finalizeRoundScoring()` before `recordRound()`.

**Apply preset bonus time:** In constructor, if `this.campaign.config.bonusTime` is defined, set `this.settings.bonusTime` to it.

### 4. Update State Broadcasting

**In `CampaignGameSession.getState()`:** Include `damageTracker`, `playerPoints`, `playerLevels` in the campaign object. For `config`, include displayable fields (`name`, `battleMultipliers`, `playerMultipliers`) but not the function reference.

### 5. New Win Condition: `total_points`

Add to `CampaignState.checkCampaignComplete()`: after all rounds, winner is the player with most accumulated points.

### 6. The Wastelands Preset (`campaign-presets/wastelands.js`)

```
Name: "The Wastelands"
Rounds: 3
Time per round: 6 minutes (no decrease)
Bonus time: 30 seconds per turn
Win condition: "total_points"
```

**Battle Multipliers:** `{ 1: 1.0, 2: 1.5, 3: 2.0 }`

**Player Multipliers** (by unique targets damaged): `{ 0: 0, 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, ... }`

**Level Thresholds:** `[10, 25, 50, 80, 120]` (points needed for levels 2-6)

**Scoring Formula:** `previousAccumulatedPoints + floor(roundDamage × playerMult × battleMult)`

**Registration:** Import in `campaign.js` and add to `CAMPAIGN_PRESETS` object.

---

## Client-Side Changes

### 1. HTML (`public/index.html`)

Add a `.game-campaign-stats` row inside `.game-player-stats` (between name row and stats row). Contains compact stat chips for: Level, Points, Multiplier, Battle progress. Hidden by default (`display: none`).

### 2. JavaScript (`public/client.js`)

**New `gameUI` reference:** `campaignStats: document.querySelector(".game-campaign-stats")`

**New function `updateCampaignStats()`:**
- Show only when `gameState.mode === 'campaign'` and campaign has scoring data
- Display for the claimed player: level, points, effective multiplier (player × battle), battle N/M
- Use the same `updateStatValue()` animation pattern for value changes

**Wire into `updateGameUI()`:** Call `updateCampaignStats()` after `updatePlayerStats()`.

### 3. CSS (`public/style.css`)

Campaign stats bar: horizontal flex row of compact chips. Follow existing stat styling patterns (font sizes, colors, responsive breakpoints).

---

## Verification

1. **Unit tests** (`npm test`): All existing 590 tests pass + new wastelands tests
2. **Damage tracking**: Life decrease during active player's turn credits the active player. Healing, self-damage, timeout penalties, and admin actions do NOT record damage.
3. **Scoring**: Points = accumulated + floor(roundDamage × playerMult × battleMult). Verify with various multiplier combos.
4. **Levels**: Points reaching thresholds increment level correctly.
5. **Persistence**: `toJSON()` → `fromState()` round-trip preserves all scoring data. `scoringFormula` re-attached from preset registry.
6. **Win condition**: After 3 battles, player with most total points wins.
7. **Client display**: Campaign stats row visible during Wastelands games, hidden for casual/other campaigns. Values update live as damage occurs.
8. **Backward compatibility**: Existing campaigns (standard, blitz, endurance) work unchanged — no scoring fields, stats row stays hidden.
