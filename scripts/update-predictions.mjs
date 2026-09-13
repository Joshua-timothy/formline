import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'data', 'predictions.json');
const today = new Date().toISOString().slice(0, 10);
const forecastEnd = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const startYear = new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 1 : 0);
const season = `${startYear}-${String(startYear + 1).slice(-2)}`;
const previousSeason = `${startYear - 1}-${String(startYear).slice(-2)}`;
const twoSeasonsAgo = `${startYear - 2}-${String(startYear - 1).slice(-2)}`;

const leagues = [
  ['PL', 'Premier League', 'en.1', 'E0'],
  ['LL', 'La Liga', 'es.1', 'SP1'],
  ['SA', 'Serie A', 'it.1', 'I1'],
  ['BL', 'Bundesliga', 'de.1', 'D1'],
  ['L1', 'Ligue 1', 'fr.1', 'F1'],
  ['ED', 'Eredivisie', 'nl.1', 'N1']
];

const urlFor = (seasonKey, code) =>
  `https://raw.githubusercontent.com/openfootball/football.json/master/${seasonKey}/${code}.json`;

const oddsUrlFor = (seasonKey, division) => {
  const [start, end] = seasonKey.split('-');
  return `https://www.football-data.co.uk/mmz4281/${start.slice(-2)}${end}/${division}.csv`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLeague(code, seasonKey) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(urlFor(seasonKey, code), { headers: { 'User-Agent': 'PitchProbability/0.1' } });
      if (response.ok) {
        const payload = await response.json();
        if (!Array.isArray(payload.matches)) throw new Error(`${code} ${seasonKey}: source returned no match list`);
        return payload;
      }
      lastError = new Error(`${code} ${seasonKey}: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) { lastError = error; }
    await sleep(1000 * attempt);
  }
  throw lastError;
}

function parseCsv(text) {
  const rows = [], row = [];
  let field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field); field = '';
      if (row.some((value) => value.length)) rows.push(row.splice(0)); else row.length = 0;
    } else field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() ?? []).map((value) => value.replace(/^\uFEFF/, '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

function oddsDate(value) {
  const [day, month, rawYear] = String(value).trim().split(/[/-]/).map(Number);
  if (!day || !month || !rawYear) return null;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}

// This deliberately removes only common club suffixes. It makes names such as
// "FC Barcelona" / "Barcelona" and "Levante UD" / "Levante" join without
// guessing that different clubs with similar names are the same team.
function teamKey(name) {
  return String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(fc|cf|afc|ac|as|sc|rc|rcd|cd|ud|sd|ss|us|calcio|football club)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// All model state is indexed by this stable identity, while the site continues
// to display the provider's original club name. This prevents a harmless
// seasonal naming change (for example "Barcelona" to "FC Barcelona") from
// making an established club appear to have no history.
const teamId = teamKey;

function oddsValues(row) {
  const priceSets = [
    ['AvgCH', 'AvgCD', 'AvgCA'], ['B365CH', 'B365CD', 'B365CA'],
    ['AvgH', 'AvgD', 'AvgA'], ['B365H', 'B365D', 'B365A']
  ];
  for (const columns of priceSets) {
    const prices = columns.map((column) => Number(row[column]));
    if (prices.every((price) => Number.isFinite(price) && price > 1.01 && price < 100)) {
      const implied = prices.map((price) => 1 / price);
      const total = implied.reduce((sum, value) => sum + value, 0);
      return implied.map((value) => value / total);
    }
  }
  return null;
}

function sourceXg(row) {
  const values = [Number(row.HxG), Number(row.AxG)];
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 8) ? values : null;
}

async function getOdds(division, seasonKey) {
  const response = await fetch(oddsUrlFor(seasonKey, division), { headers: { 'User-Agent': 'PitchProbability/0.1' } });
  if (!response.ok) throw new Error(`${division} ${seasonKey}: odds HTTP ${response.status}`);
  return parseCsv(await response.text()).flatMap((row) => {
    const date = oddsDate(row.Date), probabilities = oddsValues(row);
    if (!date || !row.HomeTeam || !row.AwayTeam || !probabilities) return [];
    return [{ date, home: teamKey(row.HomeTeam), away: teamKey(row.AwayTeam), probabilities, xg: sourceXg(row) }];
  });
}

function oddsIndex(rows) {
  const index = new Map();
  for (const row of rows.flat()) index.set(`${row.date}|${row.home}|${row.away}`, row);
  return index;
}

function sourceRecord(match, index) {
  if (!index?.size) return null;
  const home = teamKey(match.team1), away = teamKey(match.team2);
  const fixture = new Date(`${match.date}T00:00:00Z`);
  for (const shift of [0, -1, 1]) {
    const date = new Date(fixture.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
    const found = index.get(`${date}|${home}|${away}`);
    if (found) return found;
  }
  return null;
}

function marketProbabilities(match, index) {
  return sourceRecord(match, index)?.probabilities ?? null;
}

function enrichMatches(matches, index) {
  return matches.map((match) => {
    const xg = sourceRecord(match, index)?.xg;
    return xg ? { ...match, sourceXg: xg } : match;
  });
}

function finalScore(match) {
  const score = match.score?.ft ?? match.score;
  if (!Array.isArray(score) || score.length !== 2 || !score.every(Number.isFinite)) return null;
  return score;
}

function performanceScore(match) {
  const score = finalScore(match);
  if (!score) return null;
  // Results remain the truth for outcomes; pre-calculated match xG is used only
  // as a limited performance signal. It reduces the impact of one-off scorelines
  // while allowing current chance creation to surface earlier in the season.
  if (!Array.isArray(match.sourceXg)) return score;
  return score.map((value, index) => value * 0.52 + match.sourceXg[index] * 0.48);
}

function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function market(selection, probability) {
  return { selection, probability: Math.round(probability * 1000) / 10 };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const seasonKey = (date) => {
  const value = new Date(`${date}T00:00:00Z`);
  return value.getUTCFullYear() - (value.getUTCMonth() < 6 ? 1 : 0);
};

function historicalWeight(date, asOf) {
  const daysAgo = Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const seasonsBack = Math.max(0, seasonKey(asOf) - seasonKey(date));
  const seasonWeight = [2.4, 0.55, 0.14][seasonsBack] ?? 0.06;
  return seasonWeight * Math.exp(-daysAgo / 165);
}

function buildStats(matches, asOf, fitIterations = 90) {
  const completed = matches.filter((match) => finalScore(match) && match.date < asOf).sort((a, b) => a.date.localeCompare(b.date));
  const observations = completed.map((match) => ({ match, score: performanceScore(match), weight: historicalWeight(match.date, asOf) }));
  const totalWeight = observations.reduce((total, item) => total + item.weight, 0) || 1;
  const homeGoals = observations.reduce((total, item) => total + item.score[0] * item.weight, 0) / totalWeight || 1.45;
  const awayGoals = observations.reduce((total, item) => total + item.score[1] * item.weight, 0) / totalWeight || 1.15;
  const names = new Set(completed.flatMap((match) => [teamId(match.team1), teamId(match.team2)]));
  const attack = new Map([...names].map((team) => [team, 0]));
  const defense = new Map([...names].map((team) => [team, 0]));
  const homeEdge = new Map([...names].map((team) => [team, 0]));
  const teamProfile = new Map();
  const teamFixtures = new Map();
  const profileFor = (team) => teamProfile.get(team) ?? { currentGames: 0, previousSeasonGames: 0, olderGames: 0, homeWeight: 0, awayWeight: 0 };
  const fixturesFor = (team) => teamFixtures.get(team) ?? [];
  for (const { match, weight } of observations) {
    const current = seasonKey(match.date) === seasonKey(asOf);
    for (const [team, venue] of [[teamId(match.team1), 'homeWeight'], [teamId(match.team2), 'awayWeight']]) {
      const profile = profileFor(team);
      if (current) profile.currentGames += 1;
      else if (seasonKey(match.date) === seasonKey(asOf) - 1) profile.previousSeasonGames += 1;
      else profile.olderGames += 1;
      profile[venue] += weight;
      teamProfile.set(team, profile);
      teamFixtures.set(team, [...fixturesFor(team), match.date]);
    }
  }
  const teamReliability = (team) => {
    const profile = profileFor(team);
    const current = profile.currentGames / (profile.currentGames + 6);
    const prior = profile.previousSeasonGames / (profile.previousSeasonGames + 18);
    const reliability = clamp(0.08 + current * 0.58 + prior * 0.34, 0.12, 0.9);
    return profile.previousSeasonGames < 5 ? reliability * 0.68 : reliability;
  };
  const isPromoted = (team) => profileFor(team).previousSeasonGames < 5;
  const divisionTransition = (team) => {
    const profile = profileFor(team);
    if (profile.previousSeasonGames >= 5) return 0;
    // A promoted side's top-flight attack and defensive quality begin below
    // the established-league prior, then earn their way out over roughly the
    // first third of a season. This is a population prior, not a team rule.
    return clamp(0.2 * (1 - profile.currentGames / 12), 0.06, 0.2);
  };
  const promotedSignalReliability = (team) => isPromoted(team)
    ? clamp(teamReliability(team) * 1.2, 0.16, 0.72)
    : 1;
  const edgeReliability = (team) => {
    const profile = profileFor(team);
    const balancedSample = Math.min(profile.homeWeight, profile.awayWeight);
    return clamp(balancedSample / (balancedSample + 9), 0, 0.58) * (profile.previousSeasonGames < 5 ? 0.65 : 1);
  };
  const change = (map, team, amount) => map.set(team, clamp((map.get(team) ?? 0) + amount, -0.9, 0.9));

  // Penalised, opponent-adjusted Poisson fitting. Team home edge is intentionally
  // constrained and only survives when both home and away samples support it.
  for (let iteration = 0; iteration < fitIterations; iteration++) {
    const attackGradient = new Map(), defenseGradient = new Map(), homeEdgeGradient = new Map();
    const add = (map, team, value) => map.set(team, (map.get(team) ?? 0) + value);
    for (const { match, score, weight } of observations) {
      const homeTeam = teamId(match.team1), awayTeam = teamId(match.team2);
      const edge = homeEdge.get(homeTeam) ?? 0;
      const expectedHome = clamp(homeGoals * Math.exp((attack.get(homeTeam) ?? 0) - (defense.get(awayTeam) ?? 0) + edge * 0.55), 0.2, 4.5);
      const expectedAway = clamp(awayGoals * Math.exp((attack.get(awayTeam) ?? 0) - (defense.get(homeTeam) ?? 0) - edge * 0.25), 0.2, 4.5);
      const homeResidual = weight * (score[0] - expectedHome), awayResidual = weight * (score[1] - expectedAway);
      add(attackGradient, homeTeam, homeResidual); add(defenseGradient, awayTeam, -homeResidual);
      add(attackGradient, awayTeam, awayResidual); add(defenseGradient, homeTeam, -awayResidual);
      add(homeEdgeGradient, homeTeam, homeResidual * 0.55 - awayResidual * 0.25);
    }
    for (const team of names) {
      change(attack, team, 0.38 * ((attackGradient.get(team) ?? 0) / totalWeight - 0.36 * (attack.get(team) ?? 0)));
      change(defense, team, 0.38 * ((defenseGradient.get(team) ?? 0) / totalWeight - 0.36 * (defense.get(team) ?? 0)));
      homeEdge.set(team, clamp((homeEdge.get(team) ?? 0) + 0.18 * ((homeEdgeGradient.get(team) ?? 0) / totalWeight - 1.45 * (homeEdge.get(team) ?? 0)), -0.22, 0.22));
    }
  }
  for (const team of names) homeEdge.set(team, clamp((homeEdge.get(team) ?? 0) * edgeReliability(team), -0.12, 0.12));

  const ratings = new Map(), lastPlayed = new Map();
  // A promoted side begins below the established-league prior rather than at
  // league average. This population-level division-transition prior is then
  // updated by every result; it is not a fixture-specific override.
  const rating = (team) => ratings.get(team) ?? (isPromoted(team) ? 1465 : 1500);
  let activeSeason;
  for (const match of completed) {
    const matchSeason = seasonKey(match.date);
    if (activeSeason !== undefined && matchSeason !== activeSeason) {
      for (const [team, value] of ratings) ratings.set(team, 1500 + (value - 1500) * 0.82);
    }
    activeSeason = matchSeason;
    const homeTeam = teamId(match.team1), awayTeam = teamId(match.team2);
    const [home, away] = finalScore(match), homeRating = rating(homeTeam), awayRating = rating(awayTeam);
    const expectedHome = 1 / (1 + Math.pow(10, -(homeRating + 58 - awayRating) / 400));
    const actualHome = home > away ? 1 : home === away ? 0.5 : 0;
    const goalMargin = Math.min(3, Math.abs(home - away));
    const k = 18 + goalMargin * 3;
    ratings.set(homeTeam, homeRating + k * (actualHome - expectedHome));
    ratings.set(awayTeam, awayRating - k * (actualHome - expectedHome));
    lastPlayed.set(homeTeam, match.date); lastPlayed.set(awayTeam, match.date);
  }

  const form = new Map();
  const addForm = (team, attackResidual, defenseResidual, weight) => {
    const value = form.get(team) ?? { attack: 0, defense: 0, games: 0, weight: 0 };
    if (value.games < 6) {
      value.attack += attackResidual * weight; value.defense += defenseResidual * weight;
      value.games += 1; value.weight += weight; form.set(team, value);
    }
  };
  for (const match of [...completed].reverse()) {
    const [home, away] = performanceScore(match);
    const homeTeam = teamId(match.team1), awayTeam = teamId(match.team2);
    const expectedHome = clamp(homeGoals * Math.exp((attack.get(homeTeam) ?? 0) - (defense.get(awayTeam) ?? 0)), 0.2, 4.5);
    const expectedAway = clamp(awayGoals * Math.exp((attack.get(awayTeam) ?? 0) - (defense.get(homeTeam) ?? 0)), 0.2, 4.5);
    const daysAgo = Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${match.date}T00:00:00Z`)) / 86_400_000);
    const recency = Math.exp(-daysAgo / 55);
    addForm(homeTeam, Math.log((home + 0.65) / (expectedHome + 0.65)), Math.log((away + 0.65) / (expectedAway + 0.65)), recency);
    addForm(awayTeam, Math.log((away + 0.65) / (expectedAway + 0.65)), Math.log((home + 0.65) / (expectedHome + 0.65)), recency);
  }
  for (const value of form.values()) {
    const shrinkage = value.weight / (value.weight + 2.2);
    value.attack = clamp((value.attack / value.weight) * shrinkage, -0.35, 0.35);
    value.defense = clamp((value.defense / value.weight) * shrinkage, -0.35, 0.35);
  }
  const currentPerformance = new Map();
  const addCurrentPerformance = (team, attack, defense, weight) => {
    const value = currentPerformance.get(team) ?? { attack: 0, defense: 0, weight: 0, games: 0 };
    if (value.games < 6) {
      value.attack += attack * weight; value.defense += defense * weight;
      value.weight += weight; value.games += 1; currentPerformance.set(team, value);
    }
  };
  for (const match of [...completed].reverse()) {
    if (seasonKey(match.date) !== seasonKey(asOf)) continue;
    const [home, away] = performanceScore(match);
    const homeTeam = teamId(match.team1), awayTeam = teamId(match.team2);
    const daysAgo = Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${match.date}T00:00:00Z`)) / 86_400_000);
    const recency = Math.exp(-daysAgo / 48);
    addCurrentPerformance(homeTeam, Math.log((home + 0.5) / (homeGoals + 0.5)), Math.log((away + 0.5) / (awayGoals + 0.5)), recency);
    addCurrentPerformance(awayTeam, Math.log((away + 0.5) / (awayGoals + 0.5)), Math.log((home + 0.5) / (homeGoals + 0.5)), recency);
  }
  for (const value of currentPerformance.values()) {
    // Four to six matches can meaningfully move a forecast, but cannot erase
    // the established multi-season rating after one exceptional scoreline.
    const shrinkage = value.weight / (value.weight + 3.1);
    value.attack = clamp((value.attack / value.weight) * shrinkage, -0.52, 0.52);
    value.defense = clamp((value.defense / value.weight) * shrinkage, -0.52, 0.52);
  }
  const currentFormReliability = (team) => {
    const value = currentPerformance.get(team);
    return value ? clamp(value.weight / (value.weight + 3.1), 0, 0.72) : 0;
  };
  const currentXg = new Map();
  const addCurrentXg = (team, attack, defense, weight) => {
    const value = currentXg.get(team) ?? { attack: 0, defense: 0, weight: 0, games: 0 };
    if (value.games < 5) {
      value.attack += attack * weight; value.defense += defense * weight;
      value.weight += weight; value.games += 1; currentXg.set(team, value);
    }
  };
  for (const match of [...completed].reverse()) {
    if (seasonKey(match.date) !== seasonKey(asOf) || !Array.isArray(match.sourceXg)) continue;
    const homeTeam = teamId(match.team1), awayTeam = teamId(match.team2);
    const daysAgo = Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${match.date}T00:00:00Z`)) / 86_400_000);
    const recency = Math.exp(-daysAgo / 42);
    addCurrentXg(homeTeam, Math.log((match.sourceXg[0] + 0.35) / (homeGoals + 0.35)), Math.log((match.sourceXg[1] + 0.35) / (awayGoals + 0.35)), recency);
    addCurrentXg(awayTeam, Math.log((match.sourceXg[1] + 0.35) / (awayGoals + 0.35)), Math.log((match.sourceXg[0] + 0.35) / (homeGoals + 0.35)), recency);
  }
  for (const value of currentXg.values()) {
    const shrinkage = value.weight / (value.weight + 2.4);
    value.attack = clamp((value.attack / value.weight) * shrinkage, -0.42, 0.42);
    value.defense = clamp((value.defense / value.weight) * shrinkage, -0.42, 0.42);
  }
  const xgReliability = (team) => {
    const value = currentXg.get(team);
    return value ? clamp(value.weight / (value.weight + 2.4), 0, 0.72) : 0;
  };
  const currentTeamCount = [...teamProfile.values()].filter((profile) => profile.currentGames > 0).length || 1;
  const currentMatchday = [...teamProfile.values()].reduce((total, profile) => total + profile.currentGames, 0) / currentTeamCount;
  return { homeGoals, awayGoals, attack, defense, homeEdge, ratings, form, currentPerformance, currentFormReliability, currentXg, xgReliability, lastPlayed, teamFixtures, teamProfile, teamReliability, isPromoted, divisionTransition, promotedSignalReliability, currentMatchday, completed: completed.length };
}

