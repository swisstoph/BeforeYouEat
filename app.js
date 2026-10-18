'use strict';

/* ---------- Config ---------- */

// Set this to your Buy Me a Coffee / Ko-fi page. Leave empty to hide the link.
const TIP_URL = 'https://ko-fi.com/beforeyoueat';

const API = 'https://api.ratings.food.gov.uk';
const POSTCODES_API = 'https://api.postcodes.io';
const PAGE_SIZE = 50;
const MAX_DISTANCE_MILES = 5;
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_MAX_PLACES = 300;
const CACHE_MAX_LISTS = 6;
const COVERAGE = 'the UK';   // where the app has ratings
const AREA_LABEL = 'map area';   // query label for "Search this area" results
const AREA_MAX_PAGES = 6;        // "Search this area" loads at most this many pages (300 places)

// FSA business types (from GET /BusinessTypes/basic).
const BUSINESS_TYPES = [
  { id: 1,    name: 'Restaurants, cafés and canteens', food: true },
  { id: 7844, name: 'Takeaways and sandwich shops',    food: true },
  { id: 7843, name: 'Pubs, bars and nightclubs',       food: true },
  { id: 7840, name: 'Supermarkets',                    food: true },
  { id: 4613, name: 'Other retailers',                 food: true },
  { id: 7846, name: 'Mobile caterers' },
  { id: 7841, name: 'Other catering premises' },
  { id: 7842, name: 'Hotels, B&Bs and guest houses' },
  { id: 7845, name: 'Schools, colleges and universities' },
  { id: 5,    name: 'Hospitals, childcare and care homes' },
  { id: 7,    name: 'Distributors and transporters' },
  { id: 7839, name: 'Manufacturers and packers' },
  { id: 14,   name: 'Importers and exporters' },
  { id: 7838, name: 'Farmers and growers' },
];

// FSA wording for each overall rating.
const RATINGS = {
  '5': { cls: 'good', label: 'Very good' },
  '4': { cls: 'good', label: 'Good' },
  '3': { cls: 'ok',   label: 'Generally satisfactory' },
  '2': { cls: 'poor', label: 'Improvement necessary' },
  '1': { cls: 'poor', label: 'Major improvement necessary' },
  '0': { cls: 'poor', label: 'Urgent improvement necessary' },
  AwaitingInspection:  { cls: 'none', word: 'Awaiting', label: 'Awaiting inspection' },
  AwaitingPublication: { cls: 'none', word: 'Pending',  label: 'Awaiting publication' },
  Exempt:              { cls: 'none', word: 'Exempt',   label: 'Exempt' },
  // Scotland's Food Hygiene Information Scheme: a different scale, so different colours.
  'Pass':                 { cls: 'fhis-pass',    word: 'Pass',     label: 'Pass',                 pin: '✓' },
  'Pass and Eat Safe':    { cls: 'fhis-pass',    word: 'Pass',     label: 'Pass and Eat Safe',    pin: '✓' },
  'Improvement Required': { cls: 'fhis-improve', word: 'Improve',  label: 'Improvement required', pin: '!' },
  'Awaiting Inspection':  { cls: 'none',         word: 'Awaiting', label: 'Awaiting inspection' },
  'Awaiting Publication': { cls: 'none',         word: 'Pending',  label: 'Awaiting publication' },
};

// Sub-score areas, named as on the FSA ratings site. Lower scores are better.
const SCORE_AREAS = [
  { key: 'Hygiene', category: 'Hygiene', name: 'Hygienic food handling',
    about: 'How food is prepared, cooked, reheated, cooled and stored: safe temperatures, keeping raw and ready-to-eat food apart, and handwashing.' },
  { key: 'Structural', category: 'Structural', name: 'Cleanliness and condition of facilities and building',
    about: 'How clean the premises are, and their layout, repair, lighting, ventilation, handwashing facilities and pest control.' },
  { key: 'ConfidenceInManagement', category: 'Confidence', name: 'Management of food safety',
    about: 'Whether the business has a system, records and trained, supervised staff to keep food safe between inspections, and how it has dealt with problems before.' },
];

// Shown, collapsed, under low ratings (0 to 2, or Improvement required in Scotland).
function lowRatingNote(p) {
  const fhrs = p.SchemeType !== 'FHIS';
  return `<details class="finding-note">
    <summary>What does a low rating mean?</summary>
    <p>The inspector found things that need to improve${fhrs ? ': the lower the number, the more needs fixing, and the more urgently' : ''}.
      It doesn't mean the food will make you ill. A business that is an immediate risk to health would be closed, not given a rating.</p>
    <p>The council follows up low ratings. The business can fix the problems and ask to be re-inspected${fhrs ? ', appeal within 21 days, or publish a reply, which is shown on this page when there is one' : ''}.</p>
  </details>`;
}
// Fallback when the ScoreDescriptors call is unavailable (offline).
const SCORE_WORDS = {
  0: 'Very good', 5: 'Good', 10: 'Generally satisfactory', 15: 'Improvement necessary',
  20: 'Major improvement necessary', 25: 'Urgent improvement necessary', 30: 'Urgent improvement necessary',
};

/* ---------- Settings (on device) ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('sotd:' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('sotd:' + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const settings = {
  types: store.get('types', BUSINESS_TYPES.filter(t => t.food).map(t => t.id)),
  units: store.get('units', 'metric'),
};
function saveSettings() { store.set('types', settings.types); store.set('units', settings.units); }

/* ---------- Helpers ---------- */

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ratingOf(p) {
  return RATINGS[p.RatingValue] || { cls: 'none', word: p.RatingValue || '?', label: p.RatingValue || 'Unknown' };
}

function tileHtml(p) {
  const r = ratingOf(p);
  const big = r.word
    ? `<span class="word">${esc(r.word)}</span>`
    : `<span class="num">${esc(p.RatingValue)}</span>`;
  const label = r.word && r.word.toLowerCase() === r.label.toLowerCase() ? '' : `<span class="label">${esc(r.label)}</span>`;
  const shade = r.word ? '' : ` r${p.RatingValue}`;
  return `<div class="tile ${r.cls}${shade}" role="img" aria-label="Rating: ${esc(r.word ? r.label : p.RatingValue + ' out of 5, ' + r.label)}">${big}${label}</div>`;
}

