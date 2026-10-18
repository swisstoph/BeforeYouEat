"""Record the cuisine of FSA-rated food places, from three sources in order of trust.

    1. OpenStreetMap: the cuisine tag of the place matched by build_positions.py
    2. Overture Maps: the category of a place with a similar name at the same postcode, or within 150 m
    3. Name: clear words or well-known chains in the business name ("Pizza", "Tandoori", "Greggs")

Output (read later by the app):
    cuisine/index.json         version, sources, coverage, list of postcode districts
    cuisine/<DISTRICT>.json    {"<FHRSID>": ["italian;pizza", "osm"], ...}   source is osm, overture or name

Usage (run from the project root, after build_positions.py has run in the same folder):
    python tools/build_cuisine.py

Cuisine data © OpenStreetMap contributors (ODbL 1.0) and Overture Maps (data from Meta and Microsoft under
CDLA Permissive 2.0; Copyright 2024 Foursquare Labs, Inc., Apache 2.0).
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_positions import USER_AGENT, cell, district, get_fsa_places, metres, similar, tokens, write_json

OVERTURE_BUCKET = 'https://overturemaps-us-west-2.s3.amazonaws.com'
MAX_OVERTURE_METRES = 150
MIN_OVERTURE_FOOD = 200_000      # a UK extract has over 300,000 open food and drink places
FOOD_TYPES = {1: 'Restaurant/Cafe/Canteen', 7844: 'Takeaway/sandwich shop', 7843: 'Pub/bar/nightclub',
              7841: 'Other catering premises', 7846: 'Mobile caterer'}

# Overture categories that don't say what food is served.
GENERIC = {'restaurant', 'fast_food_restaurant', 'food', 'eat_and_drink', 'food_and_drink', 'bar', 'pub', 'gastropub',
           'food_stand', 'food_truck', 'food_truck_stand', 'food_court', 'caterer', 'catering_service', 'buffet_restaurant',
           'diner', 'bistro', 'cocktail_bar', 'wine_bar', 'sports_bar', 'beer_bar', 'night_club', 'lounge', 'hotel',
           'event_venue', 'family_style_restaurant', 'takeout_restaurant', 'canteen', 'cafeteria',
           'bar_and_grill_restaurant', 'brewery'}

# Clear words and well-known chains. Anything else gets no guess.
NAME_RULES = {
    'mcdonald': 'burger', 'burger king': 'burger', 'five guys': 'burger', 'byron': 'burger', 'gbk': 'burger',
    'kfc': 'chicken', 'nando': 'chicken', 'popeyes': 'chicken', 'wingstop': 'chicken', 'chicken cottage': 'chicken',
    'domino': 'pizza', 'pizza hut': 'pizza', 'papa john': 'pizza', 'pizza express': 'pizza', 'zizzi': 'italian',
    'prezzo': 'italian', 'ask italian': 'italian', 'bella italia': 'italian', 'frankie & benny': 'italian',
    'wagamama': 'japanese', 'itsu': 'japanese', 'yo sushi': 'sushi', 'wasabi': 'japanese', 'sushi': 'sushi',
    'greggs': 'bakery', 'costa': 'coffee_shop', 'starbucks': 'coffee_shop', 'caffe nero': 'coffee_shop',
    'pret a manger': 'sandwich', 'subway': 'sandwich', 'leon': 'healthy', 'wetherspoon': 'british',
    'tortilla': 'mexican', 'taco bell': 'mexican', 'chipotle': 'mexican', 'harvester': 'grill', 'toby carvery': 'british',
    'pizza': 'pizza', 'kebab': 'kebab', 'fish bar': 'fish_and_chips', 'chippy': 'fish_and_chips',
    'fish & chips': 'fish_and_chips', 'fish and chips': 'fish_and_chips', 'chinese': 'chinese', 'tandoori': 'indian',
    'balti': 'indian', 'curry': 'indian', 'indian': 'indian', 'thai': 'thai', 'noodle': 'asian', 'burger': 'burger',
    'fried chicken': 'chicken', 'peri peri': 'chicken', 'bakery': 'bakery', 'patisserie': 'bakery', 'cafe': 'coffee_shop',
    'coffee': 'coffee_shop', 'sandwich': 'sandwich', 'turkish': 'turkish', 'greek': 'greek', 'mexican': 'mexican',
    'italian': 'italian', 'trattoria': 'italian', 'pizzeria': 'pizza', 'japanese': 'japanese', 'vietnamese': 'vietnamese',
    'korean': 'korean', 'lebanese': 'lebanese', 'persian': 'persian', 'caribbean': 'caribbean', 'jamaican': 'caribbean',
    'nepalese': 'nepalese', 'bangladeshi': 'indian', 'spice': 'indian', 'masala': 'indian', 'dim sum': 'chinese',
    'oriental': 'asian', 'cantonese': 'chinese', 'szechuan': 'chinese', 'grill house': 'grill', 'steakhouse': 'steak_house',
    'steak house': 'steak_house', 'tapas': 'spanish', 'french': 'french', 'brasserie': 'french', 'crepe': 'crepe',
    'doughnut': 'donut', 'donut': 'donut', 'ice cream': 'ice_cream', 'gelato': 'ice_cream', 'dessert': 'dessert',
}
NAME_KEYS = sorted(NAME_RULES, key=len, reverse=True)


def name_cuisine(name):
    s = unicodedata.normalize('NFKD', name or '').encode('ascii', 'ignore').decode().lower().replace("'", '')
    n = ' ' + re.sub(r'[^a-z0-9& ]+', ' ', s) + ' '
    for k in NAME_KEYS:
        if f' {k} ' in n or f' {k}s ' in n:      # whole words, allowing a plural or possessive ("Nando's")
            return NAME_RULES[k]
    return None


def overture_cuisine(category):
    if not category or category in GENERIC:
        return None
    return category.removesuffix('_restaurant')


def compact_postcode(s):
    return re.sub(r'\s+', '', (s or '').upper())


# ---------- Overture ----------

def latest_overture_release():
    req = urllib.request.Request(f'{OVERTURE_BUCKET}/?list-type=2&prefix=release/&delimiter=/',
                                 headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        xml = res.read().decode()
    releases = re.findall(r'<Prefix>release/([^/<]+)/</Prefix>', xml)
    if not releases:
        raise RuntimeError('No Overture releases found in the bucket listing.')
    return max(releases)


def get_overture(cache, release):
    """UK food and drink places from Overture, cached per release."""
    import duckdb   # only needed here, so build_positions.py runs without it
    dest = cache / f'overture_food_{release}.parquet'
    if dest.exists():
        print(f'Using cached {dest.name}')
    else:
        for old in cache.glob('overture_food_*.parquet'):
            old.unlink()
        print(f'Extracting UK food places from Overture release {release} …')
        con = duckdb.connect()
        con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
        src = f's3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet'
        tmp = dest.with_suffix('.tmp')
        con.execute(f"""
            COPY (
              SELECT names."primary" AS name, taxonomy."primary" AS category, addresses[1].postcode AS postcode,
                     (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lon
              FROM read_parquet('{src}')
              WHERE bbox.xmin BETWEEN -8.7 AND 2.1 AND bbox.ymin BETWEEN 49.8 AND 61.0
                AND (addresses[1].country = 'GB' OR addresses[1].country IS NULL)
                AND taxonomy.hierarchy[1] = 'food_and_drink' AND names."primary" IS NOT NULL
                AND (operating_status IS NULL OR operating_status = 'open')
            ) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
        tmp.rename(dest)
    return duckdb.sql(f"SELECT name, category, postcode, lat, lon FROM '{dest.as_posix()}'").fetchall()


def index_overture(rows):
    by_pc, grid = defaultdict(list), defaultdict(list)
    for name, cat, pc, lat, lon in rows:
        r = {'cat': cat, 'tok': tokens(name), 'lat': lat, 'lon': lon}
        if pc:
            by_pc[compact_postcode(pc)].append(r)
        grid[cell(lat, lon)].append(r)
    return by_pc, grid


def overture_match(p, pos, by_pc, grid):
    tp = tokens(p.get('BusinessName') or '')
    if not tp:
        return None
    for r in by_pc.get(compact_postcode(p.get('PostCode')), []):
        if similar(tp, r['tok']):
            return r
    try:
        lat, lon = pos or (float(p['Geocode']['Latitude']), float(p['Geocode']['Longitude']))
    except (TypeError, ValueError, KeyError):
        return None
    ci, cj = cell(lat, lon)
    best = None
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for r in grid.get((ci + di, cj + dj), []):
                if similar(tp, r['tok']):
                    d = metres(lat, lon, r['lat'], r['lon'])
                    if d <= MAX_OVERTURE_METRES and (best is None or d < best[0]):
                        best = (d, r)
    return best[1] if best else None


# ---------- main ----------

def read_folder(folder):
    out = {}
    for f in Path(folder).glob('*.json'):
        if f.name != 'index.json':
            out.update(json.loads(f.read_text(encoding='utf-8')))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--osm-cuisine', default='tools/.cache/osm_cuisine.json', help='cuisines written by build_positions.py')
    ap.add_argument('--positions', default='positions', help='exact positions folder')
    ap.add_argument('--out', default='cuisine', help='output folder')
    ap.add_argument('--cache', default='tools/.cache', help='download cache folder')
    ap.add_argument('--overture-release', help='Overture release, e.g. 2026-09-23.1 (default: the latest)')
    ap.add_argument('--force', action='store_true', help='publish even if the sanity checks fail')
    args = ap.parse_args()

    cache, out = Path(args.cache), Path(args.out)
    cache.mkdir(parents=True, exist_ok=True)
    osm = json.loads(Path(args.osm_cuisine).read_text(encoding='utf-8'))
    exact = read_folder(args.positions)
    release = args.overture_release or latest_overture_release()
    rows = get_overture(cache, release)
    print(f'OpenStreetMap cuisines: {len(osm):,} | Overture {release}: {len(rows):,} food and drink places')
    by_pc, grid = index_overture(rows)
    places = get_fsa_places(cache, set())

    files = defaultdict(dict)
    by_type = defaultdict(Counter)
    sources, counts = Counter(), Counter()
    for p in places:
        d = district(p.get('PostCode'))
        if not d:
            continue
        fid = str(p['FHRSID'])
        kind = p.get('BusinessType') or 'Other'
        food = p.get('BusinessTypeID') in FOOD_TYPES
        by_type[kind]['places'] += 1
        found = (osm[fid], 'osm') if fid in osm else None
        if not found and food:
            m = overture_match(p, exact.get(fid), by_pc, grid)
            c = overture_cuisine(m['cat']) if m else None
            found = (c, 'overture') if c else None
        if not found and food:
            c = name_cuisine(p.get('BusinessName'))
            found = (c, 'name') if c else None
        if found:
            files[d][fid] = list(found)
            by_type[kind]['with_cuisine'] += 1
            by_type[kind][found[1]] += 1
            sources[found[1]] += 1
            for one in found[0].split(';'):
                counts[one] += 1

    total = sum(sources.values())
    share = lambda kind: by_type[kind]['with_cuisine'] / max(1, by_type[kind]['places'])
    summary = (f'{total:,} places with a cuisine (OpenStreetMap {sources["osm"]:,}, Overture {sources["overture"]:,}, '
               f'name {sources["name"]:,}) | restaurants/cafes {share(FOOD_TYPES[1]):.0%} | '
               f'takeaways {share(FOOD_TYPES[7844]):.0%}')
    print(summary)

    problems = []
    if len(rows) < MIN_OVERTURE_FOOD:
        problems.append(f'Only {len(rows):,} Overture food places were read; a UK extract has over 300,000.')
    if len(places) < 300_000:
        problems.append(f'Only {len(places):,} FSA places were read; a full UK build has over 400,000.')
    if not 0.35 <= share(FOOD_TYPES[1]) <= 0.80:
        problems.append(f'Restaurant coverage is {share(FOOD_TYPES[1]):.0%}, outside the expected 35-80%.')
    try:
        before = json.loads((out / 'index.json').read_text(encoding='utf-8')).get('places_with_cuisine')
    except (OSError, ValueError):
        before = None
    if before and total < 0.9 * before:
        problems.append(f'Places with a cuisine dropped from {before:,} to {total:,} (more than 10%).')
    if before and total > 1.2 * before:
        problems.append(f'Places with a cuisine jumped from {before:,} to {total:,} (more than 20%).')
    if problems and not args.force:
        report_cuisine(summary, problems)
        print('Not publishing: the existing cuisines are left unchanged.')
        return 1

    tmp = out.with_name(out.name + '.tmp')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    for d, entries in sorted(files.items()):
        write_json(tmp / f'{d}.json', dict(sorted(entries.items())), compact=True)
    coverage = {k: {'places': v['places'], 'with_cuisine': v['with_cuisine'],
                    'share': round(v['with_cuisine'] / v['places'], 3),
                    'by_source': {s: v[s] for s in ('osm', 'overture', 'name') if v[s]}}
                for k, v in sorted(by_type.items(), key=lambda kv: -kv[1]['places'])}
    write_json(tmp / 'index.json', {
        'version': dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M'),
        'built': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'note': 'Cuisine of FSA places. Each entry is [cuisine, source]; source is osm, overture or name.',
        'overture_release': release,
        'licence': ['Cuisine data from OpenStreetMap © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright',
                    'Cuisine data from Overture Maps (https://overturemaps.org): data from Meta and Microsoft under CDLA Permissive 2.0; '
                    'Copyright 2024 Foursquare Labs, Inc., Apache 2.0.'],
        'places_with_cuisine': total,
        'by_source': dict(sources),
        'coverage_by_business_type': coverage,
        'top_cuisines': dict(counts.most_common(40)),
        'districts': sorted(files),
    })
    read_back = sum(1 for v in read_folder(tmp).values() if isinstance(v, list) and len(v) == 2 and v[0])
    if read_back != total:
        report_cuisine(summary, [f'Read back {read_back} cuisines from the files, expected {total}.'])
        shutil.rmtree(tmp)
        return 1
    if out.exists():
        shutil.rmtree(out)
    tmp.rename(out)
    report_cuisine(summary, [])
    print(f'Wrote {len(files)} district files to {out}/')
    return 0


def report_cuisine(summary, problems):
    for p in problems:
        print(f'CHECK FAILED: {p}')
    step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if step_summary:
        with open(step_summary, 'a', encoding='utf-8') as f:
            f.write(f'### Cuisines build\n\n{summary}\n\n')
            f.write('\n'.join(f'- ❌ {p}' for p in problems) if problems else '✅ All checks passed.')
            f.write('\n')


if __name__ == '__main__':
    sys.exit(main())
