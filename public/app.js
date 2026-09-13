const root = document.querySelector("#fixtures");
const template = document.querySelector("#card");
const nav = document.querySelector("#leagueNav");
const dateInput = document.querySelector("#date");
const dialog = document.querySelector("#dialog");
const notice = document.querySelector("#notice");
const STALE_AFTER_HOURS = 30;

let data;
let league = "ALL";
let quick = "all";

const esc = (value) =>
  String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character],
  );
const localDate = () => {
  const now = new Date();
  return new Date(now - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
};
const formatDate = (value) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
const market = (fixture, name) =>
  fixture.markets.find((item) => item.name === name);
const oneXTwo = (fixture) => {
  if (fixture.oneXTwo) return fixture.oneXTwo;
  const poisson = (goals, expected) =>
    (Math.exp(-expected) * expected ** goals) /
    Array.from({ length: goals }, (_, index) => index + 1).reduce(
      (total, value) => total * value,
      1,
    );
  const cells = [];
  for (let homeGoals = 0; homeGoals <= 8; homeGoals++)
    for (let awayGoals = 0; awayGoals <= 8; awayGoals++) {
      let probability =
        poisson(homeGoals, fixture.xg.home) *
        poisson(awayGoals, fixture.xg.away);
      if (homeGoals === 0 && awayGoals === 0)
        probability *= 1 + fixture.xg.home * fixture.xg.away * 0.06;
      if (homeGoals === 0 && awayGoals === 1)
        probability *= 1 - fixture.xg.home * 0.06;
      if (homeGoals === 1 && awayGoals === 0)
        probability *= 1 - fixture.xg.away * 0.06;
      if (homeGoals === 1 && awayGoals === 1) probability *= 1.06;
      cells.push({ homeGoals, awayGoals, probability });
    }
  const total = cells.reduce((sum, cell) => sum + cell.probability, 0);
  const values = cells.reduce(
    (result, cell) => {
      if (cell.homeGoals > cell.awayGoals)
        result.home += cell.probability / total;
      else if (cell.homeGoals === cell.awayGoals)
        result.draw += cell.probability / total;
      else result.away += cell.probability / total;
      return result;
    },
    { home: 0, draw: 0, away: 0 },
  );
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      Math.round(value * 1000) / 10,
    ]),
  );
};
const fixtureCount = (id) =>
  data.predictions.filter((fixture) => id === "ALL" || fixture.leagueId === id)
    .length;

function visibleFixtures() {
  const end = new Date();
  end.setDate(end.getDate() + 6);
  return data.predictions.filter((fixture) => {
    if (league !== "ALL" && fixture.leagueId !== league) return false;
    if (dateInput.value && fixture.date !== dateInput.value) return false;
    if (quick === "today" && fixture.date !== localDate()) return false;
    return quick !== "week" || new Date(`${fixture.date}T12:00:00`) <= end;
  });
}

function showNotice(messages) {
  notice.hidden = messages.length === 0;
  notice.textContent = messages.join(" ");
}

function openFixture(fixture) {
  document.querySelector("#dLeague").textContent = fixture.league;
  document.querySelector("#dTeams").textContent =
    `${fixture.home} vs ${fixture.away}`;
  document.querySelector("#dMeta").textContent =
    `${formatDate(fixture.date)} · ${fixture.time || "TBC"} · ${fixture.confidence}`;
  const weights = fixture.model.weights;
  const rest = fixture.model.restDays;
  const validation = fixture.model.validation;
  const validationText = validation
    ? ` · backtest: ${validation.matches} matches, Brier ${validation.brier}, ECE ${validation.ece}`
    : "";
  const restText = rest ? ` · rest: ${rest.home}d / ${rest.away}d` : "";
  document.querySelector("#dScore").innerHTML =
    `<small>EXPECTED GOALS</small><strong>${fixture.xg.home}<i>—</i>${fixture.xg.away}</strong><em>Blend: strength ${Math.round(weights.strength * 100)}% · form ${Math.round(weights.form * 100)}% · Elo ${Math.round(weights.elo * 100)}%${restText}${validationText}</em>`;
  document.querySelector("#dMarkets").innerHTML = fixture.markets
    .map(
      (item) =>
        `<div><span>${esc(item.name)}</span><b>${esc(item.selection)}</b><em>${item.probability}%</em></div>`,
    )
    .join("");
  dialog.showModal();
}