function inspectionDate(p, style = 'short') {
  if (!p.RatingDate) return null;
  const d = new Date(p.RatingDate);
  if (isNaN(d) || d.getFullYear() < 1990) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: style, year: 'numeric' });
}

function distanceMetres(p, origin) {
  const lat = parseFloat(p.geocode?.latitude), lon = parseFloat(p.geocode?.longitude);
  if (origin && isFinite(lat) && isFinite(lon)) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat - origin.lat) * rad, dLon = (lon - origin.lon) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(origin.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  return typeof p.Distance === 'number' ? p.Distance * 1609.344 : null; // API distance is in miles
}

function formatDistance(m) {
  if (m == null) return '';
  if (settings.units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(10, Math.round(ft / 10) * 10)} ft`;
    return `${(m / 1609.344).toFixed(1)} mi`;
  }
  if (m < 1000) return `${Math.max(5, Math.round(m / 5) * 5)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function address(p) {
  return [p.AddressLine1, p.AddressLine2, p.AddressLine3, p.AddressLine4, p.PostCode]
    .map(s => (s || '').trim()).filter(Boolean);
}

function timeAgo(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/* ---------- Network ---------- */

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function api(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { 'x-api-version': '2', Accept: 'application/json' } });
  } catch {
    throw new ApiError(navigator.onLine === false
      ? "You're offline."
      : "Couldn't reach the ratings service. Check your signal and try again.", 0);
  }
  if (res.status === 403 || res.status === 429) {
    throw new ApiError('The ratings service is busy. Please try again in a minute.', res.status);
  }
  if (!res.ok) throw new ApiError(`The ratings service returned an error (${res.status}).`, res.status);
  return res.json();
}

/* ---------- Place cache (for details and patchy signal) ---------- */

const places = new Map(store.get('places', []).map(p => [String(p.FHRSID), p]));

function rememberPlaces(list) {
  for (const p of list) { places.delete(String(p.FHRSID)); places.set(String(p.FHRSID), p); }
  while (places.size > CACHE_MAX_PLACES) places.delete(places.keys().next().value);
  store.set('places', [...places.values()]);
}

/* ---------- Lists ----------
   Each list screen (#/ for "near me", #/search?q=… for a search) keeps its own state,
   so going Back shows the earlier list where you left it, without asking the API again. */

function newList(key) {
  return {
    key,
    query: null,       // { kind: 'near', lat, lon, label } or { kind: 'name', q, lat?, lon? }
    origin: null,      // { lat, lon } for distances
    page: 0,
    totalPages: 1,
    loading: false,
    shown: 0,
    rawCount: 0,       // places the API returned, before the type filter
    message: '',       // explains an empty result (e.g. outside the UK), shown in list and map
    saved: [],         // places shown, in order
    status: '',
    offline: '',
    scrollY: 0,
    viewWidth: 0,      // map width (metres) when these results were first shown
  };
}

let state = newList(null);
const lists = new Map();   // key -> list state, for lists you can go back to
let token = 0;             // bumps whenever the visible list changes, so stale responses are ignored
let lastFix = null;        // last GPS position, used to sort name searches by distance

const listEl = $('#list'), statusEl = $('#status'), endEl = $('#list-end'), offlineEl = $('#offline');

function setStatus(text) { state.status = text; statusEl.textContent = text; }
function setOffline(text) { state.offline = text; offlineEl.textContent = text; offlineEl.hidden = !text; }

function clearListDom() {
  listEl.innerHTML = '';
  endEl.hidden = true;
  setOffline('');
  fittedFor = null;
  refreshMap();
  updateInstallTip();
}

function resetList(query, statusText) {
  token++;
  Object.assign(state, newList(state.key), { query });
  state.origin = query.lat != null ? { lat: query.lat, lon: query.lon } : null;
  clearListDom();
  setStatus(statusText);
  loadMore();
}

function rowHtml(p) {
  const meta = [p.BusinessType, inspectionDate(p) ? `Inspected ${inspectionDate(p)}` : 'No inspection date']
    .filter(Boolean).map(esc).join(' · ');
  return `<li><a class="row-link" href="#/place/${encodeURIComponent(p.FHRSID)}">
    <div class="tile-wrap">${tileHtml(p)}</div>
    <div class="row-main"><div class="row-name">${esc(p.BusinessName)}</div><div class="row-meta">${meta}</div></div>
    <div class="row-dist">${esc(formatDistance(distanceMetres(p, state.origin)))}</div>
  </a></li>`;
}

function appendPlaces(list) {
  const shown = [];
  state.rawCount += list.length;
  for (const p of list) {
    if (state.query.kind === 'near' && !settings.types.includes(p.BusinessTypeID)) continue;
    shown.push(p);
  }
  listEl.insertAdjacentHTML('beforeend', shown.map(rowHtml).join(''));
  state.shown += shown.length;
  state.saved.push(...shown);
  refreshMap();
  updateInstallTip();
  return shown.length;
}

function queryParams(q, page) {
  const base = { pageNumber: page, pageSize: PAGE_SIZE };
  if (q.kind === 'near') {
    return { ...base, latitude: q.lat, longitude: q.lon, maxDistanceLimit: MAX_DISTANCE_MILES, sortOptionKey: 'distance' };
  }
  if (q.lat != null) {
    return { ...base, name: q.q, latitude: q.lat, longitude: q.lon, sortOptionKey: 'distance' };
  }
  return { ...base, name: q.q, sortOptionKey: 'relevance' };
}

let autoLoads = 0;