function strengthGoals(home, away, stats) {
  const homeTeam = teamId(home), awayTeam = teamId(away);
  const homeReliability = stats.isPromoted(homeTeam) ? stats.teamReliability(homeTeam) : 1;
  const awayReliability = stats.isPromoted(awayTeam) ? stats.teamReliability(awayTeam) : 1;
  const homeTransition = stats.divisionTransition(homeTeam), awayTransition = stats.divisionTransition(awayTeam);
  const homeAttack = (stats.attack.get(homeTeam) ?? 0) * homeReliability;
  const homeDefense = (stats.defense.get(homeTeam) ?? 0) * homeReliability;
  const awayAttack = (stats.attack.get(awayTeam) ?? 0) * awayReliability;
  const awayDefense = (stats.defense.get(awayTeam) ?? 0) * awayReliability;
  const edge = stats.homeEdge.get(homeTeam) ?? 0;
  return {
    home: clamp(stats.homeGoals * Math.exp(homeAttack - homeTransition - awayDefense + awayTransition * 0.72 + edge * 0.55), 0.25, 4.0),
    away: clamp(stats.awayGoals * Math.exp(awayAttack - awayTransition - homeDefense + homeTransition * 0.72 - edge * 0.25), 0.25, 4.0)
  };
}

function formGoals(home, away, stats) {
  const baseline = strengthGoals(home, away, stats);
  const homeTeam = teamId(home), awayTeam = teamId(away);
  const h = stats.form.get(homeTeam) ?? { attack: 0, defense: 0 };
  const a = stats.form.get(awayTeam) ?? { attack: 0, defense: 0 };
  const hp = stats.currentPerformance.get(homeTeam) ?? { attack: 0, defense: 0 };
  const ap = stats.currentPerformance.get(awayTeam) ?? { attack: 0, defense: 0 };
  const hx = stats.currentXg.get(homeTeam) ?? { attack: 0, defense: 0 };
  const ax = stats.currentXg.get(awayTeam) ?? { attack: 0, defense: 0 };
  const homeReliability = stats.teamReliability(homeTeam), awayReliability = stats.teamReliability(awayTeam);
  const homeFormReliability = stats.currentFormReliability(homeTeam) * stats.promotedSignalReliability(homeTeam), awayFormReliability = stats.currentFormReliability(awayTeam) * stats.promotedSignalReliability(awayTeam);
  const homeXgReliability = stats.xgReliability(homeTeam) * stats.promotedSignalReliability(homeTeam), awayXgReliability = stats.xgReliability(awayTeam) * stats.promotedSignalReliability(awayTeam);
  return {
    home: clamp(baseline.home * Math.exp(h.attack * homeReliability - a.defense * awayReliability + 1.08 * (hp.attack * homeFormReliability - ap.defense * awayFormReliability) + 0.72 * (hx.attack * homeXgReliability - ax.defense * awayXgReliability)), 0.25, 4.0),
    away: clamp(baseline.away * Math.exp(a.attack * awayReliability - h.defense * homeReliability + 1.08 * (ap.attack * awayFormReliability - hp.defense * homeFormReliability) + 0.72 * (ax.attack * awayXgReliability - hx.defense * homeXgReliability)), 0.25, 4.0)
  };
}

