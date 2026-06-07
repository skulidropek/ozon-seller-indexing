# Ozon Seller Indexing

Incremental open-source indexer for public Ozon seller pages. It discovers sellers from Ozon categories, opens each seller page, clicks the `Магазин` tab, extracts public legal details from the `О магазине` modal, and stores the result as JSON files committed by GitHub Actions.

The repository is intentionally standalone: no proxy, no GoLogin, no BrowserHost, no production database, no cookies, and no private credentials.

## What it does

- Discovers product and seller URLs from configured Ozon category pages.
- Persists category pagination state with `pageToken` / `nextPageToken`.
- Processes discovered products and sellers with independent worker pools.
- Clicks `Магазин` on seller pages and extracts public legal data such as seller legal name, person name, INN/OGRN/OGRNIP.
- Saves data in sharded JSON files under `data/`.
- Saves resumable queues and category cursors in `state/indexer-state.json`.
- Detects Ozon blocking patterns and stops cleanly after committing already collected data.
- Seeds `https://ozon.com/seller/worldofsport/` by default so the seller modal flow is tested directly.
- Runs headed Chromium under Xvfb in GitHub Actions and stores screenshots/HTML when Ozon blocks the runner.

## Data layout

```text
data/
  category-pages/<category-id>/<page-hash>.json
  products/<shard>/<product-key>.json
  sellers/<shard>/<seller-key>.json
state/
  indexer-state.json
reports/
  latest-run.json
  runs/<run-id>.json
artifacts/
  diagnostics/<timestamp>-<label>.{html,png,json}
```

## Local usage

```bash
npm install
npx playwright install chromium
npm run build
npm start -- timed --duration-minutes 5
```

For a small local smoke run:

```bash
MAX_PAGES_PER_RUN=1 MAX_PRODUCTS_PER_RUN=5 MAX_SELLERS_PER_RUN=2 npm run dev -- timed --duration-minutes 2
```

## GitHub Actions

The `Indexer` workflow runs in timed mode, commits changes in `data/`, `state/`, and `reports/`, and dispatches another run when `reports/latest-run.json` says more work remains.

## Configuration

See `env.example`. The most important controls are:

- `MAX_CATEGORY_WORKERS`
- `MAX_PRODUCT_WORKERS`
- `MAX_SELLER_WORKERS`
- `MIN_ACTION_DELAY_MS`
- `MAX_ACTION_DELAY_MS`
- `BLOCK_COOLDOWN_MS`
- `SEED_SELLER_URLS`
- `ARTIFACTS_DIRECTORY`

Keep delays conservative. Ozon may return redirect loops, 403 responses, or anti-bot screens from GitHub-hosted runners.
