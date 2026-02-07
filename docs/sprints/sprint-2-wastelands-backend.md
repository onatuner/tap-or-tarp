# Sprint 2: Wastelands Campaign Backend

## Goal
Create the Wastelands preset file, wire damage tracking into `CampaignGameSession`, update state broadcasting, and write tests. After this sprint the full scoring system works server-side.

## Depends On
- Sprint 1 (generic foundation)

## Files Created
- `lib/game-modes/campaign-presets/wastelands.js`
- `__tests__/wastelands.test.js`

## Files Modified
- `lib/game-modes/campaign.js`

---

## Tasks

### 2.1 Create `lib/game-modes/campaign-presets/wastelands.js`

Campaign-specific configuration file containing:

**Preset object:**
```
Name: "The Wastelands"
Description: Post-apocalyptic survival campaign
Rounds: 3
Time per round: 6 minutes (no decrease)
Bonus time: 30 seconds per turn
Win condition: "total_points"
```

**Battle Multipliers** (later battles worth more):
```js
{ 1: 1.0, 2: 1.5, 3: 2.0 }
```

**Player Multipliers** (by count of unique targets damaged):
```js
{ 0: 0, 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0, 6: 3.5, 7: 4.0 }
```

**Level Thresholds** (points needed for levels 2-6):
```js
[10, 25, 50, 80, 120]
```

**Scoring Formula:**
```
previousAccumulatedPoints + floor(roundDamage × playerMult × battleMult)
```

Exported as `wastelandsPreset` object plus individual constants for testing.

### 2.2 Register preset in `campaign.js`

Import the preset and add to `CAMPAIGN_PRESETS`:

```js
const { wastelandsPreset } = require('./campaign-presets/wastelands');
CAMPAIGN_PRESETS.wastelands = wastelandsPreset;
```

### 2.3 Override `onPlayerLifeChanged` in `CampaignGameSession`

```
- If newLife >= oldLife → return (healing, not damage)
- If status !== 'running' → return
- damage = oldLife - newLife
- actingPlayerId = this.getActingPlayerId()
- If actingPlayerId === targetPlayerId or null → return (self-damage or no actor)
- this.campaign.recordDamage(actingPlayerId, targetPlayerId, damage)
- this.campaign.recalculateAllScores()
```

No extra `broadcastState()` needed — `updatePlayer()` already broadcasts after calling the hook.

### 2.4 Modify `onGameComplete` in `CampaignGameSession`

Add `this.campaign.finalizeRoundScoring()` before the existing `this.campaign.recordRound()` call. This ensures points are finalized and damage tracker is reset before the round is recorded.

### 2.5 Apply preset bonus time in `CampaignGameSession` constructor

After initializing the campaign, apply preset-specific bonus time:

```js
if (this.campaign.config.bonusTime !== undefined) {
  this.settings.bonusTime = this.campaign.config.bonusTime;
}
```

### 2.6 Update `getState()` in `CampaignGameSession`

Include scoring data in the broadcast campaign object:

```js
campaign: {
  currentRound: ...,
  maxRounds: ...,
  playerStats: ...,
  config: {
    name, description, rounds, winCondition, winTarget,
    battleMultipliers: ... || null,
    playerMultipliers: ... || null,
  },
  status: ...,
  damageTracker: ...,
  playerPoints: ...,
  playerLevels: ...,
}
```

Exclude function references (`scoringFormula`, `levelThresholds`) — they are not JSON-serializable.

### 2.7 Write tests (`__tests__/wastelands.test.js`)

| Test Case | Description |
|-----------|-------------|
| Damage recording | Life decrease credits active player |
| Healing ignored | Life increase does not record damage |
| Self-damage ignored | Active player changing own life not recorded |
| No actor ignored | Damage with no active player not recorded |
| Interrupt attribution | Interrupting player gets damage credit |
| Targeting attribution | Original active player gets credit during resolution |
| Player multiplier | Scales with unique target count |
| Battle multiplier | Scales with round number |
| Scoring formula | Correct calculation with various combos |
| Level thresholds | Points map to correct levels |
| Points across rounds | `finalizeRoundScoring` preserves accumulated points, resets damage tracker |
| Serialization round-trip | `toJSON()` → `fromState()` preserves all scoring data, re-attaches functions |
| `total_points` win condition | After 3 rounds, highest points player wins |
| Backward compatibility | Standard/blitz/endurance presets unaffected (no scoring, defaults to 0/1) |

---

## Verification

- `npm test` — all existing tests pass + new wastelands tests pass
- Create a Wastelands campaign session, simulate life changes, verify damage tracker and points update correctly
- Verify `onGameComplete` → `finalizeRoundScoring` → `prepareNextRound` flow preserves accumulated points
