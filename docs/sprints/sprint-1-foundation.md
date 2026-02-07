# Sprint 1: Generic Foundation

## Goal
Add reusable hooks and scoring infrastructure to the base and campaign classes. No campaign-specific code yet — this sprint builds the generic systems that any future campaign can use.

## Files Modified
- `lib/game-modes/base.js`
- `lib/game-modes/campaign.js`

---

## Tasks

### 1.1 Add `onPlayerLifeChanged` hook to `base.js`

**In `updatePlayer()` (line 870):** Capture old life before setting new value, call hook if changed.

```js
if (updates.life !== undefined) {
  const oldLife = player.life;
  player.life = Math.max(MIN_LIFE, Math.min(MAX_LIFE, updates.life));
  if (player.life !== oldLife) {
    this.onPlayerLifeChanged(playerId, oldLife, player.life);
  }
}
```

**Add virtual method** next to `onGameComplete()` (line 81):

```js
onPlayerLifeChanged(playerId, oldLife, newLife) {
  // No-op in base class. Override in subclasses.
}
```

**Note:** Timeout penalties (`resolveTimeoutChoice` line 501) and admin revive (`revivePlayer` line 978) modify `player.life` directly, bypassing `updatePlayer()`. The hook intentionally does NOT fire for these system-imposed changes.

### 1.2 Add `getActingPlayerId()` helper to `base.js`

Generic method to determine which player is currently "acting" (accounts for interrupts and targeting):

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

### 1.3 Add damage/scoring/level infrastructure to `CampaignState`

**New fields** in `CampaignState` constructor (initialized per player):
- `damageTracker` — `{ [playerId]: { [targetId]: totalDamage } }`
- `playerPoints` — `{ [playerId]: number }`
- `playerLevels` — `{ [playerId]: number }`

**New methods:**

| Method | Description |
|--------|-------------|
| `recordDamage(attackerId, targetId, amount)` | Adds damage to tracker. Ignores amount <= 0. |
| `getTotalDamage(playerId)` | Sum of all damage dealt by this player |
| `getUniqueDamagedCount(playerId)` | Count of unique targets with damage > 0 |
| `calculatePoints(playerId)` | Delegates to `config.scoringFormula(this, playerId)` if defined, else returns 0 |
| `calculateLevel(points)` | Walks `config.levelThresholds` array if defined, else returns 1 |
| `recalculateAllScores()` | Recalculates points and levels for all players |
| `finalizeRoundScoring()` | Recalculates scores, saves `accumulatedPoints` into `playerStats`, resets `damageTracker` |

### 1.4 Add `total_points` win condition to `CampaignState`

Add new case in `checkCampaignComplete()`:

```js
case "total_points":
  if (this.currentRound > this.maxRounds) {
    let maxPoints = -1;
    for (const [playerId, points] of Object.entries(this.playerPoints)) {
      if (points > maxPoints) {
        maxPoints = points;
        this.winner = parseInt(playerId);
      }
    }
    this.campaignStatus = "completed";
    return true;
  }
  break;
```

### 1.5 Update `CampaignState` serialization

**`toJSON()`:** Add `damageTracker`, `playerPoints`, `playerLevels` to the returned object.

**`fromState()`:** Restore with defaults (`{}` / `{}` / `{}`) if absent. Re-attach `scoringFormula` and `levelThresholds` from the preset registry since functions can't be JSON-serialized:

```js
const presetConfig = CAMPAIGN_PRESETS[state.preset];
if (presetConfig?.scoringFormula) {
  campaign.config.scoringFormula = presetConfig.scoringFormula;
}
if (presetConfig?.levelThresholds) {
  campaign.config.levelThresholds = presetConfig.levelThresholds;
}
```

---

## Verification

- `npm test` — all existing 590 tests pass
- New infrastructure methods return correct defaults when no scoring config is present (backward compatibility with standard/blitz/endurance presets)
- `CampaignState` toJSON/fromState round-trip preserves new fields
