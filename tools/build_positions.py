"""Build exact map positions for FSA-rated places from OpenStreetMap.

The FSA gives many businesses only their postcode's centre point. OpenStreetMap often has
the real shop, either tagged with its FSA id (fhrs:id) or under the same name nearby.
This script matches the two and writes small static files the app loads on the map:

    positions/index.json         version, build date, list of postcode districts
    positions/<DISTRICT>.json    {"<FHRSID>": [lat, lon], ...}   e.g. positions/SW1A.json

Usage (run from the project root):
    pip install -r tools/requirements.txt
    python tools/build_positions.py                          # whole UK (big download)
    python tools/build_positions.py --region London \\
        --osm https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf

Downloads are cached in tools/.cache. OpenStreetMap data is © OpenStreetMap contributors,
available under the Open Database Licence; the output files are shared under the same licence.
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import shutil
import sys
import time
import unicodedata
import urllib.request
from collections import defaultdict
from pathlib import Path

import osmium

FSA_API = 'https://api.ratings.food.gov.uk'
DEFAULT_OSM = 'https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf'
USER_AGENT = 'ScoreOnTheDoor-positions/1.0 (hobby project; static build)'
MAX_NAME_METRES = 250      # a name match must be this close to the FSA point
MAX_ID_METRES = 1000       # sanity limit for fhrs:id matches (guards against mis-tagging)
STOP_WORDS = {'the', 'ltd', 'limited', 'plc', 'and', 'co', 'uk', 'london', 't', 'a', 's'}


# ---------- downloads ----------

def fetch(url, dest=None, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as res:
        if dest is None:
            return res.read()
        with open(dest, 'wb') as f:
            shutil.copyfileobj(res, f, length=1 << 20)
    return dest


def get_osm_file(source, cache):
    if not source.startswith('http'):
        return Path(source)
    dest = cache / source.rsplit('/', 1)[-1]
    if dest.exists() and time.time() - dest.stat().st_mtime < 20 * 3600:
        print(f'Using cached {dest.name}')
        return dest
    print(f'Downloading {source} …')
    fetch(source, dest)
    return dest


def get_fsa_places(cache, regions):
    authorities = json.loads(fetch(f'{FSA_API}/Authorities', headers={'x-api-version': '2', 'Accept': 'application/json'}))['authorities']
    chosen = [a for a in authorities if not regions or a['RegionName'] in regions]
    print(f'FSA: {len(chosen)} local authorities')
    places = []
    for i, a in enumerate(chosen, 1):
        code = a['LocalAuthorityIdCode']
        stamp = re.sub(r'\D', '', a.get('LastPublishedDate') or '')[:12]
        dest = cache / f'FHRS{code}-{stamp}.json'
        if not dest.exists():
            for old in cache.glob(f'FHRS{code}-*.json'):
                old.unlink()
            fetch(f'https://ratings.food.gov.uk/api/open-data-files/FHRS{code}en-GB.json', dest)
            time.sleep(0.5)  # be polite to the FSA
        data = json.loads(dest.read_text(encoding='utf-8'))
        rows = data['FHRSEstablishment']['EstablishmentCollection'] or []
        if isinstance(rows, dict):
            rows = rows.get('EstablishmentDetail') or []
        places.extend(rows)
        print(f'  {i}/{len(chosen)} {a["Name"]}: {len(rows)}', end='\r')
    print()
    return places


# ---------- OpenStreetMap ----------

def read_osm(path):
    """Named shops/food places and anything tagged fhrs:id, with a position."""
    rows = []
    fp = osmium.FileProcessor(str(path)).with_locations().with_filter(osmium.filter.KeyFilter('amenity', 'shop', 'fhrs:id'))
    for obj in fp:
        t = obj.tags
        name, fid = t.get('name', ''), t.get('fhrs:id', '')
        if not name and not fid:
            continue
        if obj.is_node():
            lat, lon = obj.location.lat, obj.location.lon
        elif obj.is_way():
            pts = [n.location for n in obj.nodes if n.location.valid()]
            if not pts:
                continue
            lat, lon = sum(p.lat for p in pts) / len(pts), sum(p.lon for p in pts) / len(pts)
        else:
            continue
        rows.append({'lat': lat, 'lon': lon, 'name': name, 'hn': t.get('addr:housenumber', ''), 'fid': fid})
    return rows


# ---------- matching ----------

def metres(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    h = math.sin((lat2 - lat1) * r / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def tokens(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    s = s.replace('&', ' and ').replace("'", '')
    return [w for w in re.split(r'[^a-z0-9]+', s) if w and w not in STOP_WORDS]


def similar(ta, tb):
    if not ta or not tb:
        return False
    ja, jb = ''.join(ta), ''.join(tb)
    if ja == jb:
        return True
    if min(len(ja), len(jb)) >= 4 and (ja in jb or jb in ja):
        return True
    sa, sb = set(ta), set(tb)
    return len(sa & sb) / len(sa | sb) >= 0.6


def house_number(s):
    m = re.match(r'\s*(\d+[a-z]?)\b', s or '', re.I)
    return m.group(1).lower() if m else ''


def cell(lat, lon):
    return (math.floor(lat / 0.003), math.floor(lon / 0.005))   # roughly 330 m x 350 m


def build_index(osm_rows):
    by_id, grid = {}, defaultdict(lambda: defaultdict(list))
    for r in osm_rows:
        for one in re.split(r'[;,]', r['fid']):
            if one.strip().isdigit():
                by_id[one.strip()] = r
        if r['name'] and not r['fid']:
            r['tok'] = tokens(r['name'])
            keys = set(r['tok']) | {''.join(r['tok'])}
            bucket = grid[cell(r['lat'], r['lon'])]
            for k in keys:
                bucket[k].append(r)
    return by_id, grid


def locate(p, lat, lon, by_id, grid):
    tagged = by_id.get(str(p['FHRSID']))
    if tagged and metres(lat, lon, tagged['lat'], tagged['lon']) <= MAX_ID_METRES:
        return 'id', tagged
    tp = tokens(p.get('BusinessName') or '')
    if not tp:
        return None, None
    keys = set(tp) | {''.join(tp)}
    ci, cj = cell(lat, lon)
    seen, cands = set(), []
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            bucket = grid.get((ci + di, cj + dj))
            if not bucket:
                continue
            for k in keys:
                for r in bucket.get(k, ()):
                    if id(r) in seen:
                        continue
                    seen.add(id(r))
                    if similar(tp, r['tok']):
                        d = metres(lat, lon, r['lat'], r['lon'])
                        if d <= MAX_NAME_METRES:
                            cands.append((d, r))
    fsa_no = house_number(p.get('AddressLine1')) or house_number(p.get('AddressLine2'))
    # A different house number means a different shop (e.g. another branch).
    cands = [(d, r) for d, r in cands if not (fsa_no and r['hn'] and house_number(r['hn']) != fsa_no)]
    if not cands:
        return None, None
    same_no = [r for d, r in cands if fsa_no and house_number(r['hn']) == fsa_no]
    if len(same_no) == 1:
        return 'name', same_no[0]
    if len(cands) == 1:
        return 'name', cands[0][1]
    return None, None   # two same-named places nearby and nothing to tell them apart


def district(postcode):
    pc = re.sub(r'\s+', ' ', (postcode or '').strip().upper())
    if not pc:
        return ''
    out = pc.split(' ')[0] if ' ' in pc else pc[:-3]
    return out if re.fullmatch(r'[A-Z]{1,2}\d[A-Z\d]?', out) else ''


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--osm', default=DEFAULT_OSM, help='Geofabrik .osm.pbf URL or local path')
    ap.add_argument('--region', action='append', help='FSA region name to include, e.g. London (repeatable)')
    ap.add_argument('--out', default='positions', help='output folder')
    ap.add_argument('--cache', default='tools/.cache', help='download cache folder')
    ap.add_argument('--force', action='store_true', help='publish even if the sanity checks fail')
    args = ap.parse_args()

    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    out = Path(args.out)

    places = get_fsa_places(cache, set(args.region or []))
    osm_path = get_osm_file(args.osm, cache)
    print(f'Reading {osm_path.name} …')
    osm_rows = read_osm(osm_path)
    print(f'OpenStreetMap: {len(osm_rows)} named or FSA-tagged places')
    by_id, grid = build_index(osm_rows)

    files = defaultdict(dict)
    stats = {'places': 0, 'id': 0, 'name': 0, 'outside': 0}
    for p in places:
        g = p.get('Geocode') or {}
        try:
            lat, lon = float(g.get('Latitude')), float(g.get('Longitude'))
        except (TypeError, ValueError):
            continue
        d = district(p.get('PostCode'))
        if not d:
            continue
        stats['places'] += 1
        how, r = locate(p, lat, lon, by_id, grid)
        if not how:
            continue
        if not in_uk(r['lat'], r['lon']):
            stats['outside'] += 1   # a mis-tagged OpenStreetMap object; keep the FSA position instead
            continue
        stats[how] += 1
        files[d][str(p['FHRSID'])] = [round(r['lat'], 5), round(r['lon'], 5)]

    exact = stats['id'] + stats['name']
    stats['exact'] = exact
    stats['districts'] = len(files)
    previous = previous_stats(out)
    if previous and previous['regions'] != (args.region or ['United Kingdom']):
        previous = None   # different area (e.g. a London-only test build): nothing to compare with
    summary = summary_line(stats, previous)
    print(summary)

    problems = sanity_check(stats, previous, full_build=not args.region)
    if problems and not args.force:
        report(summary, problems)
        print('Not publishing: the existing positions are left unchanged.')
        return 1

    # Write to a temporary folder, read every file back, then swap it in.
    tmp = out.with_name(out.name + '.tmp')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    for d, entries in sorted(files.items()):
        write_json(tmp / f'{d}.json', entries, compact=True)
    version = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M')
    write_json(tmp / 'index.json', {
        'version': version,
        'built': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'osm': args.osm if args.osm.startswith('http') else Path(args.osm).name,
        'regions': args.region or ['United Kingdom'],
        'licence': 'Positions © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright',
        'stats': {k: stats[k] for k in ('places', 'exact', 'id', 'name', 'districts')},
        'districts': sorted(files),
    })
    read_back = verify_folder(tmp)
    if read_back != exact:
        report(summary, [f'Read back {read_back} positions from the files, expected {exact}.'])
        shutil.rmtree(tmp)
        return 1
    if out.exists():
        shutil.rmtree(out)
    tmp.rename(out)
    report(summary, [])
    print(f'Wrote {len(files)} district files to {out}/ (version {version})')
    return 0


# ---------- checks ----------

def in_uk(lat, lon):
    return 49.8 <= lat <= 61 and -8.7 <= lon <= 2.1


def previous_stats(out):
    """Stats of the build currently published in `out`, read from its files."""
    ix_path = out / 'index.json'
    if not ix_path.exists():
        return None
    try:
        ix = json.loads(ix_path.read_text(encoding='utf-8'))
        exact = sum(len(json.loads((out / f'{d}.json').read_text(encoding='utf-8'))) for d in ix.get('districts', []))
        return {'places': (ix.get('stats') or {}).get('places'), 'exact': exact,
                'districts': len(ix.get('districts', [])), 'regions': ix.get('regions')}
    except (OSError, ValueError):
        return None


def sanity_check(stats, previous, full_build):
    """Reasons not to publish this build (an empty list means it looks fine)."""
    problems = []
    rate = stats['exact'] / max(1, stats['places'])
    if not 0.35 <= rate <= 0.60:
        problems.append(f'Exact-position rate is {rate:.0%}, outside the expected 35-60%.')
    if full_build and stats['places'] < 300_000:
        problems.append(f'Only {stats["places"]:,} FSA places were read; a full UK build has over 400,000.')
    if stats['outside'] > 0.01 * max(1, stats['exact']):
        problems.append(f'{stats["outside"]:,} matched positions fell outside the UK.')
    if previous:
        for key, label in (('places', 'FSA places'), ('exact', 'exact positions'), ('districts', 'district files')):
            before, now = previous.get(key), stats[key]
            if before and now < 0.9 * before:
                problems.append(f'{label.capitalize()} dropped from {before:,} to {now:,} (more than 10%).')
    return problems


def summary_line(stats, previous):
    pct = lambda n: f'{100 * n / max(1, stats["places"]):.0f}%'
    line = (f'{stats["places"]:,} places | {pct(stats["exact"])} exact '
            f'({pct(stats["id"])} by FSA id, {pct(stats["name"])} by name) | {stats["districts"]:,} districts')
    if previous:
        line += f' | previous build: {previous["exact"]:,} exact, {previous["districts"]:,} districts'
    return line


def report(summary, problems):
    """Print the result, and show it on the GitHub Actions run page when running there."""
    for p in problems:
        print(f'CHECK FAILED: {p}')
    step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if step_summary:
        with open(step_summary, 'a', encoding='utf-8') as f:
            f.write(f'### Map positions build\n\n{summary}\n\n')
            f.write('\n'.join(f'- ❌ {p}' for p in problems) if problems else '✅ All checks passed.')
            f.write('\n')


def write_json(path, data, compact=False):
    text = json.dumps(data, separators=(',', ':')) if compact else json.dumps(data, indent=1)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def verify_folder(folder):
    """Read every file back; return the number of positions, raising if anything is malformed."""
    ix = json.loads((folder / 'index.json').read_text(encoding='utf-8'))
    count = 0
    for d in ix['districts']:
        entries = json.loads((folder / f'{d}.json').read_text(encoding='utf-8'))
        for fid, (lat, lon) in entries.items():
            if not fid.isdigit() or not in_uk(lat, lon):
                raise ValueError(f'Bad entry {fid} in {d}.json')
        count += len(entries)
    return count


if __name__ == '__main__':
    sys.exit(main())