async function loadMore() {
  if (state.loading || !state.query || state.page >= state.totalPages) return;
  if (state.query.kind === 'near' && !settings.types.length) {
    endEl.hidden = false;
    endEl.innerHTML = 'No types of place are selected. <a href="#/settings">Choose some in Settings</a>.';
    if (mode === 'map') updateMapBar();
    return;
  }
  state.loading = true;
  const mine = token;
  const page = state.page + 1;
  endEl.hidden = false;
  endEl.textContent = 'Loading…';
  if (mode === 'map') updateMapBar();
  let failed = null;
  try {
    const data = await api('/Establishments', queryParams(state.query, page));
    if (mine !== token) return;
    const list = data.establishments || [];
    state.page = page;
    state.totalPages = data.meta?.totalPages || page;
    rememberPlaces(list);
    const added = appendPlaces(list);
    setOffline('');
    saveListSnapshot();
    updateListFooter();
    const q = state.query;
    const furthest = list.length ? distanceMetres(list[list.length - 1], state.origin) : Infinity;
    if (q.label === AREA_LABEL && q.radius && furthest < q.radius && state.page < AREA_MAX_PAGES && state.page < state.totalPages) {
      // "Search this area": keep loading until the visible map is covered (or the cap is reached).
      setTimeout(loadMore, 400);
    } else {
      // Keep filling the screen when a page was mostly filtered out.
      autoLoads = added < 10 ? autoLoads + 1 : 0;
      if (autoLoads < 5 && sentinelNearViewport()) setTimeout(loadMore, 300);
    }
  } catch (e) {
    if (mine !== token) return;
    if (state.page === 0 && showListSnapshot(e.message)) return;
    failed = e.message;
    endEl.hidden = false;
    endEl.innerHTML = `${esc(e.message)} <button type="button" class="link-btn" id="retry">Try again</button>`;
    $('#retry').onclick = () => loadMore();
  } finally {
    if (mine === token) {
      state.loading = false;
      if (mode === 'map') {
        updateMapBar();
        if (failed) {
          $('#map-bar').innerHTML = `<span>${esc(failed)}</span><button type="button" class="link-btn" id="map-retry">Try again</button>`;
          $('#map-retry').onclick = () => loadMore();
        }
      }
    }
  }
}

function updateListFooter() {
  if (state.message) { endEl.hidden = false; endEl.innerHTML = state.message; return; }
  if (!state.query || state.page === 0) { endEl.hidden = true; return; }
  const done = state.page >= state.totalPages;
  if (!done) { endEl.hidden = true; return; }
  endEl.hidden = false;
  if (state.shown === 0) {
    endEl.textContent = state.query.kind !== 'near'
        ? 'No places found with that name.'
        : state.rawCount
          ? `No places within ${MAX_DISTANCE_MILES} miles match your settings.`
          : `No rated places within ${MAX_DISTANCE_MILES} miles. Before You Eat covers ${COVERAGE}.`;
  } else {
    endEl.textContent = state.query.kind === 'near'
      ? `That's everything within ${MAX_DISTANCE_MILES} miles.`
      : "That's all the results.";
  }
}

// On the map, more places load only when asked for.
function sentinelNearViewport() {
  return mode === 'list' && $('#sentinel').getBoundingClientRect().top < window.innerHeight + 600;
}

new IntersectionObserver(entries => {
  if (entries.some(e => e.isIntersecting) && !$('#view-list').hidden && mode === 'list') { autoLoads = 0; loadMore(); }
}, { rootMargin: '600px 0px' }).observe($('#sentinel'));

// Show a list that is already in memory, exactly as it was left.
function restoreList(saved) {
  token++;
  state = saved;
  state.loading = false;
  listEl.innerHTML = state.saved.map(rowHtml).join('');
  statusEl.textContent = state.status;
  offlineEl.textContent = state.offline;
  offlineEl.hidden = !state.offline;
  updateListFooter();
  refreshMap();
  updateInstallTip();
  if (mode === 'list') window.scrollTo(0, state.scrollY);
}

/* ---------- Last results snapshot (patchy signal) ---------- */

function saveListSnapshot() {
  store.set('snapshot', {
    savedAt: Date.now(),
    query: state.query,
    status: state.status,
    items: state.saved.slice(0, 150),
  });
}

function showListSnapshot(reason) {
  const snap = store.get('snapshot', null);
  if (!snap || !snap.items?.length) return false;
  state.query = snap.query;
  state.origin = snap.query.lat != null ? { lat: snap.query.lat, lon: snap.query.lon } : null;
  state.page = state.totalPages = 1; // stop infinite scroll on stale data
  state.saved = [];
  state.shown = 0;
  listEl.innerHTML = '';
  appendPlaces(snap.items);
  setStatus(snap.status || 'Saved results');
  const old = Date.now() - snap.savedAt > 7 * 24 * 3600 * 1000;
  setOffline(`${reason} Showing results saved ${timeAgo(snap.savedAt)}.${old ? ' Ratings may have changed since.' : ''}`.trim());
  endEl.hidden = true;
  return true;
}

/* ---------- Location ---------- */

// A generous box around the UK. Places just inside it with no ratings (e.g. the Republic of
// Ireland or the French coast) still get a clear "no rated places" message from the list.
function inUK(lat, lon) {
  return lat >= 49.8 && lat <= 61 && lon >= -8.7 && lon <= 2.1;
}

function locate() {
  const mine = ++token;
  Object.assign(state, newList(state.key));
  clearListDom();
  if (!('geolocation' in navigator)) {
    setStatus('Location is not available on this device. Search by name or postcode.');
    if (!showListSnapshot('Location is not available.')) $('#q').focus();
    return;
  }
  setStatus('Finding your location…');

  const found = pos => {
    if (mine !== token) return;
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (!inUK(lat, lon)) {
      // Abroad: say so instead of an empty "nothing nearby" list. Searching still works.
      setStatus('You seem to be outside the UK');
      state.message = `Before You Eat covers ${esc(COVERAGE)}. Search a UK postcode or place name above to check ratings before you go.`;
      updateListFooter();
      refreshMap();
      return;
    }
    lastFix = { lat, lon };
    const acc = accuracy ? ` (accurate to about ${formatDistance(accuracy)})` : '';
    resetList({ kind: 'near', lat, lon, label: 'you' }, `Nearest to you${acc}`);
  };

  const failed = err => {
    if (mine !== token) return;
    const denied = err.code === err.PERMISSION_DENIED;
    setStatus(denied
      ? 'Location is turned off for this app. Search by name or postcode instead.'
      : "Couldn't get your location. Check that Location is switched on in your device's settings, or search by name or postcode.");
    if (!showListSnapshot(denied ? 'Location is turned off for this app.'
      : "Couldn't get your location: check that Location is switched on in your device's settings.")) $('#q').focus();
  };

  // First try for a precise fix (GPS). Devices without GPS, such as most tablets, often time out
  // on that, so then ask again for a quicker Wi-Fi/network-based position.
  navigator.geolocation.getCurrentPosition(found, err => {
    if (mine !== token) return;
    if (err.code === err.PERMISSION_DENIED) { failed(err); return; }
    setStatus('Finding your location… (using Wi-Fi)');
    navigator.geolocation.getCurrentPosition(found, failed,
      { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 });
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
}

$('#locate').addEventListener('click', () => {
  lists.delete('#/');
  if (state.key === '#/') locate();
  else go(listHash('#/', mode === 'map'));
});

/* ---------- Search ---------- */

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i;

function tidyPostcode(s) {
  const t = s.toUpperCase().replace(/\s+/g, '');
  return t.length > 4 ? `${t.slice(0, -3)} ${t.slice(-3)}` : t;
}

// Turn a full postcode ("SW1A 2AA") or district ("SW1A") into coordinates.
// Returns { lat, lon }, or null if the postcode doesn't exist.
async function geocodePostcode(pc) {
  const full = pc.includes(' ');
  const url = `${POSTCODES_API}/${full ? 'postcodes' : 'outcodes'}/${encodeURIComponent(pc.replace(/\s+/g, ''))}`;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) return null;
    if (res.ok) {
      const r = (await res.json()).result;
      if (typeof r?.latitude === 'number' && typeof r?.longitude === 'number') return { lat: r.latitude, lon: r.longitude };
    }
  } catch { /* postcodes.io unreachable: fall back to the FSA */ }
  return geocodeViaFsa(pc);
}