function currentPerformanceGoals(home, away, stats) {
  const baseline = strengthGoals(home, away, stats);
  const homeTeam = teamId(home), awayTeam = teamId(away);
  const hp = stats.currentPerformance.get(homeTeam) ?? { attack: 0, defense: 0 };
  const ap = stats.currentPerformance.get(awayTeam) ?? { attack: 0, defense: 0 };
  const hx = stats.currentXg.get(homeTeam) ?? { attack: 0, defense: 0 };
  const ax = stats.currentXg.get(awayTeam) ?? { attack: 0, defense: 0 };
  const homeFormReliability = stats.currentFormReliability(homeTeam) * stats.promotedSignalReliability(homeTeam), awayFormReliability = stats.currentFormReliability(awayTeam) * stats.promotedSignalReliability(awayTeam);
  const homeXgReliability = stats.xgReliability(homeTeam) * stats.promotedSignalReliability(homeTeam), awayXgReliability = stats.xgReliability(awayTeam) * stats.promotedSignalReliability(awayTeam);
  return {
    home: clamp(baseline.home * Math.exp(1.32 * (hp.attack * homeFormReliability - ap.defense * awayFormReliability) + 0.9 * (hx.attack * homeXgReliability - ax.defense * awayXgReliability)), 0.25, 4.0),
    away: clamp(baseline.away * Math.exp(1.32 * (ap.attack * awayFormReliability - hp.defense * homeFormReliability) + 0.9 * (ax.attack * awayXgReliability - hx.defense * homeXgReliability)), 0.25, 4.0)
  };
}

