# Before You Eat

A hobby PWA that shows UK food hygiene ratings for the places nearest to you: 0 to 5 in England, Wales and
Northern Ireland, Pass / Improvement required in Scotland.
Plain HTML, CSS and JavaScript. No build step, no backend.

## Scotland is different

England, Wales and Northern Ireland use the **Food Hygiene Rating Scheme** (FHRS): 0 to 5, with three sub-scores.
Scotland uses Food Standards Scotland's **Food Hygiene Information Scheme** (FHIS): **Pass** or **Improvement required**,
plus Awaiting inspection / Exempt, and no sub-scores. Both come from the same FSA API (`SchemeType` is `FHRS` or `FHIS`;
Scottish `RatingValue`s contain spaces, e.g. `Improvement Required`).

The app shows each place in its own scheme, so lists and maps near the border mix the two:

- FHRS: number tiles in greens / amber / reds, number pins on the map
- FHIS: word tiles in their own colours (blue Pass, brown Improve) and ✓ / ! pins, because the two scales aren't comparable
- Scottish detail pages explain the scheme and have no sub-score section

## Files

- `index.html`: page structure (list, detail, settings)
- `styles.css`: styles, light and dark themes, rating tile colours
- `app.js`: everything else (location, FSA API, search, navigation, settings)
- `sw.js`: service worker for offline use. Bump `VERSION` when you deploy.
- `manifest.webmanifest`, `icons/`: home-screen install
- `positions/`: exact map positions per postcode district (generated, see below)
- `tools/build_positions.py`: builds `positions/`
- `.github/workflows/positions.yml`: monthly GitHub Action that rebuilds `positions/` and `cuisine/`
- `history/`, `tools/record_history.py`, `.github/workflows/history.yml`: weekly rating history (see below)
- `cuisine/`, `tools/build_cuisine.py`: cuisine of food places from OpenStreetMap, Overture Maps and business names
  (see below)
- `vendor/leaflet/`: map library

## Run locally

```bash
python -m http.server 8411 --directory .
```

Then open http://localhost:8411. Location only works on `localhost` or `https://`.

## Deploy (free)

**GitHub Pages** (public repository): Settings → Pages → Source "Deploy from a branch" → branch `main`, folder `/ (root)`.
The site appears at `https://<username>.github.io/<repo>/` a minute or two after each push.

**Cloudflare Pages** (works with private repositories too): Workers & Pages → Create → Pages → Connect to Git →
pick the repository. Framework preset "None", build command empty, output directory `/`.
The site appears at `https://<project>.pages.dev` and redeploys on every push, including the monthly data commits.

Bump `VERSION` in `sw.js` when you change app files, so installed copies refresh promptly.

## Monthly data refresh

`.github/workflows/positions.yml` runs on the 2nd of each month (and on demand from the Actions tab → Refresh map
positions → Run workflow). It rebuilds `positions/` and commits only if a district file changed.
For it to push, the repository needs Settings → Actions → General → Workflow permissions → "Read and write permissions".
With GitHub Pages, check the site redeploys after the bot's commit; Cloudflare Pages always does.

## Exact map positions (`positions/`)

The FSA often gives a business only its postcode's centre point. `tools/build_positions.py` matches FSA places
to OpenStreetMap (by FSA id tag, or by name close by with a house-number check) and writes one small file per
postcode district, e.g. `positions/SW1A.json`. The app loads these on the map; places without a match stay at the
postcode point and get spread apart when zoomed in.

```bash
pip install -r tools/requirements.txt
python tools/build_positions.py
```

That builds the whole UK (downloads about 2 GB from Geofabrik plus the FSA's bulk files,
cached in `tools/.cache`). For a quicker regional build:

```bash
python tools/build_positions.py --region London --osm https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
```

Re-run every month or so and redeploy. Each build has a new version in `positions/index.json`; the app checks it
on every online launch, so phones pick up new data automatically. The position files are derived from
OpenStreetMap and are shared under the Open Database Licence, like the map data.

## Cuisines (`cuisine/`)

`tools/build_cuisine.py` runs after `build_positions.py` and records what kind of food each place serves, taking the
first of three sources: the OpenStreetMap cuisine tag of the matched place; the category of an Overture Maps place
with a similar name at the same postcode or within 150 m (latest release, UK food and drink places only, read with
DuckDB); or clear words and chains in the business name ("Pizza", "Tandoori", "Greggs"). Files are per postcode
district, e.g. `cuisine/SW1A.json` = `{"<FHRSID>": ["italian;pizza", "osm"]}`, where the second value is the source
(`osm`, `overture` or `name`). `cuisine/index.json` has the coverage per business type and source. The build refuses
to publish if the Overture download looks incomplete or coverage drops or jumps sharply.

The app uses it for "Same cuisine" under Higher-rated places nearby (shown for ratings 0-2). `CUISINE_GROUPS` in
`app.js` treats similar values as one cuisine (cafe and coffee_shop, pizza and pizzeria) and leaves out values that
don't describe the food. `CUISINE_FAMILIES` links similar cuisines (dessert, bakery and café; the fast-food
family; East Asian; and so on): when no higher-rated place with the same cuisine is nearby, similar ones are shown
instead, and the app says so. Places without a known cuisine just get the any-cuisine list. Suggestions are chosen only
by hygiene rating, distance and cuisine; they are not recommendations, and the app says so on screen and in Settings.

Cuisine data © OpenStreetMap contributors (Open Database Licence) and Overture Maps: data from Meta and Microsoft
under CDLA Permissive 2.0, and Copyright 2024 Foursquare Labs, Inc., under the Apache License 2.0.

## Rating history (`history/`)

The FSA only publishes each place's current rating. `tools/record_history.py` keeps a history: it saves every place's
rating and inspection date, and adds an entry whenever either changes. Files are per postcode district, e.g.
`history/SW1A.json` = `{"<FHRSID>": [["1", "2025-03-12"], ["5", "2026-08-03"]]}` (oldest first).
Recording started on 18 October 2026; the first entry for each place is its rating on that day.
`.github/workflows/history.yml` runs it every Monday and commits only when something changed. It refuses to save
if the download looks incomplete or an implausible number of ratings changed at once.

## Settings to fill in

- `TIP_URL` at the top of `app.js`: your Buy Me a Coffee or Ko-fi link. The link stays hidden while this is empty.

## Data sources

- Food Standards Agency, Food Hygiene Rating Scheme API (`api.ratings.food.gov.uk`, header `x-api-version: 2`), under the Open Government Licence v3.0.
  The API rate-limits bursts of requests from one IP address. The app sends one request per screen of results.
- postcodes.io for postcode search, with the FSA as a fallback.
- Map: Leaflet 1.9.4, bundled in `vendor/leaflet` (BSD-2 licence; checksums match the official release).
  The map images come from OpenStreetMap's free tile servers, which have a
  [fair-use policy](https://operations.osmfoundation.org/policies/tiles/). If the app gets busy, switch the
  tile URL in `ensureMap()` in `app.js` to a free-tier provider such as MapTiler or Stadia.
