import { mkdir, writeFile } from 'node:fs/promises';
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
  ['PL', 'Premier League', 'en.1'],
  ['LL', 'La Liga', 'es.1'],
  ['SA', 'Serie A', 'it.1'],
  ['BL', 'Bundesliga', 'de.1'],
  ['L1', 'Ligue 1', 'fr.1'],
  ['ED', 'Eredivisie', 'nl.1']
];

const urlFor = (seasonKey, code) =>
  `https://raw.githubusercontent.com/openfootball/football.json/master/${seasonKey}/${code}.json`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLeague(code, seasonKey) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(urlFor(seasonKey, code), { headers: { 'User-Agent': 'PitchProbability/0.1' } });
      if (response.ok) return response.json();
      lastError = new Error(`${code} ${seasonKey}: HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) { lastError = error; }
    await sleep(1000 * attempt);
  }
  throw lastError;
}

function finalScore(match) {
  const score = match.score?.ft ?? match.score;
  if (!Array.isArray(score) || score.length !== 2 || !score.every(Number.isFinite)) return null;
  return score;
}

function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function market(selection, probability) {
  return { selection, probability: Math.round(probability * 1000) / 10 };
}

function buildStats(matches, asOf) {
  const completed = matches.filter((match) => finalScore(match) && match.date < asOf).sort((a, b) => a.date.localeCompare(b.date));
  let homeGoals = 0, awayGoals = 0, totalWeight = 0;
  const teams = new Map();
  const get = (name) => teams.get(name) ?? { homeFor: 0, homeAgainst: 0, homeGames: 0, awayFor: 0, awayAgainst: 0, awayGames: 0 };
  for (const match of completed) {
    const [home, away] = finalScore(match);
    const daysAgo = Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${match.date}T00:00:00Z`)) / 86_400_000);
    const weight = Math.exp(-daysAgo / 210);
    homeGoals += home * weight; awayGoals += away * weight; totalWeight += weight;
    const h = get(match.team1); h.homeFor += home * weight; h.homeAgainst += away * weight; h.homeGames += weight; teams.set(match.team1, h);
    const a = get(match.team2); a.awayFor += away * weight; a.awayAgainst += home * weight; a.awayGames += weight; teams.set(match.team2, a);
  }
  const ratings = new Map();
  const rating = (team) => ratings.get(team) ?? 1500;
  for (const match of completed) {
    const [home, away] = finalScore(match), homeRating = rating(match.team1), awayRating = rating(match.team2);
    const expectedHome = 1 / (1 + Math.pow(10, -(homeRating + 55 - awayRating) / 400));
    const actualHome = home > away ? 1 : home === away ? 0.5 : 0;
    const k = 20;
    ratings.set(match.team1, homeRating + k * (actualHome - expectedHome));
    ratings.set(match.team2, awayRating - k * (actualHome - expectedHome));
  }
  const form = new Map();
  const getForm = (name) => form.get(name) ?? { scored: 0, conceded: 0, games: 0 };
  for (const match of [...completed].reverse()) {
    const [home, away] = finalScore(match);
    const h = getForm(match.team1), a = getForm(match.team2);
    if (h.games < 6) { h.scored += home; h.conceded += away; h.games += 1; form.set(match.team1, h); }
    if (a.games < 6) { a.scored += away; a.conceded += home; a.games += 1; form.set(match.team2, a); }
  }
  return { homeGoals: homeGoals / totalWeight || 1.45, awayGoals: awayGoals / totalWeight || 1.15, teams, ratings, form, completed: completed.length };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function strengthGoals(home, away, stats) {
  const h = stats.teams.get(home) ?? { homeFor: stats.homeGoals, homeAgainst: stats.awayGoals, homeGames: 0 };
  const a = stats.teams.get(away) ?? { awayFor: stats.awayGoals, awayAgainst: stats.homeGoals, awayGames: 0 };
  const smooth = (value, games, baseline) => (value * games + baseline * 6) / (games + 6);
  const homeFor = smooth(h.homeFor / Math.max(h.homeGames, 1), h.homeGames, stats.homeGoals);
  const homeAgainst = smooth(h.homeAgainst / Math.max(h.homeGames, 1), h.homeGames, stats.awayGoals);
  const awayFor = smooth(a.awayFor / Math.max(a.awayGames, 1), a.awayGames, stats.awayGoals);
  const awayAgainst = smooth(a.awayAgainst / Math.max(a.awayGames, 1), a.awayGames, stats.homeGoals);
  return {
    home: clamp(stats.homeGoals * Math.sqrt((homeFor / stats.homeGoals) * (awayAgainst / stats.homeGoals)), 0.25, 3.5),
    away: clamp(stats.awayGoals * Math.sqrt((awayFor / stats.awayGoals) * (homeAgainst / stats.awayGoals)), 0.25, 3.5)
  };
}

