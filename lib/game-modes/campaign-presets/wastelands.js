/**
 * The Wastelands Campaign Preset
 *
 * Post-apocalyptic survival campaign where players battle for resources.
 * Damage dealt to other players earns points, scaled by multipliers.
 * After 3 battles, the player with the most points wins.
 */

const BATTLE_MULTIPLIERS = { 1: 1.0, 2: 1.5, 3: 2.0 };

const PLAYER_MULTIPLIERS = {
  0: 0,
  1: 1.0,
  2: 1.5,
  3: 2.0,
  4: 2.5,
  5: 3.0,
  6: 3.5,
  7: 4.0,
};

const LEVEL_THRESHOLDS = [10, 25, 50, 80, 120];

/**
 * Scoring formula: accumulatedPoints + floor(roundDamage * playerMult * battleMult)
 * @param {CampaignState} campaign
 * @param {number} playerId
 * @returns {number}
 */
function scoringFormula(campaign, playerId) {
  const accumulated = campaign.playerStats[playerId]?.accumulatedPoints || 0;
  const roundDamage = campaign.getTotalDamage(playerId);
  const uniqueTargets = campaign.getUniqueDamagedCount(playerId);
  const playerMult = PLAYER_MULTIPLIERS[uniqueTargets] ?? PLAYER_MULTIPLIERS[7];
  const battleMult = BATTLE_MULTIPLIERS[campaign.currentRound] ?? 1.0;
  return accumulated + Math.floor(roundDamage * playerMult * battleMult);
}

const wastelandsPreset = {
  name: "The Wastelands",
  description: "Post-apocalyptic survival campaign",
  rounds: 3,
  timePerRound: 6 * 60 * 1000,
  timeDecreasePerRound: 0,
  minTime: 6 * 60 * 1000,
  bonusTime: 30 * 1000,
  startingLife: 10,
  startingHandSize: 5,
  handSizeIncrement: 1,
  winCondition: "total_points",
  winTarget: null,
  battleMultipliers: BATTLE_MULTIPLIERS,
  playerMultipliers: PLAYER_MULTIPLIERS,
  levelThresholds: LEVEL_THRESHOLDS,
  scoringFormula,
};

module.exports = {
  wastelandsPreset,
  BATTLE_MULTIPLIERS,
  PLAYER_MULTIPLIERS,
  LEVEL_THRESHOLDS,
  scoringFormula,
};