function eloGoals(home, away, stats) {
  const homeTeam = teamId(home), awayTeam = teamId(away);
  const homeRating = stats.ratings.get(homeTeam) ?? 1500, awayRating = stats.ratings.get(awayTeam) ?? 1500;
  const ratingDifference = homeRating - awayRating;
  const teamHomeEdge = (stats.homeEdge.get(homeTeam) ?? 0) * 85;
  const homeWinStrength = 1 / (1 + Math.pow(10, -(ratingDifference + 58 + teamHomeEdge) / 400));
  const totalGoals = stats.homeGoals + stats.awayGoals;
  const homeShare = clamp(stats.homeGoals / totalGoals + (homeWinStrength - 0.5) * 0.55, 0.2, 0.8);
  return { home: totalGoals * homeShare, away: totalGoals * (1 - homeShare) };
}

function componentGoals(home, away, stats) {
  return { strength: strengthGoals(home, away, stats), form: formGoals(home, away, stats), current: currentPerformanceGoals(home, away, stats), elo: eloGoals(home, away, stats) };
}

function blendGoals(components, weights) {
  return ['home', 'away'].reduce((result, side) => {
    result[side] = ['strength', 'form', 'current', 'elo'].reduce((sum, name) => sum + components[name][side] * weights[name], 0);
    return result;
  }, {});
}