function formGoals(home, away, stats) {
  const baseline = (stats.homeGoals + stats.awayGoals) / 2;
  const h = stats.form.get(home) ?? { scored: baseline, conceded: baseline, games: 0 };
  const a = stats.form.get(away) ?? { scored: baseline, conceded: baseline, games: 0 };
  const rate = (value, games) => (value + baseline * 3) / (games + 3);
  return {
    home: clamp(stats.homeGoals * Math.sqrt((rate(h.scored, h.games) / baseline) * (rate(a.conceded, a.games) / baseline)), 0.25, 3.5),
    away: clamp(stats.awayGoals * Math.sqrt((rate(a.scored, a.games) / baseline) * (rate(h.conceded, h.games) / baseline)), 0.25, 3.5)
  };
}

function eloGoals(home, away, stats) {
  const homeRating = stats.ratings.get(home) ?? 1500, awayRating = stats.ratings.get(away) ?? 1500;
  const homeWinStrength = 1 / (1 + Math.pow(10, -(homeRating + 55 - awayRating) / 400));
  const totalGoals = stats.homeGoals + stats.awayGoals;
  const baselineShare = stats.homeGoals / totalGoals;
  const homeShare = clamp(baselineShare + (homeWinStrength - 0.5) * 0.32, 0.25, 0.75);
  return { home: totalGoals * homeShare, away: totalGoals * (1 - homeShare) };
}

function componentGoals(home, away, stats) {
  return { strength: strengthGoals(home, away, stats), form: formGoals(home, away, stats), elo: eloGoals(home, away, stats) };
}

