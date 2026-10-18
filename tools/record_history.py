"""Record food hygiene rating history.

The FSA only publishes each place's current rating. This script keeps a history by
saving every place's rating and inspection date, and adding a new entry whenever
either one changes. Run it regularly (the GitHub Action runs it weekly).

    history/index.json          when recording started, last update, counts, districts
    history/<DISTRICT>.json     {"<FHRSID>": [["<rating>", "<inspection date>"], ...], ...}
                                oldest first; e.g. [["1", "2025-03-12"], ["5", "2026-08-03"]]

Usage (from the project root):
    pip install -r tools/requirements.txt
    python tools/record_history.py
"""
import argparse
import datetime as dt
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_positions import district, get_fsa_places  # noqa: E402  (shared FSA download code)

MIN_PLACES = 300_000        # a full UK download has over 450,000 places
MAX_CHANGED_SHARE = 0.30    # more changes than this in one run suggests broken data, not inspections
MAX_NEW_SHARE = 0.20        # likewise for places that are new since the last run


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default='history', help='history folder')
    ap.add_argument('--cache', default='tools/.cache', help='download cache folder')
    ap.add_argument('--force', action='store_true', help='save even if the sanity checks fail')
    args = ap.parse_args()

    out = Path(args.out)
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()

    index_path = out / 'index.json'
    index = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else {}
    history = defaultdict(dict)
    for d in index.get('districts', []):
        f = out / f'{d}.json'
        if f.exists():
            history[d] = json.loads(f.read_text(encoding='utf-8'))
    known = sum(len(v) for v in history.values())

    places = get_fsa_places(cache, set())
    stats = {'places': 0, 'new': 0, 'changed': 0}
    touched = set()
    for p in places:
        d = district(p.get('PostCode'))
        rating = str(p.get('RatingValue') or '').strip()
        if not d or not rating:
            continue
        stats['places'] += 1
        fid = str(p['FHRSID'])
        entry = [rating, str(p.get('RatingDate') or '')[:10]]
        past = history[d].get(fid)
        if past and past[-1] == entry:
            continue
        if past:
            stats['changed'] += 1
            past.append(entry)
        else:
            stats['new'] += 1
            history[d][fid] = [entry]
        touched.add(d)

    summary = (f'{stats["places"]:,} places | {stats["changed"]:,} changed rating or inspection date | '
               f'{stats["new"]:,} new | {len(history):,} districts')
    print(summary)

    problems = []
    if stats['places'] < MIN_PLACES:
        problems.append(f'Only {stats["places"]:,} FSA places were read (expected over {MIN_PLACES:,}).')
    if known and stats['changed'] > MAX_CHANGED_SHARE * known:
        problems.append(f'{stats["changed"]:,} of {known:,} known places changed in one run, which looks like a data problem.')
    if known and stats['new'] > MAX_NEW_SHARE * known:
        problems.append(f'{stats["new"]:,} new places in one run (on top of {known:,} known), which looks like a data problem.')
    before = (index.get('stats') or {}).get('places')
    if before and stats['places'] < 0.9 * before:
        problems.append(f'FSA places dropped from {before:,} to {stats["places"]:,} since the last run (more than 10%).')
    if before and stats['places'] > 1.2 * before:
        problems.append(f'FSA places jumped from {before:,} to {stats["places"]:,} since the last run (more than 20%).')
    report(summary, problems)
    if problems and not args.force:
        print('Not saving: the existing history is left unchanged.')
        return 1

    out.mkdir(parents=True, exist_ok=True)
    for d in sorted(touched):
        write_json(out / f'{d}.json', dict(sorted(history[d].items())), compact=True)
    write_json(index_path, {
        'started': index.get('started', today),
        'updated': today,
        'version': dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M'),
        'source': 'Food Standards Agency open data (Open Government Licence v3.0), recorded weekly',
        'stats': {'places': stats['places'], 'with_history': sum(1 for v in history.values() for e in v.values() if len(e) > 1)},
        'districts': sorted(history),
    })
    print(f'Updated {len(touched)} district files in {out}/')
    return 0


def report(summary, problems):
    for p in problems:
        print(f'CHECK FAILED: {p}')
    step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if step_summary:
        with open(step_summary, 'a', encoding='utf-8') as f:
            f.write(f'### Rating history\n\n{summary}\n\n')
            f.write('\n'.join(f'- ❌ {p}' for p in problems) if problems else '✅ All checks passed.')
            f.write('\n')


def write_json(path, data, compact=False):
    text = json.dumps(data, separators=(',', ':')) if compact else json.dumps(data, indent=1)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


if __name__ == '__main__':
    sys.exit(main())