function adaptiveWeights(baseWeights, stats, match) {
  const stage = clamp(stats.currentMatchday / 12, 0, 1);
  const matchupReliability = (stats.teamReliability(teamId(match.team1)) + stats.teamReliability(teamId(match.team2))) / 2;
  const currentFormEvidence = (stats.currentFormReliability(teamId(match.team1)) + stats.currentFormReliability(teamId(match.team2))) / 2;
  const currentXgEvidence = (stats.xgReliability(teamId(match.team1)) + stats.xgReliability(teamId(match.team2))) / 2;
  const multipliers = {
    // Form needs matches to earn influence; stable strength and Elo carry more
    // of the forecast in an early or newly promoted team's first few fixtures.
    strength: 1.22 - stage * 0.2,
    form: 0.45 + stage * 0.75 + currentFormEvidence * 1.25 + currentXgEvidence * 0.42,
    current: 0.22 + currentFormEvidence * 1.65 + currentXgEvidence * 0.85,
    elo: 1.15 - stage * 0.12
  };
  const raw = Object.fromEntries(Object.entries(baseWeights).map(([name, weight]) => [name, weight * multipliers[name]]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return {
    weights: Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, value / total])),
    stage: Number(stage.toFixed(3)),
    matchupReliability: Number(matchupReliability.toFixed(3)),
    currentFormEvidence: Number(currentFormEvidence.toFixed(3)),
    currentXgEvidence: Number(currentXgEvidence.toFixed(3))
  };
}

function restProfile(team, fixtureDate, stats) {
  const fixtureTime = Date.parse(`${fixtureDate}T00:00:00Z`);
  const previous = (stats.teamFixtures.get(teamId(team)) ?? []).filter((date) => Date.parse(`${date}T00:00:00Z`) < fixtureTime);
  const daysSinceLast = previous.length
    ? Math.round((fixtureTime - Date.parse(`${previous.at(-1)}T00:00:00Z`)) / 86_400_000)
    : 7;
  const matchesWithin = (days) => previous.filter((date) => fixtureTime - Date.parse(`${date}T00:00:00Z`) <= days * 86_400_000).length;
  const matches10 = matchesWithin(10);
  const matches21 = matchesWithin(21);
  const shortRest = daysSinceLast <= 2 ? 0.045 : daysSinceLast === 3 ? 0.026 : daysSinceLast === 4 ? 0.011 : 0;
  const congestion = Math.max(0, matches10 - 2) * 0.008 + Math.max(0, matches21 - 4) * 0.005;
  return {
    days: clamp(daysSinceLast, 2, 14),
    matches10,
    matches21,
    fatigue: clamp(shortRest + congestion, 0, 0.06)
  };
}