function renderNavigation() {
  nav.innerHTML =
    `<button class="${league === "ALL" ? "selected" : ""}" data-id="ALL">● All leagues <b>${fixtureCount("ALL")}</b></button>` +
    data.leagues
      .map(
        (item) =>
          `<button class="${league === item.id ? "selected" : ""}" data-id="${item.id}">○ ${esc(item.name)} <b>${fixtureCount(item.id)}</b></button>`,
      )
      .join("");
  nav.querySelectorAll("button").forEach((button) => {
    button.onclick = () => {
      league = button.dataset.id;
      render();
    };
  });
}

function renderFeatured(fixtures) {
  const feature = document.querySelector("#featured");
  const fixture = fixtures[0];
  if (!fixture) {
    feature.innerHTML = "";
    return;
  }
  const result = market(fixture, "Match result (1X2)");
  const goals = market(fixture, "Over / Under 2.5");
  feature.innerHTML = `<div><label>NEXT ON THE BOARD</label><small>${esc(fixture.league)}</small><h2>${esc(fixture.home)} <i>vs</i> ${esc(fixture.away)}</h2><p>${formatDate(fixture.date)} · ${fixture.time || "TBC"} · A model-led preview of the next fixture in your selected view.</p><button id="feature">Explore match →</button></div><div class="lead"><small>LEADING OUTCOME</small><strong>${esc(result.selection)}</strong><b>${result.probability}%</b><hr style="--p:${result.probability}%"><p>O/U 2.5 <b>${esc(goals.selection)} · ${goals.probability}%</b></p></div>`;
  document.querySelector("#feature").onclick = () => openFixture(fixture);
}

function renderFixtures(fixtures) {
  root.innerHTML = "";
  if (!fixtures.length) {
    root.innerHTML =
      '<div class="empty"><b>⌁</b><h3>No fixtures in this view</h3><p>Try another league, date, or timeframe.</p></div>';
    return;
  }
  fixtures.forEach((fixture) => {
    const card = template.content.cloneNode(true);
    const result = market(fixture, "Match result (1X2)");
    const probabilities = oneXTwo(fixture);
    card.querySelector("label").textContent = fixture.league;
    card.querySelector("time").textContent =
      `${formatDate(fixture.date)} · ${fixture.time || "TBC"}`;
    card.querySelector(".home").textContent = fixture.home;
    card.querySelector(".away").textContent = fixture.away;
    card.querySelector(".result").textContent =
      `${result.selection} · ${result.probability}%`;
    card.querySelector(".xg").textContent =
      `${fixture.xg.home} — ${fixture.xg.away}`;
    card.querySelector(".confidence").textContent = fixture.confidence.replace(
      " model",
      "",
    );
    const outcomes = document.createElement("div");
    outcomes.className = "one-x-two";
    outcomes.setAttribute("aria-label", "Match result probabilities");
    outcomes.innerHTML = `<span><small>1</small><b>${probabilities.home}%</b></span><span><small>X</small><b>${probabilities.draw}%</b></span><span><small>2</small><b>${probabilities.away}%</b></span>`;
    card.querySelector(".signals").before(outcomes);
    ["Over / Under 2.5", "Both teams to score", "Double chance"].forEach(
      (name) => {
        const item = market(fixture, name);
        const chip = document.createElement("span");
        chip.innerHTML = `<small>${name.replace("Over / Under ", "O/U ")}</small><b>${esc(item.selection)} · ${item.probability}%</b>`;
        card.querySelector(".chips").append(chip);
      },
    );
    card.querySelector("button").onclick = () => openFixture(fixture);
    root.append(card);
  });
}