// Fallback: centre on a rated place at that postcode.
async function geocodeViaFsa(pc) {
  const data = await api('/Establishments', { address: pc, pageSize: 20 });
  const compact = pc.replace(/\s+/g, '');
  const hit = (data.establishments || []).find(p => {
    const theirs = (p.PostCode || '').toUpperCase().trim();
    const same = pc.includes(' ') ? theirs.replace(/\s+/g, '') === compact : theirs.split(/\s+/)[0] === pc;
    return same && isFinite(parseFloat(p.geocode?.latitude));
  });
  return hit ? { lat: parseFloat(hit.geocode.latitude), lon: parseFloat(hit.geocode.longitude) } : null;
}

async function runSearch(q) {
  if (POSTCODE.test(q)) {
    const pc = tidyPostcode(q);
    const mine = ++token;
    clearListDom();
    setStatus(`Looking up ${pc}…`);
    try {
      const spot = await geocodePostcode(pc);
      if (mine !== token) return;
      if (!spot) { setStatus(`Couldn't find ${pc}. Check the postcode, or search by business name.`); return; }
      resetList({ kind: 'near', lat: spot.lat, lon: spot.lon, label: pc }, `Nearest to ${pc}`);
    } catch (e) {
      if (mine === token) setStatus(e.message);
    }
    return;
  }
  resetList({ kind: 'name', q, lat: lastFix?.lat, lon: lastFix?.lon },
    lastFix ? `“${q}”, nearest first` : `Results for “${q}”`);
}

$('#search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  $('#q').blur();
  const key = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
  if (key === state.key && !$('#view-list').hidden) { lists.delete(key); state.key = null; }
  go(listHash(key, mode === 'map'));
});

/* ---------- Add to home screen tip ----------
   Shown on phones once results have loaded, until installed or dismissed. */

let installPrompt = null;   // Chrome/Android's install event, kept for the Install button

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPhone = () => matchMedia('(pointer: coarse)').matches;
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Share"><path fill="currentColor" d="M12 2 7.5 6.5l1.4 1.4L11 5.8V15h2V5.8l2.1 2.1 1.4-1.4zM5 10v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V10h-3v2h1v8H7v-8h1v-2z"/></svg>';

function updateInstallTip() {
  const tip = $('#install-tip');
  // Phones only: on a computer the tip is clutter, even where the browser can install apps.
  const show = !isInstalled() && !store.get('installTipDismissed', false) && isPhone() && state.shown > 0;
  tip.hidden = !show;
  if (!show) return;
  $('#install-btn').hidden = !installPrompt;
  $('#install-text').innerHTML = installPrompt
    ? 'Add Before You Eat to your home screen for one-tap access.'
    : isIOS()
      ? `Add it to your home screen: tap Share ${SHARE_ICON} then <strong>Add to Home Screen</strong>.`
      : 'Add it to your home screen from your browser menu (⋮ then <strong>Add to Home screen</strong>).';
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  updateInstallTip();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-tip').hidden = true;
});
$('#install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  updateInstallTip();
});
$('#install-close').addEventListener('click', () => {
  store.set('installTipDismissed', true);
  $('#install-tip').hidden = true;
});

/* ---------- Welcome (first launch) ---------- */

// Location is only requested once the user taps "Use my location".
$('#welcome-locate').addEventListener('click', () => {
  store.set('welcomed', true);
  route();
});

$('#welcome-search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#welcome-q').value.trim();
  if (!q) { $('#welcome-q').focus(); return; }
  $('#welcome-q').blur();
  store.set('welcomed', true);
  go(`#/search?q=${encodeURIComponent(q)}`);
});

/* ---------- Detail view ---------- */

const detailEl = $('#view-detail');

async function showDetail(id) {
  let p = places.get(String(id)) || state.saved.find(x => String(x.FHRSID) === String(id));
  if (!p) {
    detailEl.innerHTML = `<p class="status center">Loading…</p>`;
    try {
      p = await api(`/Establishments/${encodeURIComponent(id)}`);
      rememberPlaces([p]);
    } catch (e) {
      detailEl.innerHTML = `<p class="notice">${esc(e.message)}</p>`;
      return;
    }
  }
  if (parseRoute().id !== String(id)) return; // user has moved on
  renderDetail(p);
  loadScoreWords(p);
}