function applyRestAdjustment(xg, match, stats) {
  const home = restProfile(match.team1, match.date, stats);
  const away = restProfile(match.team2, match.date, stats);
  // Fatigue mainly reduces a team's own attacking output; a smaller defensive
  // vulnerability is passed to the opponent. No bonus is granted for long rest.
  const homeAdjustment = clamp(-home.fatigue * 0.76 + away.fatigue * 0.42, -0.055, 0.04);
  const awayAdjustment = clamp(-away.fatigue * 0.76 + home.fatigue * 0.42, -0.055, 0.04);
  return {
    xg: { home: clamp(xg.home * (1 + homeAdjustment), 0.25, 3.5), away: clamp(xg.away * (1 + awayAdjustment), 0.25, 3.5) },
    rest: { home: home.days, away: away.days, homeFatigue: Number(home.fatigue.toFixed(3)), awayFatigue: Number(away.fatigue.toFixed(3)), homeMatches21: home.matches21, awayMatches21: away.matches21 }
  };
}

function scoreMatrix(xg) {
  let home = 0, draw = 0, away = 0, btts = 0, over15 = 0, over25 = 0, over35 = 0;
  let best = { home: 0, away: 0, probability: 0 };
  const cells = [];
  for (let h = 0; h <= 8; h++) for (let a = 0; a <= 8; a++) {
    let probability = poisson(h, xg.home) * poisson(a, xg.away);
    // Dixon-Coles-style correction: football has slightly more low-score draws than independent Poisson predicts.
    if (h === 0 && a === 0) probability *= 1 - xg.home * xg.away * -0.06;
    if (h === 0 && a === 1) probability *= 1 + xg.home * -0.06;
    if (h === 1 && a === 0) probability *= 1 + xg.away * -0.06;
    if (h === 1 && a === 1) probability *= 1 - -0.06;
    cells.push({ h, a, probability });
  }
  const normalizer = cells.reduce((sum, cell) => sum + cell.probability, 0);
  for (const { h, a, probability: rawProbability } of cells) {
    const probability = rawProbability / normalizer;
    if (h > a) home += probability; else if (h === a) draw += probability; else away += probability;
    if (h > 0 && a > 0) btts += probability;
    if (h + a >= 2) over15 += probability;
    if (h + a >= 3) over25 += probability;
    if (h + a >= 4) over35 += probability;
    if (probability > best.probability) best = { home: h, away: a, probability };
  }
  return { home, draw, away, btts, over15, over25, over35, best };
}

function blendProbabilities(model, market, marketWeight) {
  if (!market || !marketWeight) return model;
  const blended = model.map((value, index) => value * (1 - marketWeight) + market[index] * marketWeight);
  const total = blended.reduce((sum, value) => sum + value, 0);
  return blended.map((value) => value / total);
}

function probabilityScore(predicted, actual) {
  return predicted.reduce((sum, value, index) => sum + Math.pow(value - actual[index], 2), 0) / 3;
}