function blendGoals(components, weights) {
  return ['home', 'away'].reduce((result, side) => {
    result[side] = ['strength', 'form', 'elo'].reduce((sum, name) => sum + components[name][side] * weights[name], 0);
    return result;
  }, {});
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

function predict(match, league, stats, weights) {
  const xg = blendGoals(componentGoals(match.team1, match.team2, stats), weights);
  const { home, draw, away, btts, over15, over25, over35, best } = scoreMatrix(xg);
  const under15 = 1 - over15, under25 = 1 - over25, under35 = 1 - over35;
  const homeOver15 = 1 - poisson(0, xg.home) - poisson(1, xg.home);
  const awayOver05 = 1 - poisson(0, xg.away);
  const dnbHome = home / (home + away), dnbAway = away / (home + away);
  const result = [['Home', home], ['Draw', draw], ['Away', away]].sort((a, b) => b[1] - a[1])[0];
  const dc = [['1X', home + draw], ['12', home + away], ['X2', draw + away]].sort((a, b) => b[1] - a[1])[0];
  const choose = (yes, no, yesLabel, noLabel) => yes >= no ? [yesLabel, yes] : [noLabel, no];
  return {
    id: `${league.id}-${match.date}-${match.team1}-${match.team2}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    league: league.name, leagueId: league.id, date: match.date, time: match.time ?? 'TBC', home: match.team1, away: match.team2,
    xg: { home: Number(xg.home.toFixed(2)), away: Number(xg.away.toFixed(2)) },
    confidence: stats.completed >= 140 ? 'Established model' : 'Early-season model',
    model: { weights },
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

function backtest(matches) {
  const completed = matches.filter((match) => finalScore(match) && match.date < today).sort((a, b) => a.date.localeCompare(b.date));
  const start = Math.max(35, Math.floor(completed.length * 0.8));
  const sample = completed.slice(start, start + 40);
  if (!sample.length) return null;
  const brier = { strength: 0, form: 0, elo: 0, ensemble: 0 };
  let correct = 0;
  const equalWeights = { strength: 1 / 3, form: 1 / 3, elo: 1 / 3 };
  for (const fixture of sample) {
    const stats = buildStats(completed, fixture.date);
    const components = componentGoals(fixture.team1, fixture.team2, stats);
    const [h, a] = finalScore(fixture);
    const actual = [h > a ? 1 : 0, h === a ? 1 : 0, h < a ? 1 : 0];
    let predicted;
    for (const name of ['strength', 'form', 'elo']) {
      const probabilities = scoreMatrix(components[name]);
      const values = [probabilities.home, probabilities.draw, probabilities.away];
      brier[name] += values.reduce((sum, value, index) => sum + Math.pow(value - actual[index], 2), 0) / 3;
    }
    const ensemble = scoreMatrix(blendGoals(components, equalWeights));
    predicted = [ensemble.home, ensemble.draw, ensemble.away];
    brier.ensemble += predicted.reduce((sum, value, index) => sum + Math.pow(value - actual[index], 2), 0) / 3;
    if (predicted.indexOf(Math.max(...predicted)) === actual.indexOf(1)) correct += 1;
  }
  const modelBrier = Object.fromEntries(Object.entries(brier).map(([name, score]) => [name, Math.round((score / sample.length) * 1000) / 1000]));
  const inverse = ['strength', 'form', 'elo'].map((name) => [name, 1 / (modelBrier[name] + 0.01)]);
  const totalInverse = inverse.reduce((sum, [, value]) => sum + value, 0);
  const weights = Object.fromEntries(inverse.map(([name, value]) => [name, Math.round((value / totalInverse) * 1000) / 1000]));
  return { matches: sample.length, accuracy: Math.round((correct / sample.length) * 1000) / 10, brier: modelBrier.ensemble, components: modelBrier, weights };
}

const results = [];
for (const [id, name, code] of leagues) {
  try {
    const [current, previous, older] = await Promise.all([getLeague(code, season), getLeague(code, previousSeason), getLeague(code, twoSeasonsAgo)]);
    const history = [...(older.matches ?? []), ...(previous.matches ?? []), ...(current.matches ?? [])];
    const stats = buildStats(history, today);
    const diagnostic = backtest(history);
    const upcoming = (current.matches ?? []).filter((match) => match.date >= today && match.date <= forecastEnd && !finalScore(match));
    results.push({ id, name, predictions: upcoming.map((match) => predict(match, { id, name }, stats, diagnostic?.weights ?? { strength: 0.5, form: 0.25, elo: 0.25 })), diagnostic, error: null });
  } catch (error) {
    results.push({ id, name, predictions: [], diagnostic: null, error: error.message });
  }
}

const payload = {
  generatedAt: new Date().toISOString(), season, source: 'OpenFootball public-domain match data',
  methodology: 'League-specific ensemble of recency-weighted home/away strength, six-match form, and sequential Elo forecasts. Component weights are derived from walk-forward Brier scores; final score probabilities use a low-score-corrected Poisson model.',
  leagues: results.map(({ id, name, error, diagnostic }) => ({ id, name, error, diagnostic })),
  predictions: results.flatMap((result) => result.predictions).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(payload, null, 2));
console.log(`Wrote ${payload.predictions.length} predictions for ${season} to ${output}`);