function render() {
  const fixtures = visibleFixtures();
  renderNavigation();
  renderFeatured(fixtures);
  document.querySelector("#fixtureTitle").textContent =
    league === "ALL"
      ? "All predictions"
      : data.leagues.find((item) => item.id === league).name;
  document.querySelector("#fixtureCount").textContent =
    `${fixtures.length} fixture${fixtures.length === 1 ? "" : "s"} in view`;
  renderFixtures(fixtures);
}

function validateFeed(feed) {
  if (!feed || !Array.isArray(feed.leagues) || !Array.isArray(feed.predictions))
    throw new Error("The prediction feed has an invalid format.");
  if (!feed.generatedAt || Number.isNaN(Date.parse(feed.generatedAt)))
    throw new Error("The prediction feed has no valid update time.");
}

function showFeedStatus(feed) {
  const healthy = feed.leagues.filter((item) => item.diagnostic && !item.error);
  const failed = feed.leagues.filter((item) => item.error);
  const ageHours = (Date.now() - Date.parse(feed.generatedAt)) / 3_600_000;
  const stale = ageHours > STALE_AFTER_HOURS;
  const averageBrier = healthy.length
    ? (
        healthy.reduce((total, item) => total + item.diagnostic.brier, 0) /
        healthy.length
      ).toFixed(3)
    : "—";
  const calibrated = healthy.filter((item) =>
    Number.isFinite(item.diagnostic?.calibration?.ece),
  );
  const averageEce = calibrated.length
    ? (
        calibrated.reduce(
          (total, item) => total + item.diagnostic.calibration.ece,
          0,
        ) / calibrated.length
      ).toFixed(3)
    : "Pending";
  const sourceStatus = document.querySelector("#sourceStatus");
  sourceStatus.textContent = failed.length
    ? "Some sources need attention"
    : "All sources healthy";
  sourceStatus.classList.toggle("warning", failed.length > 0 || stale);
  document.querySelector("#updatePill").textContent =
    `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(feed.generatedAt))}`;
  document.querySelector("#quality").innerHTML =
    `<div><small>FORECASTS LIVE</small><b>${feed.predictions.length}</b><span>next 14 days</span></div><div><small>VALIDATION</small><b>${averageBrier}</b><span>walk-forward Brier</span></div><div><small>CALIBRATION</small><b>${averageEce}</b><span>${calibrated.length ? "expected calibration error" : "next successful refresh"}</span></div>`;
  document.querySelector("#methodText").textContent =
    feed.methodology || "Methodology details are unavailable for this refresh.";
  const messages = [];
  if (stale)
    messages.push(
      `Forecast data is over ${Math.floor(ageHours)} hours old; a refresh is pending.`,
    );
  if (failed.length)
    messages.push(
      `Unavailable competitions: ${failed.map((item) => item.name).join(", ")}. Their fixtures are hidden until a source refresh succeeds.`,
    );
  if (!feed.predictions.length && !failed.length)
    messages.push("No fixtures were published for the next 14 days.");
  showNotice(messages);
}

try {
  const response = await fetch("data/predictions.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Prediction feed unavailable");
  data = await response.json();
  validateFeed(data);
  showFeedStatus(data);
  render();
} catch (error) {
  const sourceStatus = document.querySelector("#sourceStatus");
  sourceStatus.textContent = "Forecast feed unavailable";
  sourceStatus.classList.add("warning");
  root.innerHTML = `<div class="empty"><h3>Forecasts need a refresh</h3><p>${esc(error.message)}</p></div>`;
  showNotice([
    "The site could not load a valid prediction feed. Please try again after the next refresh.",
  ]);
}

document.querySelectorAll("[data-quick]").forEach((button) => {
  button.onclick = () => {
    quick = button.dataset.quick;
    document
      .querySelectorAll("[data-quick]")
      .forEach((item) => item.classList.toggle("active", item === button));
    render();
  };
});
dateInput.onchange = render;
document.querySelector("#clearFilters").onclick = () => {
  league = "ALL";
  quick = "all";
  dateInput.value = "";
  document
    .querySelectorAll("[data-quick]")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.quick === "all"),
    );
  render();
};
document.querySelector("#close").onclick = () => dialog.close();
dialog.onclick = (event) => {
  if (event.target === dialog) dialog.close();
};