function predict(match, league, stats, diagnostic, odds) {
  const adaptive = adaptiveWeights(diagnostic?.weights ?? { strength: 0.55, form: 0.22, current: 0.08, elo: 0.15 }, stats, match);
  const weights = adaptive.weights;
  const components = componentGoals(match.team1, match.team2, stats);
  const adjusted = applyRestAdjustment(blendGoals(components, weights), match, stats);
  const xg = adjusted.xg;
  const { home, draw, away, btts, over15, over25, over35, best } = scoreMatrix(xg);
  const marketOdds = marketProbabilities(match, odds);
  const signal = (team) => {
    const value = stats.currentXg.get(teamId(team)) ?? { attack: 0, defense: 0, games: 0 };
    return { attack: Number(value.attack.toFixed(3)), defense: Number(value.defense.toFixed(3)), games: value.games ?? 0, reliability: Number(stats.xgReliability(teamId(team)).toFixed(3)) };
  };
  const marketWeight = marketOdds
    ? clamp((diagnostic?.marketCalibration?.weight ?? 0.35) * (1.08 - adaptive.stage * 0.12), 0.16, 0.65)
    : 0;
  const [resultHome, resultDraw, resultAway] = blendProbabilities([home, draw, away], marketOdds, marketWeight);
  const under15 = 1 - over15, under25 = 1 - over25, under35 = 1 - over35;
  const homeOver15 = 1 - poisson(0, xg.home) - poisson(1, xg.home);
  const awayOver05 = 1 - poisson(0, xg.away);
  const dnbHome = resultHome / (resultHome + resultAway), dnbAway = resultAway / (resultHome + resultAway);
  const result = [['Home', resultHome], ['Draw', resultDraw], ['Away', resultAway]].sort((a, b) => b[1] - a[1])[0];
  const dc = [['1X', resultHome + resultDraw], ['12', resultHome + resultAway], ['X2', resultDraw + resultAway]].sort((a, b) => b[1] - a[1])[0];
  const choose = (yes, no, yesLabel, noLabel) => yes >= no ? [yesLabel, yes] : [noLabel, no];
  return {
    id: `${league.id}-${match.date}-${match.team1}-${match.team2}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    league: league.name, leagueId: league.id, date: match.date, time: match.time ?? 'TBC', home: match.team1, away: match.team2,
    xg: { home: Number(xg.home.toFixed(2)), away: Number(xg.away.toFixed(2)) },
    oneXTwo: {
      home: Math.round(resultHome * 1000) / 10,
      draw: Math.round(resultDraw * 1000) / 10,
      away: Math.round(resultAway * 1000) / 10
    },
    confidence: marketOdds ? 'Market-calibrated model' : diagnostic?.matches >= 120 ? 'Backtested model' : 'Early-season model',
    model: { weights, stage: adaptive.stage, matchupReliability: adaptive.matchupReliability, currentFormEvidence: adaptive.currentFormEvidence, currentXgEvidence: adaptive.currentXgEvidence, currentXgSignal: { home: signal(match.team1), away: signal(match.team2) }, componentXg: Object.fromEntries(Object.entries(components).map(([name, values]) => [name, { home: Number(values.home.toFixed(2)), away: Number(values.away.toFixed(2)) }])), restDays: adjusted.rest, marketCalibration: { available: Boolean(marketOdds), weight: Number(marketWeight.toFixed(3)) }, validation: diagnostic ? { matches: diagnostic.matches, brier: diagnostic.brier, logLoss: diagnostic.logLoss, ece: diagnostic.calibration.ece } : null },
    markets: [
      { name: 'Match result (1X2)', ...market(result[0], result[1]) },
      { name: 'Double chance', ...market(dc[0], dc[1]) },
      { name: 'Draw no bet', ...market(dnbHome >= dnbAway ? 'Home' : 'Away', Math.max(dnbHome, dnbAway)) },
      { name: 'Over / Under 1.5', ...market(...choose(over15, under15, 'Over 1.5', 'Under 1.5')) },
      { name: 'Over / Under 2.5', ...market(...choose(over25, under25, 'Over 2.5', 'Under 2.5')) },
      { name: 'Over / Under 3.5', ...market(...choose(over35, under35, 'Over 3.5', 'Under 3.5')) },
      { name: 'Both teams to score', ...market(...choose(btts, 1 - btts, 'Yes', 'No')) },
      { name: 'Correct score', ...market(`${best.home}-${best.away}`, best.probability) },
      { name: 'Home team goals', ...market(...choose(homeOver15, 1 - homeOver15, 'Over 1.5', 'Under 1.5')) },
      { name: 'Away team goals', ...market(...choose(awayOver05, 1 - awayOver05, 'Over 0.5', 'Under 0.5')) }
    ]
  };
}

function backtest(matches, odds) {
  const completed = matches.filter((match) => finalScore(match) && match.date < today).sort((a, b) => a.date.localeCompare(b.date));
  const start = Math.max(60, Math.floor(completed.length * 0.55));
  const candidates = completed.slice(start);
  // Refit a representative rolling sample rather than every historical match:
  // it keeps the daily GitHub update bounded while preserving chronological,
  // out-of-sample validation across the season.
  const stride = Math.max(1, Math.ceil(candidates.length / 50));
  const sample = candidates.filter((_, index) => index % stride === 0);
  if (!sample.length) return null;
  const brier = { strength: 0, form: 0, current: 0, elo: 0 };
  const observations = [];
  for (const fixture of sample) {
    const stats = buildStats(completed, fixture.date, 32);
    const components = componentGoals(fixture.team1, fixture.team2, stats);
    const [h, a] = finalScore(fixture);
    const actual = [h > a ? 1 : 0, h === a ? 1 : 0, h < a ? 1 : 0];
    const probabilities = {};
    for (const name of ['strength', 'form', 'current', 'elo']) {
      const adjusted = applyRestAdjustment(components[name], fixture, stats).xg;
      const matrix = scoreMatrix(adjusted);
      const values = [matrix.home, matrix.draw, matrix.away];
      probabilities[name] = values;
      brier[name] += values.reduce((sum, value, index) => sum + Math.pow(value - actual[index], 2), 0) / 3;
    }
    observations.push({ components, fixture, stats, actual, probabilities });
  }
  const componentBrier = Object.fromEntries(Object.entries(brier).map(([name, score]) => [name, score / sample.length]));
  const ensemblePrior = { strength: 1.8, form: 0.8, current: 0.72, elo: 0.55 };
  const inverse = ['strength', 'form', 'current', 'elo'].map((name) => [name, ensemblePrior[name] / (componentBrier[name] + 0.01)]);
  const totalInverse = inverse.reduce((sum, [, value]) => sum + value, 0);
  const rawWeights = Object.fromEntries(inverse.map(([name, value]) => [name, value / totalInverse]));
  const modelObservations = [];
  for (const observation of observations) {
    const weights = adaptiveWeights(rawWeights, observation.stats, observation.fixture).weights;
    const xg = applyRestAdjustment(blendGoals(observation.components, weights), observation.fixture, observation.stats).xg;
    const matrix = scoreMatrix(xg);
    modelObservations.push({ ...observation, predicted: [matrix.home, matrix.draw, matrix.away], market: marketProbabilities(observation.fixture, odds) });
  }
  const matchedMarket = modelObservations.filter((observation) => observation.market);
  let marketCalibration = { matches: 0, coverage: 0, weight: 0 };
  if (matchedMarket.length >= 9) {
    const candidates = Array.from({ length: 14 }, (_, index) => index * 0.05);
    const scored = candidates.map((weight) => ({
      weight,
      brier: matchedMarket.reduce((sum, observation) => sum + probabilityScore(blendProbabilities(observation.predicted, observation.market, weight), observation.actual), 0) / matchedMarket.length
    }));
    const best = scored.reduce((winner, candidate) => candidate.brier < winner.brier ? candidate : winner);
    // The historical optimum is shrunk to a modest 35% market influence. This
    // avoids overfitting one season or blindly copying a single bookmaker.
    const reliability = matchedMarket.length / (matchedMarket.length + 90);
    const weight = clamp(0.35 + (best.weight - 0.35) * reliability, 0.18, 0.65);
    marketCalibration = {
      matches: matchedMarket.length,
      coverage: matchedMarket.length / sample.length,
      weight: Number(weight.toFixed(3)),
      modelBrier: Number((matchedMarket.reduce((sum, observation) => sum + probabilityScore(observation.predicted, observation.actual), 0) / matchedMarket.length).toFixed(3)),
      blendedBrier: Number((matchedMarket.reduce((sum, observation) => sum + probabilityScore(blendProbabilities(observation.predicted, observation.market, weight), observation.actual), 0) / matchedMarket.length).toFixed(3))
    };
  }
  let brierScore = 0, logLoss = 0, correct = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, confidence: 0, correct: 0 }));
  for (const observation of modelObservations) {
    const predicted = blendProbabilities(observation.predicted, observation.market, marketCalibration.weight);
    const outcome = observation.actual.indexOf(1);
    brierScore += predicted.reduce((sum, value, index) => sum + Math.pow(value - observation.actual[index], 2), 0) / 3;
    logLoss -= Math.log(Math.max(predicted[outcome], 1e-12));
    const confidence = Math.max(...predicted);
    const chosen = predicted.indexOf(confidence);
    correct += chosen === outcome ? 1 : 0;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))];
    bin.count += 1; bin.confidence += confidence; bin.correct += chosen === outcome ? 1 : 0;
  }
  const ece = bins.reduce((total, bin) => bin.count ? total + (bin.count / sample.length) * Math.abs(bin.confidence / bin.count - bin.correct / bin.count) : total, 0);
  const weights = Object.fromEntries(Object.entries(rawWeights).map(([name, value]) => [name, Math.round(value * 1000) / 1000]));
  const components = Object.fromEntries(Object.entries(componentBrier).map(([name, value]) => [name, Math.round(value * 1000) / 1000]));
  return { matches: sample.length, accuracy: Math.round((correct / sample.length) * 1000) / 10, brier: Math.round((brierScore / sample.length) * 1000) / 1000, logLoss: Math.round((logLoss / sample.length) * 1000) / 1000, calibration: { ece: Math.round(ece * 1000) / 1000 }, components, weights, marketCalibration };
}

const results = [];
for (const [id, name, code, oddsDivision] of leagues) {
  try {
    const [current, previous, older, currentOdds, previousOdds, olderOdds] = await Promise.all([
      getLeague(code, season), getLeague(code, previousSeason), getLeague(code, twoSeasonsAgo),
      getOdds(oddsDivision, season).catch(() => []), getOdds(oddsDivision, previousSeason).catch(() => []), getOdds(oddsDivision, twoSeasonsAgo).catch(() => [])
    ]);
    const odds = oddsIndex([olderOdds, previousOdds, currentOdds]);
    const history = enrichMatches([...(older.matches ?? []), ...(previous.matches ?? []), ...(current.matches ?? [])], odds);
    const stats = buildStats(history, today);
    const diagnostic = backtest(history, odds);
    const upcoming = (current.matches ?? []).filter((match) => match.date >= today && match.date <= forecastEnd && !finalScore(match));
    results.push({ id, name, predictions: upcoming.map((match) => predict(match, { id, name }, stats, diagnostic, odds)), diagnostic, error: null });
  } catch (error) {
    console.error(`Unable to refresh ${name}: ${error.message}`);
    results.push({ id, name, predictions: [], diagnostic: null, error: error.message });
  }
}

const payload = {
  generatedAt: new Date().toISOString(), season, source: 'OpenFootball public match data, calibrated with football-data.co.uk public pre-match odds when a fixture is matched',
  methodology: 'Opponent-adjusted Poisson attack and defence ratings use time-decayed results, current-season weighting, and strong small-sample regularisation. A team-specific home edge is fitted with heavy shrinkage toward league average. Established clubs retain their multi-season evidence, while promoted teams receive a conservative division-transition prior until enough top-flight matches are played. Residual form is opponent-adjusted, rest accounts non-linearly for short turnaround and 10/21-day congestion, and season-regressed Elo plus ensemble weights adapt to matchweek evidence. Final 1X2 probabilities combine the low-score-corrected Poisson forecast with normalized public pre-match market probabilities only when matching odds are available; the blend weight is selected from out-of-sample historical results and shrunk to prevent overfitting. Fixtures without a reliable market match use the statistical model alone.',
  leagues: results.map(({ id, name, error, diagnostic }) => ({ id, name, error, diagnostic })),
  predictions: results.flatMap((result) => result.predictions).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
};
const ids = payload.predictions.map((prediction) => prediction.id);
const failedLeagues = payload.leagues.filter((league) => league.error);
if (new Set(ids).size !== ids.length) throw new Error('Refusing to publish a feed with duplicate fixture IDs.');
if (payload.predictions.some((prediction) => !Number.isFinite(prediction.xg.home) || !Number.isFinite(prediction.xg.away))) throw new Error('Refusing to publish a feed with invalid expected-goal values.');
if (payload.predictions.some((prediction) => {
  const values = Object.values(prediction.oneXTwo ?? {});
  return values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0 || value > 100) || Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) > 0.2;
})) throw new Error('Refusing to publish a feed with invalid 1X2 probabilities.');
if (!payload.predictions.length && failedLeagues.length) {
  throw new Error(`Refusing to replace the last good feed: no predictions were produced and ${failedLeagues.length} source${failedLeagues.length === 1 ? '' : 's'} failed.`);
}
await mkdir(path.dirname(output), { recursive: true });
const temporaryOutput = `${output}.next`;
await writeFile(temporaryOutput, JSON.stringify(payload, null, 2));
await rename(temporaryOutput, output);
console.log(`Wrote ${payload.predictions.length} predictions for ${season} to ${output}`);
