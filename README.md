# Pitch Probability

A zero-cost, static football-prediction site for the Premier League, La Liga, Serie A, Bundesliga, Ligue 1 and Eredivisie.

## How it works

- Match fixtures and results come from OpenFootball's public-domain datasets.
- `npm run update` downloads the current and two prior seasons, builds leak-safe team features, and writes a static `public/data/predictions.json` file.
- The model blends three league-specific forecasts: time-decayed home/away strength, six-match team form, and sequential Elo. The blend weights are determined from each component's walk-forward Brier score, then score probabilities use a Dixon-Coles-style low-score-corrected Poisson model. It publishes ten market forecasts for each fixture; it does not use bookmaker odds, scrape Forebet, or claim certainty.
- The upgraded engine also applies a deliberately small rest-day adjustment and evaluates each league over a multi-season, leak-safe walk-forward sample. It records Brier score, log loss, accuracy, and expected calibration error (ECE). Lower Brier, log loss, and ECE are better; these are model diagnostics, not a promise of future returns.
- `npm run serve` previews the site at `http://localhost:4173`.

## Zero-cost publishing

Host the `public/` folder with GitHub Pages or Cloudflare Pages. Use a free `*.github.io` or `*.pages.dev` address; a paid domain is optional. This project includes GitHub Actions workflows that refresh data daily and deploy `public/` on every change. For GitHub Pages, create a public GitHub repository, push this project to its `main` branch, then select **Settings → Pages → Source: GitHub Actions**. No API secret is needed.

## Important limits

OpenFootball updates are not live-data infrastructure. This product is deliberately for pre-match, daily predictions. Source outages cause the affected league's fixtures to be hidden rather than inventing forecasts.

## Refresh safety

The updater writes the prediction feed atomically and refuses to replace a populated feed when all forecast generation failed because of source errors. A failed GitHub Actions refresh therefore leaves the last good production deployment intact. The next successful scheduled run publishes the upgraded diagnostics and data automatically.
