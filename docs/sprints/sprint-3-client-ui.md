# Sprint 3: Client UI for Campaign Stats

## Goal
Display campaign scoring data (level, points, multiplier, battle progress) to players during Wastelands games. Hidden for non-scoring campaigns.

## Depends On
- Sprint 2 (Wastelands backend — state broadcasting includes scoring data)

## Files Modified
- `public/index.html`
- `public/client.js`
- `public/style.css`

---

## Tasks

### 3.1 Add campaign stats HTML to `public/index.html`

Insert a `.game-campaign-stats` row inside `.game-player-stats` (between the name row at line 248 and the stats row at line 253). Hidden by default:

```html
<div class="game-campaign-stats" style="display: none">
  <div class="game-campaign-stat" data-stat="level">
    <span class="game-campaign-stat-label">Lv</span>
    <span class="game-campaign-stat-value">1</span>
  </div>
  <div class="game-campaign-stat" data-stat="points">
    <span class="game-campaign-stat-label">Pts</span>
    <span class="game-campaign-stat-value">0</span>
  </div>
  <div class="game-campaign-stat" data-stat="multiplier">
    <span class="game-campaign-stat-label">Mult</span>
    <span class="game-campaign-stat-value">1.0x</span>
  </div>
  <div class="game-campaign-stat" data-stat="battle">
    <span class="game-campaign-stat-label">Battle</span>
    <span class="game-campaign-stat-value">1/3</span>
  </div>
</div>
```

### 3.2 Add `gameUI` reference in `public/client.js`

Add to the `gameUI` object (around line 243):

```js
campaignStats: document.querySelector(".game-campaign-stats"),
```

### 3.3 Add `updateCampaignStats()` function in `public/client.js`

Logic:
1. If not campaign mode or no campaign data → hide and return
2. If no claimed player (`myPlayer`) → hide and return
3. Show the element
4. Update each stat chip:
   - **Level:** `campaign.playerLevels[myPlayer.id]` (default 1)
   - **Points:** `campaign.playerPoints[myPlayer.id]` (default 0)
   - **Multiplier:** Calculate effective multiplier = playerMult × battleMult using `campaign.config.playerMultipliers`, `campaign.config.battleMultipliers`, `campaign.damageTracker`, and `campaign.currentRound`
   - **Battle:** `campaign.currentRound / campaign.maxRounds`
5. Use existing `updateStatValue()` for animated value transitions

### 3.4 Wire into `updateGameUI()` in `public/client.js`

Call `updateCampaignStats()` after `updatePlayerStats()` (around line 2997):

```js
updatePlayerStats();
updateCampaignStats();
```

### 3.5 Add CSS styles to `public/style.css`

Follow existing patterns from `.game-stats-row` (line 2658):

```css
.game-campaign-stats {
  display: flex;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.game-campaign-stat {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px var(--spacing-xs);
  background: rgba(255, 255, 255, 0.05);
  border-radius: var(--radius-sm);
  font-size: 0.85em;
}

.game-campaign-stat-label {
  color: #888;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.7em;
}

.game-campaign-stat-value {
  color: #fff;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
```

Add responsive overrides matching existing landscape (max-height: 500px) and desktop (min-width: 769px) breakpoints.

---

## Verification

- Campaign stats row is **hidden** during casual games and non-scoring campaigns (standard, blitz, endurance)
- Campaign stats row is **visible** during Wastelands games
- Level, points, multiplier, battle progress update live as damage occurs
- Stats animate on value change using existing `updateStatValue()` pattern
- Layout looks correct on mobile portrait, mobile landscape, and desktop
- Spectators (no claimed player) do not see the campaign stats row