function renderDetail(p) {
  const r = ratingOf(p);
  const date = inspectionDate(p, 'long');
  const dist = distanceMetres(p, state.origin);
  const addr = address(p);
  const mapsQuery = [p.BusinessName, ...addr].join(', ');
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery);
  const hasScores = p.scores && SCORE_AREAS.some(a => p.scores[a.key] != null);

  detailEl.innerHTML = `
    <article class="detail">
      <div class="detail-hero">
        ${tileHtml(p)}
        <div>
          <div class="detail-label">${esc(r.label)}</div>
          <div class="detail-date">${date ? `Inspected ${esc(date)}` : 'No inspection date'}</div>
          ${dist != null && state.origin && state.query?.label !== AREA_LABEL ? `<div class="detail-date">${esc(formatDistance(dist))} away</div>` : ''}
        </div>
      </div>
      <h1>${esc(p.BusinessName)}</h1>
      <p class="type">${esc(p.BusinessType)}</p>
      ${p.NewRatingPending ? '<p class="notice">A new rating for this business is waiting to be published.</p>' : ''}
      ${p.SchemeType === 'FHIS' ? `<p class="notice">Scotland uses the Food Hygiene Information Scheme instead of 0 to 5 ratings.
        <strong>Pass</strong> means the business met the legal requirements for food hygiene when it was inspected;
        <strong>Improvement required</strong> means it did not.</p>` : ''}

      ${hasScores ? `
        <h2>Inspection findings</h2>
        <ul class="scores" id="scores">
          ${SCORE_AREAS.map(a => `<li><details>
            <summary><span class="area">${esc(a.name)}</span>
              <span class="verdict" data-area="${a.category}">${esc(SCORE_WORDS[p.scores[a.key]] ?? '—')}</span></summary>
            <p>${esc(a.about)}</p>
          </details></li>`).join('')}
        </ul>` : ''}
      ${['0', '1', '2', 'Improvement Required'].includes(p.RatingValue) ? lowRatingNote(p) : ''}

      <dl class="facts">
        <dt>Address</dt>
        <dd>${addr.length ? addr.map(esc).join('<br>') : 'Not published'}</dd>
        <dt>Local authority</dt>
        <dd>${esc(p.LocalAuthorityName || 'Unknown')}
          ${p.LocalAuthorityWebSite ? `<br><a href="${esc(p.LocalAuthorityWebSite)}" target="_blank" rel="noopener">Council website</a>` : ''}
          ${p.LocalAuthorityEmailAddress ? `<br><a href="mailto:${esc(p.LocalAuthorityEmailAddress)}">${esc(p.LocalAuthorityEmailAddress)}</a>` : ''}
        </dd>
        ${p.RightToReply ? `<dt>The business's response</dt><dd>${esc(p.RightToReply)}</dd>` : ''}
      </dl>

      <div class="actions">
        <a class="btn" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Google Maps</a>
        <a class="btn secondary" href="https://ratings.food.gov.uk/business/${encodeURIComponent(p.FHRSID)}" target="_blank" rel="noopener">View on the FSA website</a>
      </div>
      <p class="small">The rating shows how well the business was doing on the day of inspection. It is not a guide to food quality.
        Data from the Food Standards Agency, under the Open Government Licence.</p>
    </article>`;
}

// Use the FSA's own descriptors for the sub-scores when we can reach the API.
async function loadScoreWords(p) {
  if (!p.scores) return;
  try {
    const data = await api('/ScoreDescriptors', { establishmentId: p.FHRSID });
    for (const d of data.scoreDescriptors || []) {
      const el = detailEl.querySelector(`[data-area="${d.ScoreCategory}"]`);
      if (el && d.Description) el.textContent = d.Description;
    }
  } catch { /* keep the built-in wording */ }
}

/* ---------- Settings view ---------- */

function renderSettings() {
  $('#types').innerHTML = BUSINESS_TYPES.map(t => `
    <label class="row"><input type="checkbox" value="${t.id}" ${settings.types.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('');
  for (const r of document.querySelectorAll('input[name="units"]')) r.checked = r.value === settings.units;
  updateTypesSummary();
  updateUnitsSummary();
}

function updateUnitsSummary() {
  $('#units-summary').textContent = settings.units === 'imperial' ? 'Feet' : 'Metres';
}

// The collapsed "Places to show" heading says what's currently chosen.
function updateTypesSummary() {
  const chosen = settings.types;
  const food = BUSINESS_TYPES.filter(t => t.food).map(t => t.id);
  $('#types-summary').textContent =
    !chosen.length ? 'None'
    : chosen.length === BUSINESS_TYPES.length ? 'All'
    : chosen.length === food.length && food.every(id => chosen.includes(id)) ? 'Food & drink'
    : `${chosen.length} ${chosen.length === 1 ? 'type' : 'types'}`;
}

// Lists in memory were built with the old settings, so rebuild them when next shown.
function settingsChanged() {
  lists.clear();
  if (state.query) state.stale = true;
}

for (const b of document.querySelectorAll('[data-types]')) {
  b.addEventListener('click', () => {
    const pick = b.dataset.types;
    settings.types = pick === 'all' ? BUSINESS_TYPES.map(t => t.id)
      : pick === 'food' ? BUSINESS_TYPES.filter(t => t.food).map(t => t.id)
      : [];
    saveSettings();
    settingsChanged();
    renderSettings();
  });
}

$('#types').addEventListener('change', () => {
  settings.types = [...document.querySelectorAll('#types input:checked')].map(i => Number(i.value));
  saveSettings();
  settingsChanged();
  updateTypesSummary();
});
for (const r of document.querySelectorAll('input[name="units"]')) {
  r.addEventListener('change', () => { settings.units = r.value; saveSettings(); settingsChanged(); updateUnitsSummary(); });
}

if (TIP_URL) { $('#tip-link').href = TIP_URL; $('#tip').hidden = false; }

/* ---------- Map view ----------
   Shows the places already loaded for the current list, so it costs no extra FSA requests.
   Leaflet is bundled in vendor/ and only loaded the first time the map is opened. */

let mode = 'list';          // 'list' or 'map' for the current results
let map = null;             // Leaflet map, created once
let markerLayer = null;
let fittedFor = null;       // list state the map view was last fitted to
let fittedWithItems = false;
let leafletPromise = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'vendor/leaflet/leaflet.js';
    js.onload = resolve;
    js.onerror = () => { leafletPromise = null; js.remove(); reject(new Error('map failed to load')); };
    document.head.appendChild(js);
  });
  return leafletPromise;
}

function sizeMap() {
  const el = $('#map');
  const top = el.getBoundingClientRect().top;
  el.style.height = `${Math.max(280, window.innerHeight - top - 52)}px`;
  map?.invalidateSize();
}
window.addEventListener('resize', () => { if (mode === 'map' && !$('#view-list').hidden) sizeMap(); });

async function ensureMap() {
  await loadLeaflet();
  if (map) return;
  // Resizing is handled by sizeMap(), only while the map is visible.
  map = L.map('map', { zoomControl: true, attributionControl: true, trackResize: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on('click', closeMapCard);
  // Fanned pins are spaced in screen pixels, so lay them out again at each zoom level.
  map.on('zoomend', () => { if (mode === 'map') renderMarkers(); });
  map.on('moveend', () => { if (mode === 'map') updateMapBar(); });
}

function pinHtml(p, count) {
  const r = ratingOf(p);
  const shade = r.word ? '' : ` r${p.RatingValue}`;
  const text = r.pin || (r.word ? '–' : p.RatingValue);
  const badge = count > 1 ? `<span class="count">${count}</span>` : '';
  return `<div class="pin ${r.cls}${shade}">${esc(text)}${badge}</div>`;
}

/* Exact positions matched from OpenStreetMap (built by tools/build_positions.py).
   The FSA often gives only the postcode's centre point; these files hold the real spot
   where OpenStreetMap has the place. positions/index.json is checked each time the app
   starts online, so a new build reaches phones on their next launch. */

const exactPos = new Map();                 // FHRSID -> [lat, lon]
const loadedDistricts = new Map();          // district -> Promise
let positionsIndex = null;                  // Promise of { version, districts: Set }

function getPositionsIndex() {
  positionsIndex ??= fetch('positions/index.json', { cache: 'no-cache' })
    .then(res => (res.ok ? res.json() : null))
    .then(ix => (ix ? { version: ix.version, districts: new Set(ix.districts || []) } : null))
    .catch(() => null);
  return positionsIndex;
}

function districtOf(postcode) {
  const pc = String(postcode || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const out = pc.includes(' ') ? pc.split(' ')[0] : pc.slice(0, -3);
  return /^[A-Z]{1,2}\d[A-Z\d]?$/.test(out) ? out : '';
}

// Load position files for the districts in this list. Resolves true if anything new arrived.
async function loadPositionsFor(list) {
  const ix = await getPositionsIndex();
  if (!ix) return false;
  const wanted = [...new Set(list.map(p => districtOf(p.PostCode)))]
    .filter(d => d && ix.districts.has(d) && !loadedDistricts.has(d));
  if (!wanted.length) return false;
  await Promise.all(wanted.map(d => {
    const job = fetch(`positions/${d}.json?v=${ix.version}`)
      .then(res => (res.ok ? res.json() : {}))
      .then(entries => { for (const [id, ll] of Object.entries(entries)) exactPos.set(id, ll); })
      .catch(() => loadedDistricts.delete(d)); // try again next time
    loadedDistricts.set(d, job);
    return job;
  }));
  return true;
}

function positionOf(p) {
  const exact = exactPos.get(String(p.FHRSID));
  if (exact) return { lat: exact[0], lon: exact[1] };
  return { lat: parseFloat(p.geocode?.latitude), lon: parseFloat(p.geocode?.longitude) };
}

// From this zoom in every place gets its own pin, nudged apart where they would overlap.
// Further out, pins that would overlap are merged into one pin with a count.
const FAN_ZOOM = 18;
const PIN_GAP = 38;          // px between pin centres (pins are 34px)
let clusteredNow = false;    // any merged pins on screen (for the "zoom in" hint)

function placesWithPosition(list, zoom) {
  const out = [];
  for (const p of list) {
    const { lat, lon } = positionOf(p);
    if (isFinite(lat) && isFinite(lon)) out.push({ p, lat, lon, px: map.project([lat, lon], zoom) });
  }
  return out;
}

// Zoomed out: merge pins whose centres are closer than a pin's width.
function clusterPins(pts) {
  const clusters = [];
  for (const pt of pts) {
    const c = clusters.find(c => c.seed.distanceTo(pt.px) < PIN_GAP - 4);
    if (c) c.items.push(pt);
    else clusters.push({ seed: pt.px, items: [pt] });
  }
  return clusters;
}

// Street level: push overlapping pins apart until none touch, staying close to their true spots.
function spreadPins(pts) {
  const pos = pts.map((pt, i) => {
    // Start places with identical positions on a small circle so they can separate.
    const twins = pts.filter((q, j) => j < i && q.px.distanceTo(pt.px) < 0.5).length;
    const a = twins * 2.4;
    return L.point(pt.px.x + Math.cos(a) * twins * 2, pt.px.y + Math.sin(a) * twins * 2);
  });
  for (let round = 0; round < 80; round++) {
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= PIN_GAP) continue;
        const push = (PIN_GAP - d) / 2, ux = dx / d, uy = dy / d;
        pos[i] = L.point(pos[i].x - ux * push, pos[i].y - uy * push);
        pos[j] = L.point(pos[j].x + ux * push, pos[j].y + uy * push);
        moved = true;
      }
    }
    if (!moved) break;
    // Gentle pull back towards the true spot keeps the layout compact.
    for (let i = 0; i < pos.length; i++) {
      pos[i] = L.point(pos[i].x + (pts[i].px.x - pos[i].x) * 0.04, pos[i].y + (pts[i].px.y - pos[i].y) * 0.04);
    }
  }
  return pos;
}

function addPin(latlng, group, count) {
  const first = group.places[0];
  const label = count > 1
    ? `${count} places, including ${first.BusinessName}`
    : `${first.BusinessName}, rating ${ratingOf(first).label}`;
  const marker = L.marker(latlng, {
    icon: L.divIcon({ className: 'pin-icon', html: pinHtml(first, count), iconSize: [34, 34], iconAnchor: [17, 17] }),
    title: label,
    alt: label,
    keyboard: true,
  });
  marker.on('click', e => { L.DomEvent.stopPropagation(e); openMapCard(group, marker); });
  marker.addTo(markerLayer);
  if (group.key === activeKey && !$('#map-card').hidden) {
    activePin = marker.getElement()?.querySelector('.pin');
    activePin?.classList.add('active');
  }
}

function renderMarkers() {
  if (!map) return;
  // Draw now with what we have; redraw if exact positions arrive for these places.
  const shownState = state;
  loadPositionsFor(state.saved).then(changed => {
    if (changed && state === shownState && mode === 'map') renderMarkers();
  });
  markerLayer.clearLayers();
  // Frame the results first: pin layout depends on the zoom level.
  fitMap(state.saved.map(positionOf).filter(q => isFinite(q.lat) && isFinite(q.lon)));
  if (!mapHasView && state.message) { map.setView([54.0, -2.5], 5, { animate: false }); mapHasView = true; } // e.g. abroad: show the UK
  if (!mapHasView) { updateMapBar(); return; }
  const zoom = map.getZoom();
  const pts = placesWithPosition(state.saved, zoom);
  clusteredNow = false;
  if (zoom < FAN_ZOOM) {
    for (const c of clusterPins(pts)) {
      const first = c.items[0];
      if (c.items.length > 1) clusteredNow = true;
      addPin([first.lat, first.lon], { key: `c:${first.p.FHRSID}`, places: c.items.map(i => i.p) }, c.items.length);
    }
  } else {
    const spread = spreadPins(pts);
    const dots = new Set();
    pts.forEach((pt, i) => {
      const at = map.unproject(spread[i], zoom);
      // Pins nudged off their true spot get a thin line back to a small dot there.
      if (spread[i].distanceTo(pt.px) > 8) {
        L.polyline([[pt.lat, pt.lon], at], { color: '#1f2328', weight: 1.5, opacity: 0.7, interactive: false }).addTo(markerLayer);
        const k = `${pt.lat},${pt.lon}`;
        if (!dots.has(k)) {
          dots.add(k);
          L.circleMarker([pt.lat, pt.lon], { radius: 3.5, weight: 1.5, color: '#ffffff', fillColor: '#1f2328', fillOpacity: 1, interactive: false })
            .addTo(markerLayer);
        }
      }
    });
    // Pins go on top of the lines and dots.
    pts.forEach((pt, i) => addPin(map.unproject(spread[i], zoom), { key: `p:${pt.p.FHRSID}`, places: [pt.p] }, 1));
  }
  if (state.origin && state.query?.label !== AREA_LABEL) {
    L.circleMarker([state.origin.lat, state.origin.lon], {
      radius: 9, weight: 3, color: '#ffffff', fillColor: '#1a73e8', fillOpacity: 1, interactive: false,
    }).bindTooltip(state.query?.label === 'you' ? 'You' : (state.query?.label || ''), { direction: 'top', offset: [0, -8] })
      .addTo(markerLayer);
  }
  updateMapBar();
}

let mapHasView = false;   // Leaflet needs a centre and zoom before most calls

// Frame the nearest places (plus you) when a list is first shown on the map.
// "Search this area" results keep the view the user chose instead.
function fitMap(pts) {
  if (!state.query) return; // a new search is still starting: keep the current view
  const hasItems = pts.length > 0;
  if (fittedFor === state && (fittedWithItems || !hasItems)) return;
  fittedFor = state;
  fittedWithItems = hasItems;
  if (state.query?.label === AREA_LABEL) {
    fittedWithItems = true;
    if (!mapHasView) { // opened straight from a link: show the searched area
      map.fitBounds(L.latLng(state.origin.lat, state.origin.lon).toBounds(state.query.radius * 1.4 || 600), { animate: false });
      mapHasView = true;
    }
    return;
  }
  const points = pts.slice(0, state.origin ? 15 : pts.length).map(g => [g.lat, g.lon]);
  if (state.origin) points.push([state.origin.lat, state.origin.lon]);
  if (points.length > 1) map.fitBounds(points, { padding: [30, 30], maxZoom: 18, animate: false });
  else if (points.length === 1) map.setView(points[0], 17, { animate: false });
  else map.setView([54.0, -2.5], 6, { animate: false }); // England and Wales
  mapHasView = true;
}

// "Search this area" hit its page limit before covering the whole view (dense city centres).
function areaCapped() {
  const q = state.query;
  if (q?.label !== AREA_LABEL || !q.radius || state.page < AREA_MAX_PAGES || state.page >= state.totalPages) return false;
  const last = state.saved[state.saved.length - 1];
  return !!last && distanceMetres(last, state.origin) < q.radius;
}

// What the current results are centred on, in words.
function resultsPlace() {
  const label = state.query?.label;
  if (label === 'you') return 'you';
  if (label === AREA_LABEL) return 'the searched area';
  return label || '';
}

function updateMapBar() {
  const bar = $('#map-bar');
  if (state.message) { bar.innerHTML = `<span>${state.message}</span>`; $('#search-area').hidden = true; return; }
  if (state.query?.kind === 'near' && !settings.types.length) {
    bar.innerHTML = '<span>No types of place are selected. <a href="#/settings">Settings</a></span>';
    return;
  }
  updateSearchAreaButton();
  const away = !$('#search-area').hidden;
  const n = state.shown;
  let text = state.loading ? 'Loading…' : `${n} ${n === 1 ? 'place' : 'places'} shown`;
  if (!state.loading && state.query && state.page === 0) text = '';
  else if (!state.loading && away && state.query?.kind === 'near') text = `These results are around ${resultsPlace()}`;
  else if (!state.loading && areaCapped()) text = `Showing the ${n} places nearest the centre`;
  else if (!state.loading && map && clusteredNow) text = 'Zoom in to see grouped places separately';
  // "More" extends the current results outward, so only offer it while looking at them.
  const more = state.query && !state.loading && !away && state.page > 0 && state.page < state.totalPages;
  const moreLabel = state.query?.label === AREA_LABEL ? 'More places'
    : state.query?.kind === 'near' ? `More near ${resultsPlace()}` : 'More results';
  bar.innerHTML = `<span>${esc(text)}</span>${more ? `<button type="button" class="link-btn" id="map-more">${esc(moreLabel)}</button>` : ''}`;
  if (more) $('#map-more').onclick = () => { loadMore(); updateMapBar(); };
}

/* "Search this area": once the map has moved well away from the current results, or been
   zoomed well out, offer to load the places covering the visible map instead. */

function resultsCentre() {
  if (state.origin) return L.latLng(state.origin.lat, state.origin.lon);
  const first = state.saved.map(positionOf).find(p => isFinite(p.lat) && isFinite(p.lon));
  return first ? L.latLng(first.lat, first.lon) : null;
}

function updateSearchAreaButton() {
  const btn = $('#search-area');
  const anchor = map && mapHasView && mode === 'map' && state.query && !state.loading ? resultsCentre() : null;
  if (!anchor) { btn.hidden = true; return; }
  const viewWidth = mapViewWidth();
  state.viewWidth ||= viewWidth; // the width the results were first shown at
  // Show when the centre is more than a third of a screen away, or the map is zoomed well out.
  const moved = map.distance(map.getCenter(), anchor) > viewWidth / 3;
  const zoomedOut = viewWidth > state.viewWidth * 2.5;
  btn.hidden = !(moved || zoomedOut);
}

function mapViewWidth() {
  const size = map.getSize();
  return map.distance(map.containerPointToLatLng([0, size.y / 2]), map.containerPointToLatLng([size.x, size.y / 2]));
}

$('#search-area').addEventListener('click', () => {
  const c = map.getCenter();
  // Cover the visible map: from the centre out to the corners.
  const radius = Math.round(map.distance(c, map.getBounds().getNorthEast()));
  $('#search-area').hidden = true;
  go(`#/area?lat=${c.lat.toFixed(5)}&lon=${c.lng.toFixed(5)}&r=${radius}&map=1`);
});

let activePin = null;
let activeKey = null;

function openMapCard(group, marker) {
  activeKey = group.key;
  activePin?.classList.remove('active');
  activePin = marker.getElement()?.querySelector('.pin');
  activePin?.classList.add('active');
  $('#map-card-list').innerHTML = group.places.map(rowHtml).join('');
  $('#map-card').hidden = false;
  $('#map-card').scrollTop = 0;
}

function closeMapCard() {
  activePin?.classList.remove('active');
  activePin = null;
  activeKey = null;
  $('#map-card').hidden = true;
}
$('#map-card-close').addEventListener('click', closeMapCard);

// Called whenever the current list's places change.
function refreshMap() {
  if (mode === 'map' && map) {
    if (fittedFor !== state) closeMapCard();
    renderMarkers();
  } else if (mode === 'map') {
    updateMapBar();
  }
}

async function setMode(next) {
  mode = next;
  for (const b of document.querySelectorAll('#view-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.mode === next));
  $('#list-wrap').hidden = next === 'map';
  $('#map-wrap').hidden = next !== 'map';
  if (next !== 'map') return;
  window.scrollTo(0, 0);
  sizeMap();
  updateMapBar();
  try {
    await ensureMap();
  } catch {
    $('#map-bar').textContent = "The map couldn't load. Check your signal and try again.";
    return;
  }
  if (mode !== 'map') return;
  sizeMap();
  renderMarkers();
}

// Switching List/Map changes the current history entry instead of adding one,
// so Back still goes to the previous screen.
function listHash(key, asMap) {
  if (key === '#/') return asMap ? '#/map' : '#/';
  return asMap ? `${key}&map=1` : key;
}

for (const b of document.querySelectorAll('#view-toggle button')) {
  b.addEventListener('click', () => {
    if (b.dataset.mode === mode) return;
    history.replaceState({ idx: navIndex }, '', listHash(state.key || '#/', b.dataset.mode === 'map'));
    route();
  });
}

/* ---------- Navigation ----------
   Every screen is a real history entry, so the browser's Back and Forward buttons,
   Android's Back button and iOS swipe-back all work. The on-screen Back button
   steps back through the same history instead of adding a new entry. */

history.scrollRestoration = 'manual';
let navIndex = history.state?.idx ?? 0;
if (history.state?.idx == null) history.replaceState({ idx: 0 }, '', location.href);

function go(hash) {
  if (hash === (location.hash || '#/')) { route(); return; }
  navIndex++;
  history.pushState({ idx: navIndex }, '', hash);
  route();
}

function goBack() {
  if (navIndex > 0) { history.back(); return; }
  // Opened straight onto this screen (e.g. a shared link): there's nothing to go back to, so go to the list.
  history.replaceState({ idx: 0 }, '', '#/');
  route();
}

window.addEventListener('popstate', e => {
  navIndex = e.state?.idx ?? 0;
  route();
});

// In-app links become history steps without a full page change.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

$('#back').addEventListener('click', goBack);

function parseRoute() {
  const hash = location.hash || '#/';
  const place = hash.match(/^#\/place\/(\d+)/);
  if (place) return { view: 'place', id: place[1] };
  if (hash === '#/settings') return { view: 'settings' };
  if (hash.startsWith('#/search?')) {
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    const q = (params.get('q') || '').trim();
    if (q) return { view: 'list', key: `#/search?q=${encodeURIComponent(q)}`, q, map: params.get('map') === '1' };
  }
  if (hash.startsWith('#/area?')) {
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    const lat = parseFloat(params.get('lat')), lon = parseFloat(params.get('lon'));
    const r = Math.min(8000, Math.max(0, parseInt(params.get('r'), 10) || 0));
    if (isFinite(lat) && isFinite(lon)) {
      return { view: 'list', key: `#/area?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&r=${r}`, area: { lat, lon, r }, map: params.get('map') === '1' };
    }
  }
  return { view: 'list', key: '#/', map: hash === '#/map' };
}

function showList(r) {
  $('#q').value = r.q || '';
  setMode(r.map ? 'map' : 'list');
  if (state.key === r.key && !state.stale) {
    if (mode === 'list') window.scrollTo(0, state.scrollY);
    return;
  }
  // Park the current list so Back/Forward can return to it.
  if (state.key && state.query && !state.stale) {
    lists.delete(state.key);
    lists.set(state.key, state);
    while (lists.size > CACHE_MAX_LISTS) lists.delete(lists.keys().next().value);
  }
  const saved = lists.get(r.key);
  if (saved && !saved.stale) { restoreList(saved); return; }

  token++;
  state = newList(r.key);
  clearListDom();
  window.scrollTo(0, 0);
  if (r.area) resetList({ kind: 'near', lat: r.area.lat, lon: r.area.lon, label: AREA_LABEL, radius: r.area.r }, 'Places in the searched map area');
  else if (r.q) runSearch(r.q);
  else locate();
}

function route() {
  // Remember where the list was scrolled to as we leave it.
  if (!$('#view-list').hidden && mode === 'list') state.scrollY = window.scrollY;
  const r = parseRoute();
  const welcome = r.view === 'list' && r.key === '#/' && !store.get('welcomed', false);
  $('#view-toggle').hidden = welcome || r.view !== 'list';
  $('#view-welcome').hidden = !welcome;
  $('#view-list').hidden = r.view !== 'list' || welcome;
  detailEl.hidden = r.view !== 'place';
  $('#view-settings').hidden = r.view !== 'settings';
  $('#back').hidden = r.view === 'list' && r.key === '#/';
  $('#settings-link').hidden = r.view === 'settings';

  if (r.view === 'place') {
    showDetail(r.id);
    window.scrollTo(0, 0);
  } else if (r.view === 'settings') {
    renderSettings();
    window.scrollTo(0, 0);
  } else if (welcome) {
    window.scrollTo(0, 0);
  } else {
    showList(r);
  }
}

route();

/* ---------- Offline support ---------- */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
