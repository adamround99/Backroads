"use strict";

/* ============================================================
   Backroads — finds driving laps worth the fuel.

   Reads the road network from OpenStreetMap, measures every
   stretch for corners and for whether it's worth driving, then
   searches for a closed lap through the good bits. No routing
   service involved: they optimise for arriving, which is the
   opposite of the point.
   ============================================================ */

/* Road classes worth driving, and the ones that ruin a loop. */
var GOOD = {tertiary:1, unclassified:1, secondary:1};
var DULL = {motorway:1, trunk:1, residential:1, living_street:1, service:1, track:1};

/* Corner radius (m) -> weight. Two characters of drive. */
var WEIGHTS = {
  tight:   [[30,3.0],[60,2.2],[100,1.1],[175,0.4],[300,0.1]],
  flowing: [[30,0.8],[60,1.6],[100,2.4],[175,2.0],[300,0.8]]
};

/* OpenStreetMap query service. Free and keyless, but a shared public
   resource — so ask once per area and remember the answer. These are
   mirrors of the same database: if one is busy, the next one will do.
   Weekend mornings are peak load, which is exactly when this app gets
   opened, so the fallbacks earn their keep. */
var OVERPASS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.osm.jp/api/interpreter"
];

/* CARTO basemap key. Since Aug 2026 keyless tiles come back stamped
   "API KEY REQUIRED". This ships to every visitor in the page source —
   it can't be otherwise in a static page — so it's restricted by
   domain at carto.com/basemaps/apikey rather than kept secret. */
var CARTO_KEY = "cb1_3m6r_1_6a91ecb6ec4825e90b833af1";

var MI = 0.621371;   // everything is measured in metres and shown in miles

var state = {
  start: null,          // {lat, lng}
  results: [],
  active: -1,
  style: "tight",
  mins: 60,             // how long you want to be out
  legs: null,
  reach: 10,            // miles
  graph: null,          // road network the laps are built from
  graphAt: null,        // centre and radius of the network in hand
  bounds: null,         // what the drawn route spans
  freshness: false,     // steer away from recently-driven roads (see drivenCells)
  history: []           // last few searches this session — see pushHistory
};

var map, tiles, startMarker, lapMarker, routeLine, ghostLine, placeMarks = [];

/* ---------- geometry ---------- */

var STEP = 12;   // metres between samples once a route is tidied up

/* Work in local metres. Corner maths on raw lon/lat is a precision fight
   you lose quietly. */
function project(pts){
  if (!pts.length) return [];
  var mx = 111320 * Math.cos(pts[0][1] * Math.PI/180), my = 110540;
  var ox = pts[0][0], oy = pts[0][1], out = new Array(pts.length);
  for (var i=0;i<pts.length;i++){
    out[i] = [(pts[i][0]-ox)*mx, (pts[i][1]-oy)*my, pts[i].length > 2 ? pts[i][2] : 0];
  }
  return out;
}

/* OpenStreetMap digitises roads unevenly — a hundred points through one
   village, four across a moor. Measuring corners on raw points therefore
   measures the surveyor, not the road. Resample to even spacing first. */
function resample(xy, step){
  if (xy.length < 2) return xy.slice();
  var out = [xy[0]], carry = 0;
  for (var i=1;i<xy.length;i++){
    var ax=xy[i-1][0], ay=xy[i-1][1], az=xy[i-1][2];
    var dx=xy[i][0]-ax, dy=xy[i][1]-ay, dz=xy[i][2]-az;
    var len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-9) continue;
    var pos = step - carry;
    while (pos <= len){
      var f = pos/len;
      out.push([ax+dx*f, ay+dy*f, az+dz*f]);
      pos += step;
    }
    carry = (carry + len) % step;
  }
  out.push(xy[xy.length-1]);
  return out;
}

/* Radius of the circle through three points, from the cross product.
   Heron's formula gives nonsense on near-straight roads; this doesn't. */
function radiusAt(a,b,c){
  var abx=b[0]-a[0], aby=b[1]-a[1];
  var bcx=c[0]-b[0], bcy=c[1]-b[1];
  var cax=a[0]-c[0], cay=a[1]-c[1];
  var cross = abx*bcy - aby*bcx;
  if (Math.abs(cross) < 1e-9) return Infinity;
  var ab = Math.sqrt(abx*abx+aby*aby);
  var bc = Math.sqrt(bcx*bcx+bcy*bcy);
  var ca = Math.sqrt(cax*cax+cay*cay);
  return (ab*bc*ca)/(2*Math.abs(cross));
}

function prepare(pts){
  var xy = resample(project(pts), STEP);
  return {xy: xy, metres: Math.max(0, xy.length-1) * STEP};
}

function cornerWeight(r, style){
  var table = WEIGHTS[style];
  for (var i=0;i<table.length;i++) if (r < table[i][0]) return table[i][1];
  return 0;
}

/* Find actual corners: runs of bend, not individual bendy samples.
   One long sweeper is one corner, and anything under 15m is a wobble. */
function corners(prep, style){
  var xy = prep.xy, list = [], run = null, i;
  for (i=1;i<xy.length-1;i++){
    var w = cornerWeight(radiusAt(xy[i-1], xy[i], xy[i+1]), style);
    if (w > 0){
      if (run){ run.end = i; if (w > run.w) run.w = w; }
      else run = {start:i, end:i, w:w};
    } else if (run){
      if ((run.end - run.start + 1) * STEP >= 15) list.push(run);
      run = null;
    }
  }
  if (run && (run.end - run.start + 1) * STEP >= 15) list.push(run);
  return list;
}

/* Weighted corners per km — the headline number. */
function curvature(prep, style){
  var km = prep.metres/1000;
  if (!km) return 0;
  var list = corners(prep, style), w = 0;
  for (var i=0;i<list.length;i++) w += list[i].w;
  return w/km;
}

/* How hard a corner is, on a continuous 0-1 scale. Bucketing every bend into
   "tight" made whole routes read as maximum, which told you nothing. */
function severity(r){
  if (r >= 300) return 0;
  return Math.min(1, 35/Math.max(r, 35));
}

/* The numbers a driver actually wants: how much of the loop is cornering,
   and how long the best uninterrupted stretch is. Short straights inside a
   good run don't break it — a few hundred metres between bends is still the
   same road. */
function driveStats(prep){
  var xy = prep.xy, radii = [], i;
  for (i=1;i<xy.length-1;i++) radii.push(radiusAt(xy[i-1], xy[i], xy[i+1]));

  var cornering = 0, run = 0, gap = 0, best = 0;
  for (i=0;i<radii.length;i++){
    if (radii[i] < 175){
      run += gap + 1; gap = 0; cornering++;
    } else {
      gap++;
      if (gap * STEP > 400){ if (run > best) best = run; run = 0; gap = 0; }
    }
  }
  if (run > best) best = run;

  return {
    radii: radii,
    twisty: radii.length ? cornering/radii.length : 0,
    best: best * STEP / 1000
  };
}

function statsFor(prep){
  return prep.stats || (prep.stats = driveStats(prep));
}

function climb(pts){
  var gain = 0, last = null;
  for (var i=0;i<pts.length;i++){
    if (pts[i].length < 3) continue;
    if (last === null){ last = pts[i][2]; continue; }
    var d = pts[i][2] - last;
    if (Math.abs(d) >= 2){ if (d > 0) gain += d; last = pts[i][2]; }
  }
  return gain;
}

/* How much of the loop doubles back on itself. Round trip routing loves
   an out-and-back, and that is a worse drive than the numbers suggest.
   Passing through the same square twice only counts if the visits are
   far apart along the route — otherwise every roundabout looks repeated. */
function overlap(prep){
  var xy = prep.xy, seen = {}, revisits = 0, cell = 60;
  for (var i=0;i<xy.length;i++){
    var k = Math.round(xy[i][0]/cell) + ":" + Math.round(xy[i][1]/cell);
    var prev = seen[k];
    if (prev === undefined) seen[k] = i;                      // remember first visit only
    else if ((i - prev) * STEP > 400) revisits++;             // came back much later
  }
  return revisits / Math.max(xy.length, 1);
}

/* overlap() only catches the route landing on itself within 60m. The shape
   that actually reads as doubling back is wider than that: going out on one
   lane and coming back on the next one over, a few hundred metres away. To a
   driver that's the same ground twice; to a 60m grid it's two different roads.

   So: count points that pass close to a part of the route reached much later.
   The along-route threshold has to be generous — a hairpin brings the road
   within 200m of itself after only a few hundred metres, and that's good
   driving, not a detour. */
function closePasses(prep){
  var xy = prep.xy, cell = 250, near = 2;          // cells to check either side
  var grid = {}, i, gx, gy, k;

  for (i=0;i<xy.length;i++){
    gx = Math.round(xy[i][0]/cell); gy = Math.round(xy[i][1]/cell);
    k = gx + ":" + gy;
    if (grid[k] === undefined) grid[k] = i;        // earliest visit to this cell
  }

  var hits = 0;
  for (i=0;i<xy.length;i++){
    gx = Math.round(xy[i][0]/cell); gy = Math.round(xy[i][1]/cell);
    var found = false;
    for (var dx=-near; dx<=near && !found; dx++){
      for (var dy=-near; dy<=near && !found; dy++){
        var j = grid[(gx+dx) + ":" + (gy+dy)];
        if (j === undefined) continue;
        if ((i - j) * STEP > 1500){                // came back here much later
          var ddx = xy[i][0]-xy[j][0], ddy = xy[i][1]-xy[j][1];
          if (Math.sqrt(ddx*ddx + ddy*ddy) < 650) found = true;
        }
      }
    }
    if (found) hits++;
  }
  return hits / Math.max(xy.length, 1);
}

function roadMix(details){
  var good = 0, dull = 0;
  var rows = (details && details.road_class) || [];
  for (var i=0;i<rows.length;i++){
    var span = rows[i][1] - rows[i][0];
    if (GOOD[rows[i][2]]) good += span;
    else if (DULL[rows[i][2]]) dull += span;
  }
  var t = good + dull;
  return t ? {good: good/t, dull: dull/t} : {good:0, dull:0};
}

function score(path){
  var pts = path.points.coordinates;
  var prep = prepare(pts);
  var st = statsFor(prep);
  var km = path.distance/1000;
  var lap = overlap(prep);
  var near = closePasses(prep);
  var mix = roadMix(path.details);
  return {
    pts: pts,
    prep: prep,
    km: km,
    rawMins: Math.round(path.time/60000),                   // what the model says
    mins: Math.round(path.time/60000 * paceFactor()),       // corrected by your drives
    twisty: st.twisty,
    best: st.best,
    climb: climb(pts),
    good: mix.good,
    lap: lap,
    near: near,
    roads: path.roads || [],
    /* Junctions worth a Google Maps pin so it can't quietly reroute — see
       routerWouldDiverge(). Coordinates, not indices, so they survive the
       geometry thinning that saved laps go through. */
    riskPts: (path.risk || []).map(function(i){ return pts[i]; }),
    /* Retracing the same road is worst, but coming back along the next lane
       over is the same ground to a driver and was costing nothing at all. */
    total: st.best*1.2 + st.twisty*8 + mix.good*3 - mix.dull*4 - lap*34 - near*16
  };
}

/* ---------- finding roads worth driving ---------- */

/* The whole road network inside a disc, for circuit building. */
/* Ask Overpass, working down the mirror list. A busy server (429/504) or a
   dead one is worth retrying elsewhere; a malformed query (400) is our fault
   and will fail identically everywhere, so that one gives up immediately.
   Two passes over the list, with a pause between, because "busy" is usually
   a matter of seconds. */
function askOverpass(q){
  var body = "data=" + encodeURIComponent(q);
  var order = OVERPASS.concat(OVERPASS);
  var lastBusy = false;

  function attempt(i){
    if (i >= order.length){
      throw new Error(lastBusy
        ? "OpenStreetMap's servers are throttling us. They limit how often one "
          + "connection can ask — wait a couple of minutes. Saved laps still work."
        : "Couldn't reach OpenStreetMap. Check your connection.");
    }
    /* One pause, before the second pass round the mirrors. Only when the last
       failure was a throttle — if the phone has no connection, waiting
       achieves nothing but a longer spinner. Overpass slot limits often run to
       a minute or more anyway, so the honest move is to fail quickly and say
       what's happening rather than hold the screen hostage. */
    var wait = (i === OVERPASS.length && lastBusy && navigator.onLine) ? 8000 : 0;
    return new Promise(function(res){ setTimeout(res, wait); })
      .then(function(){
        var ctl = window.AbortController ? new AbortController() : null;
        var timer = setTimeout(function(){ ctl && ctl.abort(); }, 40000);
        return fetch(order[i], {
          method: "POST",
          headers: {"Content-Type":"application/x-www-form-urlencoded"},
          body: body,
          signal: ctl ? ctl.signal : undefined
        }).then(function(r){
          clearTimeout(timer);
          if (r.status === 400) throw new Error("stop:The road network query was rejected.");
          if (!r.ok){ lastBusy = (r.status === 429 || r.status === 504); throw new Error("retry"); }
          return r.json();
        }, function(e){
          clearTimeout(timer);
          throw e;
        });
      })
      .catch(function(e){
        if (e && /^stop:/.test(e.message)) throw new Error(e.message.slice(5));
        if (i + 1 === OVERPASS.length && lastBusy && navigator.onLine){
          say("All the servers are busy — waiting 8s before trying again…");
        } else if (i + 1 < order.length){
          say("Server busy — trying another…");
        }
        return attempt(i + 1);
      });
  }
  return attempt(0);
}

function fetchArea(start, radius){
  // Residential streets keep small networks joined up, but over a wide area
  // they are most of the data and none of the driving.
  // A roads are mostly dull but they join lane networks together, so they're
  // fetched and then weighted down rather than excluded outright.
  var classes = radius > 12000 ? "primary|secondary|tertiary|unclassified"
                               : "primary|secondary|tertiary|unclassified|residential";
  var at = '(around:' + Math.round(radius) + ',' + start.lat.toFixed(5) + ',' + start.lng.toFixed(5) + ')';
  /* Roads need their full geometry; schools, cameras and villages are only
     ever used as single points, so asking for their outlines wastes payload
     on a shared public service. Two result sets, two output formats. */
  var q = '[out:json][timeout:90];'
        + 'way["highway"~"^(' + classes + ')$"]["access"!~"private|no"]'
        + '["surface"!~"gravel|dirt|ground|unpaved"]' + at + '->.roads;'
        + '('
        + 'node["amenity"="school"]' + at + ';'
        + 'way["amenity"="school"]' + at + ';'
        + 'node["highway"="speed_camera"]' + at + ';'
        + 'node["place"~"^(town|village|hamlet|suburb)$"]["name"]' + at + ';'
        + ')->.extras;'
        + '.roads out geom;'
        + '.extras out center;';
  return askOverpass(q).then(function(j){
    var els = j.elements || [], ways = [], schools = [], cameras = [], places = [], i;
    for (i=0;i<els.length;i++){
      var e = els[i], tg = e.tags || {};
      // a node carries its own position; a way asked for with `out center` has one
      var lon = e.lon !== undefined ? e.lon : (e.center && e.center.lon);
      var lat = e.lat !== undefined ? e.lat : (e.center && e.center.lat);

      if (tg.place && tg.name && lon !== undefined){
        places.push({lon:lon, lat:lat, name:tg.name, kind:tg.place});
      } else if (tg.highway === "speed_camera"){
        if (lon !== undefined) cameras.push([lon, lat]);
      } else if (tg.amenity === "school"){
        if (lon !== undefined) schools.push([lon, lat]);
      } else if (e.type === "way" && tg.highway){
        ways.push(e);
      }
    }
    return {ways: ways, schools: schools, cameras: cameras, places: places};
  });
}

/* ---------- keeping the road network between sessions ----------

   Reading the map is the whole wait — 27s of Overpass against well under a
   second of searching it. And the roads round your house do not change
   between Tuesday and Wednesday, so downloading them again every time is
   pure waste.

   The graph is plain arrays and objects, so IndexedDB can store it directly
   with no serialising. A stored area is reused when it *contains* what's being
   asked for, not when it matches exactly — so shortening your lap or nudging
   the start still hits the cache rather than starting over. */

var DB_NAME = "backroads", DB_STORE = "areas", DB_KEEP = 4, DB_AGE = 30*86400000;

function openDB(){
  return new Promise(function(resolve, reject){
    if (!window.indexedDB) return reject();
    var rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = function(){
      var db = rq.result;
      if (!db.objectStoreNames.contains(DB_STORE))
        db.createObjectStore(DB_STORE, {keyPath: "id", autoIncrement: true});
    };
    rq.onsuccess = function(){ resolve(rq.result); };
    rq.onerror = function(){ reject(); };
  });
}

function dbAll(db){
  return new Promise(function(resolve){
    var out = [], rq = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).openCursor();
    rq.onsuccess = function(){
      var c = rq.result;
      if (!c) return resolve(out);
      out.push(c.value); c.continue();
    };
    rq.onerror = function(){ resolve(out); };
  });
}

/* A stored disc is usable if the one we need sits entirely inside it. */
function covers(rec, lat, lng, radius){
  var ls = 111320 * Math.cos(lat * Math.PI/180);
  var dx = (rec.lng - lng) * ls, dy = (rec.lat - lat) * 110540;
  return Math.sqrt(dx*dx + dy*dy) + radius <= rec.radius + 1;
}

function cachedGraph(lat, lng, radius){
  return openDB().then(function(db){
    return dbAll(db).then(function(recs){
      var now = Date.now(), best = null;
      for (var i=0;i<recs.length;i++){
        var r = recs[i];
        if (now - r.savedAt > DB_AGE) continue;
        if (!covers(r, lat, lng, radius)) continue;
        if (!best || r.savedAt > best.savedAt) best = r;
      }
      db.close();
      return best ? best.graph : null;
    });
  })["catch"](function(){ return null; });      // private mode, quota, no IDB
}

function storeGraph(lat, lng, radius, graph){
  return openDB().then(function(db){
    return dbAll(db).then(function(recs){
      var tx = db.transaction(DB_STORE, "readwrite"), st = tx.objectStore(DB_STORE);
      // Drop anything this new area already contains, plus the oldest over the cap.
      var stale = recs.filter(function(r){
        return Date.now() - r.savedAt > DB_AGE ||
               covers({lat:lat, lng:lng, radius:radius}, r.lat, r.lng, r.radius);
      });
      stale.forEach(function(r){ st["delete"](r.id); });
      var keep = recs.filter(function(r){ return stale.indexOf(r) < 0; })
                     .sort(function(a,b){ return b.savedAt - a.savedAt; });
      keep.slice(DB_KEEP - 1).forEach(function(r){ st["delete"](r.id); });

      st.add({lat:lat, lng:lng, radius:radius, savedAt:Date.now(), graph:graph});
      tx.oncomplete = function(){ db.close(); };
    });
  })["catch"](function(){});                     // never let a cache failure break a search
}

/* ---------- showing the wait ----------

   Reading the map is nearly all of it, and there are no roads to draw yet, so
   the honest thing to show is the area being read: a ring at the true fetch
   radius with a sweep expanding through it. It isn't a progress bar, because
   Overpass gives no progress — it says what's happening and where. */

var sweepRing = null, sweepPulse = null, sweepTimer = null;

function startSweep(at, radius){
  stopSweep();
  if (!map || !at) return;

  var colour = getComputedStyle(document.body).getPropertyValue("--route").trim() || "#80A3C5";

  sweepRing = L.circle([at.lat, at.lng], {
    radius: radius, interactive: false, fill: false,
    color: colour, weight: 1.5, opacity: .35, dashArray: "5 7"
  }).addTo(map);

  sweepPulse = L.circle([at.lat, at.lng], {
    radius: 0, interactive: false,
    color: colour, weight: 2, opacity: .8,
    fillColor: colour, fillOpacity: .07
  }).addTo(map);

  /* setStyle rather than touching the element: it's the documented way to
     restyle a path, and doesn't depend on the SVG node being reachable. */
  var born = Date.now(), CYCLE = 2200;
  function tick(){
    if (!sweepPulse) return;
    var f = ((Date.now() - born) % CYCLE) / CYCLE;
    var fade = Math.max(0, 1 - f);
    sweepPulse.setRadius(radius * f);
    sweepPulse.setStyle({opacity: fade * 0.85, fillOpacity: fade * 0.10});
    sweepTimer = requestAnimationFrame(tick);
  }
  tick();
}

function stopSweep(){
  if (sweepTimer) cancelAnimationFrame(sweepTimer);
  sweepTimer = null;
  if (sweepRing){ map.removeLayer(sweepRing); sweepRing = null; }
  if (sweepPulse){ map.removeLayer(sweepPulse); sweepPulse = null; }
}

function breathe(){
  return new Promise(function(r){ requestAnimationFrame(function(){ setTimeout(r, 0); }); });
}

function ensureGraph(start, radius){
  // Already in hand from this session?
  if (state.graph && state.graphAt &&
      covers({lat:state.graphAt.lat, lng:state.graphAt.lng, radius:state.graphAt.radius},
             start.lat, start.lng, radius)) {
    return Promise.resolve(state.graph);
  }

  say("Looking for roads already on the phone…");
  return cachedGraph(start.lat, start.lng, radius).then(function(hit){
    if (hit){
      state.graph = hit;
      state.graphAt = {lat:start.lat, lng:start.lng, radius:hit.radius || radius};
      say("Using the roads already on your phone.");
      return hit;
    }
    /* Fetch a little wider than asked. GPS never returns the same coordinates
       twice, so without this the stored disc would miss by a few metres
       tomorrow and every search would refetch — a cache that never hits. */
    return fetchAndBuild(start, Math.min(34000, radius + 1200));
  });
}

function fetchAndBuild(start, radius){
  say("Asking OpenStreetMap for the roads…");
  return fetchArea(start, radius).then(function(data){
    say("Building the road network…");
    return breathe().then(function(){ return data; });
  }).then(function(data){
    var ls = 111320 * Math.cos(start.lat * Math.PI/180);
    var schools = data.schools.length ? hazardCells(data.schools, ls, 250) : null;
    var cameras = data.cameras.length ? hazardCells(data.cameras, ls, 150) : null;
    var g = buildGraph(data.ways, ls, schools, cameras);
    say("Trimming dead ends…");
    g = mergeChains(pruneSpurs(g), 5000);
    g = mergeChains(pruneSpurs(g), 5000);
    g.schools = data.schools.length;
    g.cameras = data.cameras.length;
    g.radius = radius;               // so the walk never counts on road we didn't fetch
    g.places = data.places || [];
    state.graph = g;
    state.graphAt = {lat:start.lat, lng:start.lng, radius:radius};
    storeGraph(start.lat, start.lng, radius, g);   // fire and forget
    return g;
  });
}

/* ---------- circuits ---------- */

/* A circuit is a closed lap of connected road, the way a track is: every
   segment joins the next, and you come back to where you started without
   repeating anything. Built here from the raw map rather than by asking a
   routing service, because routing services optimise for arriving. */

/* How much a road is worth driving, before corners come into it. B roads and
   lanes are the point; residential streets and 30 limits are not. */
var CLASS_WEIGHT = {
  secondary: 1.25,      // B roads
  tertiary: 1.15,       // C roads and the better lanes
  unclassified: 1.00,   // country lanes
  primary: 0.55,        // A roads — usually dull, occasionally brilliant
  residential: 0.18,
  living_street: 0.06,
  service: 0.04,
  track: 0.04
};

/* A speed limit is the best single clue that a road runs through somewhere
   built up, which is where the driving stops being any fun. */
function speedFactor(tags){
  var v = tags.maxspeed;
  if (!v) return tags.lit === "yes" ? 0.65 : 1;   // lit usually means houses
  var m = /(\d+)/.exec(v);
  if (!m) return 1;
  var n = +m[1];
  if (!/mph/i.test(v)) n *= 0.621371;             // tagged in km/h
  if (n <= 20) return 0.10;
  if (n <= 30) return 0.32;
  if (n <= 40) return 0.80;
  return 1.15;
}

/* ---------- how long a stretch actually takes ----------

   Distance is a poor proxy for a drive. An hour of lanes and an hour of
   open B road are nowhere near the same number of miles, which is why
   asking for "15 miles" gave such inconsistent drives.

   Three things cap your speed at any point: the limit, how tight the bend
   is, and how wide the road is. A car can't jump between those caps, so
   the caps are run through a forward pass (you can only accelerate so
   hard) and a backward pass (you have to brake into the corner). That
   second pass is the important one — it's why a single hairpin costs far
   more than its own length, which a simple average can never capture. */

var TURN_ALLOW = 2.5;   // rough per-junction cost while the walk is still steering

/* How far from the lap's start the walk is allowed to wander, as a fraction of
   the lap's own length. The fetch radius is derived from this same number: ask
   for any less map and the walk hits the edge of the world, ask for more and
   you wait on Overpass for road you'll never touch. */
var LEASH = 0.18;

/* Pace assumed when sizing the fetch, before any roads are in hand to measure.
   15 m/s is about 34mph, which is what B roads and lanes actually average.
   The old 20 m/s was a motorway figure and made every query 50% larger than
   it needed to be. */
var RECKON_SPEED = 15;
var A_ACC = 1.8;    // m/s², brisk but not flat out
var A_DEC = 2.6;    // m/s², comfortable braking on a road you don't know
var A_LAT = 3.8;    // m/s², about 0.39g — spirited, still public-road sane

/* Practical speed by road class, whatever the limit says. A national-limit
   single-track lane is still a 35mph road, because you can't see round it. */
var CLASS_SPEED = {
  motorway: 31, trunk: 29, primary: 27, secondary: 24,
  tertiary: 21, unclassified: 16, residential: 10,
  living_street: 5, service: 7, track: 6
};

function legalSpeed(tags){
  var v = tags.maxspeed;
  if (!v) return null;
  var m = /(\d+)/.exec(v);
  if (!m) return null;
  var n = +m[1];
  return /mph/i.test(v) ? n * 0.44704 : n / 3.6;
}

function edgeSeconds(prep, tags){
  var xy = prep.xy, n = xy.length;
  if (n < 2) return prep.metres / 15;

  var legal = legalSpeed(tags);
  if (legal === null) legal = tags.lit === "yes" ? 13.4 : 26.8;   // 30 / national
  var cap = CLASS_SPEED[tags.highway] !== undefined ? CLASS_SPEED[tags.highway] : 18;
  var ceiling = Math.min(legal, cap);
  if (tags.traffic_calming) ceiling = Math.min(ceiling, 9);

  var v = new Array(n), i;
  for (i=0;i<n;i++){
    var r = (i > 0 && i < n-1) ? radiusAt(xy[i-1], xy[i], xy[i+1]) : Infinity;
    v[i] = Math.min(ceiling, isFinite(r) ? Math.sqrt(A_LAT * r) : Infinity);
  }
  for (i=1;i<n;i++)    v[i] = Math.min(v[i], Math.sqrt(v[i-1]*v[i-1] + 2*A_ACC*STEP));
  for (i=n-2;i>=0;i--) v[i] = Math.min(v[i], Math.sqrt(v[i+1]*v[i+1] + 2*A_DEC*STEP));

  var t = 0;
  for (i=1;i<n;i++) t += STEP / Math.max((v[i-1] + v[i]) / 2, 2);
  if (tags.junction === "roundabout") t += 5;
  return t;
}

/* Turning off one road onto another costs time the straight-line profile
   can't see. Straight on is free; a hairpin left is most of a standstill. */
function turnSeconds(turn){
  return 7 * (1 - Math.cos(turn)) / 2;
}

function roadQuality(tags, schoolShare, cameraShare){
  var q = CLASS_WEIGHT[tags.highway] !== undefined ? CLASS_WEIGHT[tags.highway] : 0.6;
  q *= speedFactor(tags);
  if (tags.traffic_calming) q *= 0.35;            // speed bumps
  if (tags.junction === "roundabout") q *= 0.5;
  q *= 1 - 0.80 * schoolShare;
  // A camera means a road that's busy, built up, or has a history of crashes.
  // Treated as a mark against the road, not as something to dodge.
  q *= 1 - 0.45 * cameraShare;
  return Math.max(q, 0.01);
}

/* Schools aren't tagged as zones in Britain, so proximity is the best
   available proxy: mark the squares around each point of interest. */
function hazardCells(points, latScale, size){
  var cells = {}, i, dx, dy;
  for (i=0;i<points.length;i++){
    var cx = Math.round(points[i][0]*latScale/size);
    var cy = Math.round(points[i][1]*110540/size);
    for (dx=-1;dx<=1;dx++) for (dy=-1;dy<=1;dy++) cells[(cx+dx)+":"+(cy+dy)] = 1;
  }
  return {cells:cells, size:size, latScale:latScale};
}

function nearHazard(index, p){
  if (!index) return false;
  var k = Math.round(p[0]*index.latScale/index.size) + ":" +
          Math.round(p[1]*110540/index.size);
  return index.cells[k] === 1;
}

/* How much of a road runs past the thing, not merely whether its midpoint
   happens to. A lane that clips one corner of a school zone shouldn't be
   condemned the same as one that runs the length of the playground. */
function hazardShare(index, pts){
  if (!index || pts.length < 2) return 0;
  var samples = Math.min(40, Math.max(4, pts.length)), hit = 0;
  for (var i=0;i<samples;i++){
    var p = pts[Math.min(pts.length-1, Math.floor(i*pts.length/samples))];
    if (nearHazard(index, p)) hit++;
  }
  return hit/samples;
}

/* "Somewhere new" mode. A road you drove last month isn't new to you even if
   the search has never seen it before, so a search that only knows the map
   can't tell fresh from stale on its own — the saved laps are the only record
   of that. Gridded the same way as hazardCells, from points in laps driven in
   the last two months; a flat cutoff rather than a fading weight, since that's
   the simple version and a real one needs driving on before it's worth tuning. */
var FRESH_DAYS = 60, FRESH_CELL = 200, FRESH_WEIGHT = 18;

function drivenCells(latScale){
  var laps = loadLaps(), cutoff = Date.now() - FRESH_DAYS*86400000, pts = [], i, j;
  for (i=0;i<laps.length;i++){
    var e = laps[i];
    if (!e.driven || e.driven < cutoff || !e.pts) continue;
    for (j=0;j<e.pts.length;j++) pts.push(e.pts[j]);
  }
  return pts.length ? hazardCells(pts, latScale, FRESH_CELL) : null;
}

/* Which way you're pointing at each end of a road, measured over the first
   30m so a wiggle at the junction doesn't skew it. */
function endBearing(pts, fromStart, ls){
  var a = fromStart ? pts[0] : pts[pts.length-1];
  var i = fromStart ? 1 : pts.length-2;
  var step = fromStart ? 1 : -1;
  while (i >= 0 && i < pts.length){
    var dx = (pts[i][0]-a[0])*ls, dy = (pts[i][1]-a[1])*110540;
    if (dx*dx + dy*dy > 900) return (Math.atan2(dx, dy)*180/Math.PI + 360) % 360;
    i += step;
  }
  var far = fromStart ? pts[pts.length-1] : pts[0];
  return (Math.atan2((far[0]-a[0])*ls, (far[1]-a[1])*110540)*180/Math.PI + 360) % 360;
}

/* Direction of travel when setting off from one end of a road. */
function leaving(e, node){ return e.from === node ? e.b0 : e.b1; }

function turnFrom(inbound, outbound){
  // 0 = carry straight on, 180 = back the way you came
  return Math.abs(((outbound - inbound + 540) % 360) - 180);
}

/* At a Y, one branch is the road carrying on and the other is a turning off
   it. Nothing in the map says which, so it's inferred: the branch you barely
   have to steer for, and the one still carrying the same name. */
function continuity(turn, sameName){
  var c = Math.pow(Math.cos(turn * Math.PI/360), 3);
  if (!(c > 0.15)) c = 0.15;
  return c * (sameName ? 1.7 : 1);
}

/* How tempting a road class is to a real turn-by-turn router — not how fun it
   is to drive. Used only to guess where Google's own routing might diverge
   from ours, at Navigate time. */
var ROUTER_RANK = {motorway:6, trunk:5, primary:4, secondary:3, tertiary:2,
                    unclassified:1, residential:1, living_street:0, service:0, track:0};

/* Would a turn-by-turn router plausibly carry on somewhere else at this
   junction, rather than the road we actually took? True when there's an
   option besides the one arrived on and the one taken that's a bigger class
   and at least as straight, or the same class and noticeably straighter —
   the two things a real router weighs most. Those junctions need their own
   pin at Navigate time, or Google may quietly reroute onto the road it
   prefers instead of the one the lap actually drives. */
function routerWouldDiverge(graph, node, arriveEi, inbound, takeEi, takeOut){
  var opts = graph.adj[node] || [];
  var mineRank = ROUTER_RANK[graph.edges[takeEi].cls] || 0;
  var mineTurn = turnFrom(inbound, takeOut);
  for (var i=0;i<opts.length;i++){
    var ei = opts[i];
    if (ei === takeEi || ei === arriveEi) continue;
    var e = graph.edges[ei];
    if (e.oneway && e.from !== node) continue;      // can't be taken from here
    var out = leaving(e, node);
    var rank = ROUTER_RANK[e.cls] || 0;
    var turn = turnFrom(inbound, out);
    if (rank > mineRank && turn <= mineTurn + 20) return true;
    if (rank === mineRank && turn + 25 < mineTurn) return true;
  }
  return false;
}

function nodeKey(p){ return p[0].toFixed(5) + ":" + p[1].toFixed(5); }

function metresBetween(a, b, latScale){
  var dx = (a[0]-b[0]) * latScale, dy = (a[1]-b[1]) * 110540;
  return Math.sqrt(dx*dx + dy*dy);
}

/* Split every road where it meets another. Shared points are shared
   coordinates, so junctions fall out of counting how often each one appears. */
function buildGraph(ways, latScale, schools, cameras){
  var seen = {}, i, n, k;
  for (i=0;i<ways.length;i++){
    var g = ways[i].geometry;
    for (n=0;n<g.length;n++){
      k = nodeKey([g[n].lon, g[n].lat]);
      seen[k] = (seen[k] || 0) + 1;
    }
  }

  var edges = [], nodes = {}, adj = {};
  function addNode(k, p){ if (!nodes[k]) { nodes[k] = p; adj[k] = []; } }

  for (i=0;i<ways.length;i++){
    var w = ways[i], geo = w.geometry;
    if (!geo || geo.length < 2) continue;
    var tags = w.tags || {};
    var one = tags.oneway === "yes" || tags.oneway === "true" || tags.oneway === "1";
    var rev = tags.oneway === "-1";
    var run = [[geo[0].lon, geo[0].lat]], from = nodeKey(run[0]);

    for (n=1;n<geo.length;n++){
      var p = [geo[n].lon, geo[n].lat];
      run.push(p);
      k = nodeKey(p);
      var junction = seen[k] > 1 || n === geo.length-1;
      if (!junction || run.length < 2) continue;
      if (k === from){ run = [p]; continue; }          // ignore closed stubs

      var prep = prepare(run);
      if (prep.metres > 0){
        var pts = rev ? run.slice().reverse() : run;
        var a = rev ? k : from, b = rev ? from : k;
        addNode(a, pts[0]); addNode(b, pts[pts.length-1]);
        var st = statsFor(prep);
        var sev = 0;
        for (var s=0;s<st.radii.length;s++) sev += severity(st.radii[s]);
        sev = st.radii.length ? sev/st.radii.length : 0;
        var q = roadQuality(tags, hazardShare(schools, pts), hazardShare(cameras, pts));
        edges.push({from:a, to:b, pts:pts, metres:prep.metres, fun:sev, quality:q,
                    secs: edgeSeconds(prep, tags),
                    oneway:(one||rev), cls:tags.highway || "unclassified",
                    name: tags.name || tags.ref || "",
                    b0: endBearing(pts, true, latScale),
                    b1: endBearing(pts, false, latScale)});
        adj[a].push(edges.length-1);
        adj[b].push(edges.length-1);
      }
      from = k; run = [p];
    }
  }
  /* Typical pace across this area's roads. Used only to judge how far out
     the walk can afford to wander before the way home eats the whole lap —
     the lap's real duration comes from the segments actually chosen. */
  var tm = 0, ts = 0;
  for (var c=0;c<edges.length;c++){ tm += edges[c].metres; ts += edges[c].secs; }
  var cruise = ts > 0 ? tm/ts : 15;

  return {edges:edges, nodes:nodes, adj:adj, latScale:latScale, cruise:cruise};
}

/* Dead ends can never be part of a lap — you'd have to come back out the way
   you went in. Stripping them repeatedly (removing a spur can expose another
   behind it) leaves only road that lies on some loop, which is the difference
   between a walk that usually fails and one that usually works. */
function pruneSpurs(graph){
  var alive = [], deg = {}, i, e;
  for (i=0;i<graph.edges.length;i++) alive.push(true);

  function count(){
    deg = {};
    for (var n=0;n<graph.edges.length;n++){
      if (!alive[n]) continue;
      var g = graph.edges[n];
      deg[g.from] = (deg[g.from]||0) + 1;
      deg[g.to] = (deg[g.to]||0) + 1;
    }
  }
  count();

  var changed = true;
  while (changed){
    changed = false;
    for (i=0;i<graph.edges.length;i++){
      if (!alive[i]) continue;
      e = graph.edges[i];
      if (e.from === e.to) continue;
      if (deg[e.from] === 1 || deg[e.to] === 1){
        alive[i] = false; deg[e.from]--; deg[e.to]--; changed = true;
      }
    }
  }

  var edges = [], adj = {}, nodes = {};
  for (i=0;i<graph.edges.length;i++){
    if (!alive[i]) continue;
    e = graph.edges[i];
    edges.push(e);
    var k = edges.length-1;
    if (!adj[e.from]) adj[e.from] = [];
    if (!adj[e.to]) adj[e.to] = [];
    adj[e.from].push(k); adj[e.to].push(k);
    nodes[e.from] = graph.nodes[e.from];
    nodes[e.to] = graph.nodes[e.to];
  }
  return {edges:edges, nodes:nodes, adj:adj, latScale:graph.latScale, cruise:graph.cruise};
}

/* OpenStreetMap splits one road into several ways wherever a tag changes, so
   the graph ends up with nodes sitting mid-road where nothing actually meets.
   Laps then start and finish halfway along a lane. Splice any node with
   exactly two roads back into one, which also makes the search pick whole
   roads rather than fragments of them. */
function mergeChains(graph, maxM){
  var edges = graph.edges.slice(), alive = [], adj = {}, i;
  for (i=0;i<edges.length;i++) alive.push(true);

  function add(n, idx){ (adj[n] = adj[n] || []).push(idx); }
  function drop(n, idx){
    var l = adj[n];
    if (!l) return;
    var p = l.indexOf(idx);
    if (p >= 0) l.splice(p, 1);
  }
  for (i=0;i<edges.length;i++){ add(edges[i].from, i); add(edges[i].to, i); }

  var queue = Object.keys(adj);
  while (queue.length){
    var k = queue.pop();
    var list = adj[k];
    if (!list || list.length !== 2) continue;

    var i1 = list[0], i2 = list[1];
    if (i1 === i2 || !alive[i1] || !alive[i2]) continue;
    var a = edges[i1], b = edges[i2];
    if (a.oneway !== b.oneway) continue;
    if (a.metres + b.metres > maxM) continue;      // keep some granularity

    // Point a at the join and b away from it.
    var apts = a.pts, aFrom = a.from;
    if (a.to !== k){
      if (a.oneway) continue;
      apts = apts.slice().reverse(); aFrom = a.to;
    }
    var bpts = b.pts, bTo = b.to;
    if (b.from !== k){
      if (b.oneway) continue;
      bpts = bpts.slice().reverse(); bTo = b.from;
    }
    if (aFrom === bTo) continue;                   // would close a loop on itself

    var m = a.metres + b.metres;
    var merged = {
      from: aFrom, to: bTo,
      pts: apts.concat(bpts.slice(1)),
      metres: m,
      secs: a.secs + b.secs,
      fun: (a.fun*a.metres + b.fun*b.metres)/m,
      quality: (a.quality*a.metres + b.quality*b.metres)/m,
      oneway: a.oneway,
      cls: a.metres >= b.metres ? a.cls : b.cls,
      name: a.metres >= b.metres ? a.name : b.name
    };
    merged.b0 = endBearing(merged.pts, true, graph.latScale);
    merged.b1 = endBearing(merged.pts, false, graph.latScale);

    alive[i1] = false; alive[i2] = false;
    drop(a.from, i1); drop(a.to, i1);
    drop(b.from, i2); drop(b.to, i2);
    delete adj[k];

    var ni = edges.length;
    edges.push(merged); alive.push(true);
    add(aFrom, ni); add(bTo, ni);
    queue.push(aFrom, bTo);
  }

  var out = [], adj2 = {}, nodes = {};
  for (i=0;i<edges.length;i++){
    if (!alive[i]) continue;
    var e = edges[i];
    out.push(e);
    var idx = out.length-1;
    (adj2[e.from] = adj2[e.from] || []).push(idx);
    (adj2[e.to] = adj2[e.to] || []).push(idx);
    nodes[e.from] = graph.nodes[e.from];
    nodes[e.to] = graph.nodes[e.to];
  }
  return {edges:out, nodes:nodes, adj:adj2, latScale:graph.latScale, cruise:graph.cruise};
}

/* Label every separate piece of network. A lane cut off from everything else
   by a main road is its own island, and starting on one is why a search can
   find nothing however far you widen it. */
function components(graph){
  var label = {}, sizes = [], k;
  for (k in graph.nodes){
    if (label[k] !== undefined) continue;
    var id = sizes.length, stack = [k], n = 0;
    label[k] = id;
    while (stack.length){
      var node = stack.pop(); n++;
      var opts = graph.adj[node] || [];
      for (var i=0;i<opts.length;i++){
        var e = graph.edges[opts[i]];
        var other = e.from === node ? e.to : e.from;
        if (label[other] === undefined){ label[other] = id; stack.push(other); }
      }
    }
    sizes.push(n);
  }
  return {label:label, sizes:sizes};
}

/* How far by road, not as the crow flies — a river or a main road can make
   the beeline to a start badly wrong. One Dijkstra from where the user
   actually is gives every candidate's real driving distance at once, which
   is far cheaper than a separate shortest path per candidate. Plain metres
   as the edge weight, not wayBack's fun/quality cost: this is answering
   "how far is the drive out", not building a lap. */
function roadDistances(graph, fromKey){
  var dist = {}, done = {}, heap = new Heap();
  dist[fromKey] = 0; heap.push(0, fromKey);
  while (heap.a.length){
    var top = heap.pop(), d = top[0], node = top[1];
    if (done[node]) continue;
    done[node] = 1;
    var opts = graph.adj[node] || [];
    for (var i=0;i<opts.length;i++){
      var e = graph.edges[opts[i]];
      if (e.oneway && e.from !== node) continue;
      var other = e.from === node ? e.to : e.from;
      var nd = d + e.metres;
      if (dist[other] === undefined || nd < dist[other]){
        dist[other] = nd; heap.push(nd, other);
      }
    }
  }
  return dist;
}

/* Candidate places to begin a lap. The lap doesn't have to start at the
   user's door — driving out to a better bit of country is normal — so this
   returns a spread of junctions across the area, favouring ones that touch
   good road, and reports how far each is from the user. */
function pickStarts(graph, lng, lat, reachM, count){
  var comp = components(graph);
  var biggest = 0, i, k;
  for (i=0;i<comp.sizes.length;i++) if (comp.sizes[i] > biggest) biggest = comp.sizes[i];
  var floor = Math.max(4, biggest * 0.5);
  var ls = graph.latScale;
  var me = [lng, lat];

  // Falls back to the straight line only where road distance can't be had —
  // an unreachable (disconnected) node, or no node in the graph at all.
  var nearest = nearestNode(graph, lng, lat);
  var roadDist = nearest ? roadDistances(graph, nearest) : {};

  var pool = [];
  for (k in graph.nodes){
    if (comp.sizes[comp.label[k]] < floor) continue;
    var away = roadDist[k] !== undefined ? roadDist[k] : metresBetween(graph.nodes[k], me, ls);
    if (away > reachM) continue;
    var opts = graph.adj[k] || [], fun = 0;
    for (i=0;i<opts.length;i++) if (graph.edges[opts[i]].fun > fun) fun = graph.edges[opts[i]].fun;
    pool.push({key:k, away:away, fun:fun, p:graph.nodes[k], ways:opts.length});
  }

  // Begin and end a lap where roads actually meet. Merging removes most
  // mid-road nodes, but not all, and a lap that starts halfway along a lane
  // is an odd thing to be handed.
  var junctions = pool.filter(function(n){ return n.ways >= 3; });
  if (junctions.length >= 8) pool = junctions;

  // Nothing within reach: fall back to the nearest usable junction at any range.
  if (!pool.length){
    var best = null, bestD = Infinity;
    for (k in graph.nodes){
      if (comp.sizes[comp.label[k]] < floor) continue;
      var d = roadDist[k] !== undefined ? roadDist[k] : metresBetween(graph.nodes[k], me, ls);
      if (d < bestD){ bestD = d; best = k; }
    }
    return {starts: best ? [{key:best, away:bestD}] : [], biggest:biggest, parts:comp.sizes.length};
  }

  pool.sort(function(a,b){ return b.fun - a.fun; });

  // Spread them out, so we're not testing eight junctions on the same lane.
  var picked = [], spacing = Math.max(1200, reachM/5);
  while (picked.length < count && spacing > 150){
    for (i=0;i<pool.length && picked.length<count;i++){
      var ok = true;
      for (var j=0;j<picked.length;j++){
        if (metresBetween(pool[i].p, picked[j].p, ls) < spacing){ ok = false; break; }
      }
      if (ok && picked.indexOf(pool[i]) === -1) picked.push(pool[i]);
    }
    spacing = spacing/2;
  }
  return {starts: picked, biggest: biggest, parts: comp.sizes.length};
}

/* Small seeded random so a given search is repeatable. */
function seededRandom(seed){
  var a = seed >>> 0;
  return function(){
    a += 0x6D2B79F5;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Heap(){ this.a = []; }
Heap.prototype.push = function(cost, node){
  var a = this.a, i = a.length;
  a.push([cost,node]);
  while (i > 0){
    var p = (i-1) >> 1;
    if (a[p][0] <= a[i][0]) break;
    var t = a[p]; a[p] = a[i]; a[i] = t; i = p;
  }
};
Heap.prototype.pop = function(){
  var a = this.a, top = a[0], last = a.pop();
  if (a.length){
    a[0] = last;
    var i = 0;
    for (;;){
      var l = 2*i+1, r = l+1, s = i;
      if (l < a.length && a[l][0] < a[s][0]) s = l;
      if (r < a.length && a[r][0] < a[s][0]) s = r;
      if (s === i) break;
      var t = a[s]; a[s] = a[i]; a[i] = t; i = s;
    }
  }
  return top;
};

/* The way back. Cheapest route home, where cheap means good road rather than
   short road, road already driven costs triple, and swinging off onto a side
   turning costs more than carrying straight on.

   That last part is why this searches over roads rather than junctions: the
   cost of a road depends on which road you arrived by, so the state has to
   remember how you got there. */
function wayBack(graph, from, to, used){
  if (from === to) return [];

  var dist = {}, prev = {}, done = {}, heap = new Heap(), i;

  /* Reuse has to cost more than the worst turn penalty (about 6.7x), or the
     way home would rather retrace a mile of road than take a sharp left.
     At 9x it still took the retrace whenever the alternative was much longer,
     which is how a lap ends up running out and straight back down the same
     lane. Driving the same road twice is close to the worst thing a lap can
     do, so it's priced accordingly. */
  function cost(e, ei, turn, sameRoad){
    var c = e.metres * (used[ei] ? 25 : 1) / (0.15 + e.fun * e.quality);
    return turn === null ? c : c / continuity(turn, sameRoad);
  }

  var first = graph.adj[from] || [];
  for (i=0;i<first.length;i++){
    var e0 = graph.edges[first[i]];
    if (e0.oneway && e0.from !== from) continue;
    var at0 = e0.from === from ? e0.to : e0.from;
    var k0 = first[i] + "|" + at0;
    var c0 = cost(e0, first[i], null, false);
    if (dist[k0] === undefined || c0 < dist[k0]){
      dist[k0] = c0; prev[k0] = null; heap.push(c0, k0);
    }
  }

  var goal = null;
  while (heap.a.length){
    var top = heap.pop(), d = top[0], key = top[1];
    if (done[key]) continue;
    done[key] = 1;

    var bar = key.indexOf("|");
    var ei = +key.slice(0, bar), at = key.slice(bar+1);
    if (at === to){ goal = key; break; }

    var here = graph.edges[ei];
    var inbound = (leaving(here, at) + 180) % 360;
    var opts = graph.adj[at] || [];

    for (i=0;i<opts.length;i++){
      var ni = opts[i];
      if (ni === ei) continue;                       // no turning round on the spot
      var e = graph.edges[ni];
      if (e.oneway && e.from !== at) continue;
      var other = e.from === at ? e.to : e.from;
      var k = ni + "|" + other;
      if (done[k]) continue;
      var nd = d + cost(e, ni, turnFrom(inbound, leaving(e, at)), !!here.name && e.name === here.name);
      if (dist[k] === undefined || nd < dist[k]){
        dist[k] = nd; prev[k] = key; heap.push(nd, k);
      }
    }
  }

  if (!goal) return null;

  var path = [], step = goal;
  while (step !== null && step !== undefined){
    var b = step.indexOf("|");
    var edge = graph.edges[+step.slice(0, b)], arrivedAt = step.slice(b+1);
    path.unshift({ei: +step.slice(0, b), e: edge, forward: edge.to === arrivedAt});
    step = prev[step];
  }
  return path;
}

/* Head out on the best road available, then find a way home. The outward leg
   is random so every attempt differs; the homeward leg is computed, so a lap
   almost always closes instead of relying on a lucky junction. */
function walkCircuit(graph, startKey, targetS, seed, room){
  var rnd = seededRandom(seed * 2654435761);
  var node = startKey, used = {}, path = [], total = 0;
  var home = graph.nodes[startKey], ls = graph.latScale;
  var cruise = graph.cruise || 15;
  var targetM = targetS * cruise;        // rough distance equivalent, for the leash
  var cap = Math.max(150, Math.min(5000, Math.round(targetS/2)));

  var inbound = null, road = "";

  for (var step=0; step<cap; step++){
    // Keep going out until getting home would finish the lap. Stopping at a
    // fixed fraction leaves the cheap way home too short and the lap undersized.
    var fromHome = metresBetween(graph.nodes[node], home, ls);
    if (total + (fromHome/cruise)*1.5 >= targetS) break;

    var opts = graph.adj[node] || [], cands = [], i;
    for (i=0;i<opts.length;i++){
      var ei = opts[i];
      if (used[ei]) continue;
      var e = graph.edges[ei];
      if (e.oneway && e.from !== node) continue;
      cands.push({ei:ei, e:e, other: e.from === node ? e.to : e.from});
    }
    if (!cands.length) break;

    // Don't wander so far out that the way home swallows the whole lap.
    var here = fromHome;
    /* Whichever is tighter: how far the lap's length justifies wandering, or
       how much fetched map is actually out there. In fast open country the
       first can exceed the second, and walking into an empty edge of the
       world produces truncated laps rather than an error. */
    var leash = here > Math.min(targetM * LEASH, room || Infinity);
    var sum = 0;
    for (i=0;i<cands.length;i++){
      var w = Math.pow(0.04 + cands[i].e.fun, 2.4) * cands[i].e.quality;
      if (inbound !== null){
        var out = leaving(cands[i].e, node);
        var sameName = !!road && cands[i].e.name === road;
        w *= continuity(turnFrom(inbound, out), sameName);
      }
      if (leash){
        var there = metresBetween(graph.nodes[cands[i].other], home, ls);
        w *= there < here ? 3 : 0.35;
      }
      cands[i].w = w; sum += w;
    }

    var pick = rnd()*sum, acc = 0, chosen = cands[cands.length-1];
    for (i=0;i<cands.length;i++){ acc += cands[i].w; if (acc >= pick){ chosen = cands[i]; break; } }

    used[chosen.ei] = 1;
    path.push({ei:chosen.ei, e:chosen.e, forward: chosen.e.from === node});
    total += chosen.e.secs + TURN_ALLOW;
    inbound = (leaving(chosen.e, chosen.other) + 180) % 360;   // how you arrive
    road = chosen.e.name;
    node = chosen.other;
  }

  if (!path.length) return {fail:"stuck"};

  var back = wayBack(graph, node, startKey, used);
  if (!back) return {fail:"noway"};
  for (var b=0;b<back.length;b++){ path.push(back[b]); total += back[b].e.secs + TURN_ALLOW; }

  /* Approximate — steering only. The exact duration, including every turn,
     is computed in circuitToPath once the lap is fixed. */
  return {path:path, secs:total};
}

/* Stitch a circuit's segments into the same shape a routed path has, so the
   scoring and display don't need to know where it came from. */
/* Places the route passes, in travel order. A hamlet has to be almost on the
   road to count; a town registers from further off, because you'd say you went
   "through Southam" from its edge but not "through" a hamlet you passed a
   field away from. */
var PLACE_REACH = {town: 1500, suburb: 1100, village: 850, hamlet: 450};

function placesAlong(places, pts, latScale){
  if (!places || !places.length || !pts || pts.length < 2) return [];
  var out = [], seen = {}, stride = Math.max(1, Math.round(pts.length/400)), i, j;

  for (i=0;i<pts.length;i+=stride){
    var best = null, bestD = Infinity;
    for (j=0;j<places.length;j++){
      var p = places[j];
      if (seen[p.name]) continue;
      var dx = (p.lon - pts[i][0]) * latScale;
      var dy = (p.lat - pts[i][1]) * 110540;
      var d = Math.sqrt(dx*dx + dy*dy);
      if (d < (PLACE_REACH[p.kind] || 600) && d < bestD){ bestD = d; best = p; }
    }
    if (best){ seen[best.name] = 1; out.push(best); }
  }
  return out;
}

/* PLACE_REACH decides what's fair to call out in a sentence — generous, on
   purpose, since "through Southam" is a reasonable claim from its edge. A map
   pin has no such slack: a village a field away reads fine in words but,
   pinned at its true spot, just looks like a dot floating off the drawn line.
   So the pin gets its own flat, tight distance to the actual route geometry,
   not the size-scaled reach used for the words. */
var MAP_PIN_REACH = 350;

function nearRoute(p, pts, latScale){
  var best = Infinity;
  for (var i=0;i<pts.length;i++){
    var dx = (p.lon - pts[i][0]) * latScale, dy = (p.lat - pts[i][1]) * 110540;
    var d = dx*dx + dy*dy;
    if (d < best) best = d;
  }
  return best <= MAP_PIN_REACH*MAP_PIN_REACH;
}

/* Too many names is as unhelpful as none. Keep the ends — where you start and
   the furthest point are the ones that place the drive — and thin the middle,
   preferring bigger settlements. */
function viaPicked(found, max){
  if (found.length <= max) return found.slice();
  var rank = {town:1, suburb:2, village:3, hamlet:4};   // 1-based: 0 is falsy
  var keep = [found[0], found[found.length-1]];
  var middle = found.slice(1, -1).slice();
  middle.sort(function(a,b){ return (rank[a.kind]||9) - (rank[b.kind]||9); });
  keep = keep.concat(middle.slice(0, max-2));
  var order = {};
  found.forEach(function(p,i){ order[p.name] = i; });
  return keep.sort(function(a,b){ return order[a.name] - order[b.name]; });
}

function sentence(list){
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return list.slice(0,-1).join(", ") + " and " + list[list.length-1];
}

function circuitToPath(circuit, graph){
  var coords = [], road = [], secs = 0, metres = 0, prevOut = null, risk = [];
  for (var i=0;i<circuit.path.length;i++){
    var leg = circuit.path[i], pts = leg.forward ? leg.e.pts : leg.e.pts.slice().reverse();
    var at = coords.length;
    for (var n = (i === 0 ? 0 : 1); n<pts.length; n++) coords.push(pts[n]);
    road.push([at ? at-1 : 0, coords.length-1, leg.e.cls]);

    // Time to drive the stretch, plus the time lost turning onto it.
    secs += leg.e.secs;
    metres += leg.e.metres;
    var into = leg.forward ? leg.e.b0 : (leg.e.b1 + 180) % 360;
    if (prevOut !== null){
      secs += turnSeconds(turnFrom(prevOut, into) * Math.PI/180);
      if (graph){
        var node = leg.forward ? leg.e.from : leg.e.to;
        if (routerWouldDiverge(graph, node, circuit.path[i-1].ei, prevOut, leg.ei, into))
          risk.push(at ? at-1 : 0);
      }
    }
    prevOut = leg.forward ? leg.e.b1 : (leg.e.b0 + 180) % 360;
  }
  // Closing the loop is a turn too.
  if (circuit.path.length > 1 && prevOut !== null){
    var first = circuit.path[0];
    var back = first.forward ? first.e.b0 : (first.e.b1 + 180) % 360;
    secs += turnSeconds(turnFrom(prevOut, back) * Math.PI/180);
  }

  var byName = {};
  for (i=0;i<circuit.path.length;i++){
    var nm = circuit.path[i].e.name;
    if (nm) byName[nm] = (byName[nm] || 0) + circuit.path[i].e.metres;
  }
  var roads = Object.keys(byName).map(function(n){ return [n, byName[n]]; })
              .sort(function(a,b){ return b[1] - a[1]; });

  return {points:{coordinates:coords}, distance:metres, time:secs*1000,
          roads:roads, details:{road_class:road}, risk:risk};
}

function nearestNode(graph, lng, lat){
  var best = null, bestD = Infinity;
  for (var k in graph.nodes){
    var p = graph.nodes[k];
    var d = (p[0]-lng)*(p[0]-lng) + (p[1]-lat)*(p[1]-lat);
    if (d < bestD){ bestD = d; best = k; }
  }
  return best;
}

/* The search as a set of jobs rather than a loop, so it can be run straight
   through (tests, fallback) or a slice at a time across frames. Same work
   either way — only who decides when to stop. */
function makeSearch(graph, start, targetS, reachM, tries){
  var picked = pickStarts(graph, start.lng, start.lat, reachM, 8);
  var diag = {parts: picked.parts, biggest: picked.biggest,
              starts: picked.starts.length, stuck:0, noway:0, closed:0};

  var on = [], off = [], seen = {}, s, t;
  var each = Math.max(12, Math.round(tries/picked.starts.length || 1));
  /* The walk reasons in raw model seconds, so the target it chases has to be
     un-corrected first; the comparison afterwards uses corrected time. */
  var walkTarget = targetS / paceFactor();

  // "Somewhere new": built once per search, not per candidate.
  var fresh = state.freshness ? drivenCells(graph.latScale) : null;

  /* Round-robin across start points rather than exhausting each in turn, so
     the first laps to appear come from different parts of the map instead of
     all clustering round whichever junction happened to be first. */
  var jobs = [];
  for (t=0;t<each;t++){
    for (s=0;s<picked.starts.length;s++){
      var from = picked.starts[s];
      jobs.push({
        from: from,
        seed: s*1000 + t + 1,
        // Road left between this start and the edge of what we downloaded.
        room: graph.radius ? Math.max(1200, (graph.radius - (from.away || 0)) * 0.9)
                           : Infinity
      });
    }
  }

  function step(job){
    var c = walkCircuit(graph, job.from.key, walkTarget, job.seed, job.room);
    if (!c) return;
    if (c.fail){ diag[c.fail]++; return; }
    diag.closed++;

    var ids = c.path.map(function(l){ return l.ei; }).sort(function(a,b){ return a-b; }).join(",");
    if (seen[ids]) return;
    seen[ids] = 1;

    var path = circuitToPath(c, graph);
    var secs = (path.time/1000) * paceFactor();
    var r = score(path);
    r.approach = job.from.away;
    /* Being over the time asked for is worse than being under it — an hour
       means an hour, and a lap that quietly runs to ninety minutes is a
       broken promise rather than a bonus. */
    var off_ = (secs - targetS)/targetS;
    r.total -= (off_ > 0 ? off_*7 : -off_*4);
    r.total -= (job.from.away/1000) * 0.25;                  // shorter drive out
    if (fresh){
      r.stale = hazardShare(fresh, r.pts);
      r.total -= r.stale * FRESH_WEIGHT;
    }
    if (secs >= targetS*0.75 && secs <= targetS*1.25) on.push(r); else off.push(r);
  }

  function best(){
    var pool = on.length ? on : off, b = null;
    for (var i=0;i<pool.length;i++) if (!b || pool[i].total > b.total) b = pool[i];
    return b;
  }

  function result(){
    return {found: on.length ? on : off, diag: diag,
            loose: !on.length && off.length > 0};
  }

  return {jobs: picked.starts.length ? jobs : [], step: step, best: best,
          result: result, count: function(){ return on.length + off.length; }};
}

function findCircuits(graph, start, targetS, reachM, tries){
  var S = makeSearch(graph, start, targetS, reachM, tries);
  for (var i=0;i<S.jobs.length;i++) S.step(S.jobs[i]);
  return S.result();
}

/* The same search, run in slices between frames. Two things follow: the map
   stays draggable while it thinks, and a lap appears within a second or so
   and improves as better ones turn up — so the wait becomes something to
   watch rather than a frozen screen. */
function findCircuitsLive(graph, start, targetS, reachM, tries, onBest, onTick){
  var S = makeSearch(graph, start, targetS, reachM, tries);
  var i = 0, shown = null;
  var SLICE = 20;                      // ms of work per frame; leaves room to paint

  return new Promise(function(resolve){
    function chunk(){
      var t0 = Date.now();
      while (i < S.jobs.length && Date.now() - t0 < SLICE) S.step(S.jobs[i++]);

      var b = S.best();
      if (b && b !== shown){ shown = b; onBest(b); }
      if (onTick) onTick(i, S.jobs.length, S.count());

      if (i < S.jobs.length) requestAnimationFrame(chunk);
      else resolve(S.result());
    }
    requestAnimationFrame(chunk);
  });
}

function begin(){
  var btn = document.getElementById("go");
  btn.disabled = true; btn.className = "busy"; btn.textContent = "Searching…";
  /* Mood buttons stay on screen for the whole search (has-route only flips
     once results land), so without this a second tap mid-search would start
     an overlapping one. */
  document.getElementById("moods").classList.add("busy");
  /* Any search, however it started, settles the "change mood" toggle back to
     its resting state — there's no lap left to go back to until this one lands. */
  document.getElementById("sheet").classList.remove("remood");
  setRemoodLabel(false);
  clearRoutes();
}

/* #remood toggles between "I want a different mood" and "never mind, back to
   my lap" — the label has to say which one a tap will do next. */
function setRemoodLabel(on){
  var b = document.getElementById("remood");
  if (!b) return;
  b.textContent = on ? "Back to this lap" : "Change mood";
  b.setAttribute("aria-pressed", on ? "true" : "false");
}

function finish(){
  var btn = document.getElementById("go");
  btn.disabled = false; btn.className = ""; btn.textContent = "Find me a drive";
  document.getElementById("moods").classList.remove("busy");
}

/* Only one search's winner is ever on screen now, but re-searching (a new
   mood, a chip tweak) throws the previous one away entirely — including one
   you liked but hadn't starred yet. A short session-only history (not saved,
   not persisted; favouriting is still the durable way to keep one) lets you
   flip back. */
var HISTORY_MAX = 5;

function pushHistory(r){
  // Re-searching and landing the same lap again shouldn't duplicate it.
  if (state.history[0] && lapId(state.history[0]) === lapId(r)) return;
  state.history.unshift(r);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
}

function showHistory(i){
  var r = state.history[i];
  if (!r) return;
  state.results = [r];
  show(0);
}

function renderHistory(){
  var box = document.getElementById("history");
  if (!box) return;
  box.innerHTML = "";
  if (state.history.length < 2) return;   // nothing to flip back to yet
  state.history.forEach(function(r, i){
    var b = document.createElement("button");
    b.className = "hist" + (state.results[0] === r ? " on" : "");
    b.innerHTML = "<b>" + clock(r.mins) + "</b>" + Math.round(r.km*MI) + "mi";
    b.addEventListener("click", function(){ showHistory(i); });
    box.appendChild(b);
  });
}

function present(found, note){
  if (!found.length) throw new Error(note || "Nothing came back. Try a different length or start point.");
  found.sort(function(a,b){ return b.total - a.total; });
  var best = found[0];
  best.pool = found.length;   // for renderWhy() — dropped the 5-tab compare, kept the reason
  state.results = [best];
  pushHistory(best);
  show(0);
}

function searchCircuit(mins){
  var targetS = mins * 60;
  var reachM = state.reach / MI * 1000;

  /* How much map to fetch. The walk can never get further from its start than
     LEASH of the lap length, and the start itself is at most reachM away, so
     that sum plus a small margin is the whole world it can reach. Sizing it
     off a circle's circumference instead, as this used to, asked for roughly
     half as much again as the search could ever use.
     Corrected by your own pace: if you drive slower than the model reckons,
     an hour covers less ground and needs less map. */
  var reckonM = (targetS / paceFactor()) * RECKON_SPEED;
  var radius = Math.min(34000, reckonM * LEASH * 1.15 + reachM);

  /* Round up to a 2.5km step. The exact figure drifts every time calibration
     nudges your pace, and a radius that differs by 300m is a completely fresh
     download of the same roads. Bucketing means small changes land on the area
     already sitting on the phone instead of going back to a shared service. */
  radius = Math.min(34000, Math.ceil(radius / 2500) * 2500);

  var t0 = Date.now(), tFetch = 0;

  startSweep(state.start, radius);
  frameArea(state.start, radius);

  return ensureGraph(state.start, radius).then(function(graph){
    stopSweep();
    tFetch = Date.now() - t0;
    if (graph.edges.length < 30)
      throw new Error("Not enough connected road around here to build a lap. Try starting somewhere less built up.");
    say("Looking for a lap…");
    var tSearch = Date.now(), seenBest = 0, lastCount = -1;

    return findCircuitsLive(graph, state.start, targetS, reachM, 200,
      function(best){
        // Draw the leader as soon as there is one, then quietly replace it.
        state.results = [best];
        show(0, seenBest++ > 0);
      },
      function(done, total, found){
        if (found === lastCount) return;        // only speak when something changed
        lastCount = found;
        say(found ? ("Looking… " + found + (found === 1 ? " lap" : " laps") + " so far")
                  : "Looking for a lap…");
      }
    ).then(function(r){
      tSearch = Date.now() - tSearch;
      return finishSearch(r, graph, tFetch, tSearch, radius);
    });
  });
}

function finishSearch(r, graph, tFetch, tSearch, radius){
    var d = r.diag;

    /* Where the wait went. Only surfaced when it was actually a wait, but
       always recorded, so a slow search can be diagnosed rather than guessed
       at — reading the map and searching it are very different problems. */
    state.timing = {fetch: tFetch, search: tSearch,
                    cached: tFetch < 60, segments: graph.edges.length,
                    radius: Math.round(radius/1000)};

    if (!r.found.length){
      throw new Error("No lap closed. " + graph.edges.length + " segments, "
        + d.parts + " separate networks, biggest has " + d.biggest + " junctions, "
        + d.starts + " start points tried. "
        + d.stuck + " runs hit a dead end, " + d.noway + " found no way back.");
    }

    present(r.found);
    var total = Math.round((tFetch + tSearch)/100)/10;
    say(r.loose ? "Nothing at that length. These are the closest."
      : total >= 2 ? ("Took " + total + "s — " + Math.round(tFetch/1000)
                      + "s reading the map, " + Math.round(tSearch/1000) + "s searching it.")
      : "");
}

function search(){
  if (!state.start){ say("Waiting for your location. Tap the map to pick a start instead.", true); return; }
  begin();
  searchCircuit(state.mins)
    .catch(function(err){ say(err.message, true); })
    .then(function(){ stopSweep(); finish(); });
}

/* ---------- display ---------- */

function clock(mins){
  var h = Math.floor(mins/60), m = Math.round(mins%60);
  if (m === 60){ h++; m = 0; }
  return h ? (h + "h" + (m ? (m<10?"0":"") + m : "")) : (m + "m");
}

function say(text, bad){
  var el = document.getElementById("msg");
  el.textContent = text || "";
  el.className = bad ? "bad" : "";
}

function clearRoutes(){
  state.results = []; state.active = -1;
  labelPlaces = []; drawLabels();
  markHasRoute(); renderPlan();
  window.dispatchEvent(new Event("backroads:route"));
  if (routeLine){ map.removeLayer(routeLine); routeLine = null; }
  if (ghostLine){ map.removeLayer(ghostLine); ghostLine = null; }
  if (lapMarker){ map.removeLayer(lapMarker); lapMarker = null; }
  document.getElementById("approach").textContent = "";
  document.getElementById("stats").hidden = true;
  document.getElementById("readout").hidden = true;
  state.bounds = null;
  document.getElementById("empty").hidden = false;
  document.getElementById("weather").hidden = false;
  document.getElementById("nav").disabled = true;
  syncStar();
}

/* Worked out only for the lap you're looking at. Doing it for all 200
   candidates would cost more than the search itself. */
function describe(r){
  if (r.via !== undefined) return r.via;
  var g = state.graph;
  var found = g ? placesAlong(g.places, r.pts, g.latScale) : [];
  r.viaPlaces = viaPicked(found, 4);
  r.viaNames = r.viaPlaces.map(function(p){ return p.name; });
  r.anchor = anchorPlace(found);
  r.via = sentence(r.viaNames);
  return r.via;
}

/* The one place worth naming the lap after: the biggest thing it goes through,
   falling back to the first. "Southam loop" beats "24 mile lap". */
function anchorPlace(found){
  if (!found.length) return "";
  var rank = {town:1, suburb:2, village:3, hamlet:4};   // 1-based: 0 is falsy
  var best = found[0];
  for (var i=1;i<found.length;i++){
    if ((rank[found[i].kind]||9) < (rank[best.kind]||9)) best = found[i];
  }
  return best.name;
}

function roadsLine(r){
  var big = (r.roads || []).filter(function(x){ return x[1] > 900; }).slice(0,3);
  return big.length ? sentence(big.map(function(x){ return x[0]; })) : "";
}

/* Place and road names come from OpenStreetMap, which anyone can edit, so they
   are never treated as markup. Built as text nodes rather than a string of
   HTML — there is no parse step for a crafted name to exploit. */
/* OpenStreetMap names are editable by anyone, so they are never trusted as
   markup anywhere they reach the page. */
function escapeText(t){
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function markChip(id, value){
  var box = document.getElementById(id);
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll("button"), function(b){
    b.className = (b.getAttribute("data-v") === String(value)) ? "on" : "";
  });
}

/* Put last session's settings back, into the chips as well as the state, so
   the options screen agrees with what the app is about to do. */
function applyPrefs(){
  var p = loadPrefs();
  if (!p) return;
  if (p.mins) state.mins = Math.min(p.mins, 60);
  if (typeof p.reach === "number") state.reach = Math.min(p.reach, 10);
  if (p.style) state.style = p.style;
  if (typeof p.freshness === "boolean") state.freshness = p.freshness;

  markChip("mins-chips", state.mins);
  markChip("reach-chips", state.reach);
  markChip("style-chips", state.style);
}

/* Moods are the landing action now — see CLAUDE.md's "Purpose, reframed".
   Each is a one-tap preset across duration, reach and whether to steer away
   from recently-driven road. Corner style is deliberately not part of most
   moods — it's a standing taste, not something the reason for the drive
   should overrule — except "scenic", where asking for scenic roads *is*
   asking for flowing over technical, so that one search borrows the style
   chip without becoming your new standing preference (see pickMood). */
var MOODS = {
  quick:  {mins:15, reach:0,  fresh:false},                        // a spare 20 minutes, not looking for much
  scenic: {mins:30, reach:5,  fresh:false, style:"flowing"},       // the point is the road, not the pace
  fresh:  {mins:45, reach:10, fresh:true},                         // the point is not driving what you already have
  long:   {mins:60, reach:10, fresh:false}                         // deliberately hand back the known favourite
};

function pickMood(name){
  var m = MOODS[name];
  if (!m) return;
  state.mins = m.mins; state.reach = m.reach; state.freshness = m.fresh;
  savePrefs();                       // persists mins/reach/freshness as the new defaults
  markChip("mins-chips", state.mins);
  markChip("reach-chips", state.reach);

  /* Style resolves fresh from the saved preference every time, then a mood
     can override it for just this search — so a scenic drive never quietly
     becomes your new everyday taste, and picking any other mood afterward
     can't inherit scenic's leftover override either. */
  var saved = loadPrefs();
  state.style = m.style || (saved && saved.style) || "tight";
  markChip("style-chips", state.style);

  search();
}

/* The empty Route tab leads with the mood buttons now; this is just the small
   prompt sitting above them. */
function renderPlan(){
  var el = document.getElementById("empty");
  if (!el || state.results.length) return;
  el.textContent = "What's the drive for?";
}

function markHasRoute(){
  document.getElementById("sheet").classList.toggle("has-route", state.results.length > 0);
}

/* Labels are positioned in screen space, so they can only be laid out once the
   map has settled where it's going — and have to be laid out again whenever it
   moves. Placing them before a fitBounds, as this used to, meant measuring
   against a view that no longer existed by the time anyone saw it. */
var labelPlaces = [];

function drawLabels(){
  for (var i=0;i<placeMarks.length;i++) map.removeLayer(placeMarks[i]);
  placeMarks = [];
  if (!labelPlaces.length || !map) return;

  var size = map.getSize();
  var free = size.y - sheetCover();          // the strip of map actually visible
  var taken = [];

  /* Biggest places first, so when two collide the one that survives is the one
     that better describes where you're going. */
  var rank = {town:1, suburb:2, village:3, hamlet:4};
  var order = labelPlaces.slice().sort(function(a,b){
    return (rank[a.kind]||9) - (rank[b.kind]||9);
  });

  /* A flat distance check let a long name pass as "far enough" from its
     neighbour by dot position alone, then overlap it anyway once drawn —
     "Harborough Magna" is nearly twice the box width of "Brinklow". Rough
     estimate of the pill's rendered width stands in for measuring the actual
     (not-yet-added) DOM node: dot + gap + padding, then Barlow Condensed
     semibold at 15px with letter-spacing, about 8.6px/character. */
  function labelWidth(name){ return 34 + name.length * 8.6; }

  order.forEach(function(p){
    var pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < 8 || pt.x > size.x - 8 || pt.y < 8 || pt.y > free - 8) return;

    var w = labelWidth(p.name);

    /* Try to keep a label rather than drop it: nudge it up or down a line or
       two first, and only give up if every offset still collides. Dropping
       freely would leave the panel listing places the map doesn't show. */
    var nudges = [0, -20, 20, -40, 40], dy = null;
    for (var n=0; n<nudges.length && dy === null; n++){
      var y = pt.y + nudges[n], clash = false;
      if (y < 8 || y > free - 8) continue;
      for (var t=0;t<taken.length;t++){
        var minDist = (taken[t].w + w) / 2 + 12;   // half each box, plus a gap
        if (Math.abs(taken[t].x - pt.x) < minDist && Math.abs(taken[t].y - y) < 26){ clash = true; break; }
      }
      if (!clash) dy = nudges[n];
    }
    if (dy === null) return;
    taken.push({x: pt.x, y: pt.y + dy, w: w});

    // Put the text on whichever side has more room, so it can't run off-screen.
    var flip = pt.x > size.x * 0.62;

    placeMarks.push(L.marker([p.lat, p.lon], {
      interactive: false,
      icon: L.divIcon({
        className: "",
        /* The name is escaped into the markup rather than written in after:
           nothing depends on the element existing yet, and an OSM name
           containing markup stays inert. */
        html: '<div class="place' + (flip ? ' flip' : '') + '"'
              + (dy ? ' style="margin-top:' + dy + 'px"' : '') + '><i></i><span>'
              + escapeText(p.name) + '</span></div>',
        iconSize: [0,0], iconAnchor: [0,0]
      })
    }).addTo(map));
  });
}

function renderVia(r){
  var el = document.getElementById("via");
  var via = describe(r), roads = roadsLine(r);
  el.textContent = "";
  if (!via && !roads) return;

  function add(text, strong){
    var node = strong ? document.createElement("b") : document.createTextNode(text);
    if (strong){ node.textContent = text; }
    el.appendChild(node);
  }

  if (via){ add("Through "); add(via, true); }
  if (roads){
    add(via ? ", mainly " : "Mainly ");
    add(roads, true);
  }
}

/* Dropping the 5-lap tabs meant losing any sense of why this one won. This
   doesn't bring the comparison back, just names the one or two things that
   actually drove the score, plus the field it beat — enough to trust the
   pick without re-litigating it. */
function whyPicked(r){
  var bits = [];
  if (r.best >= 3) bits.push(r.best.toFixed(1) + " miles of continuous cornering");
  else if (r.twisty >= 0.55) bits.push(Math.round(r.twisty*100) + "% of it cornering");
  if (typeof r.stale === "number" && r.stale < 0.1) bits.push("roads you haven't driven recently");
  if (Math.max(r.lap*2, r.near || 0) < 0.02) bits.push("almost no doubling back");

  var text = bits.length ? "Picked for " + sentence(bits) : "";
  if (r.pool > 1){
    text += (text ? " — beat " : "Beat ") + (r.pool-1) + " other attempt" + (r.pool-1 === 1 ? "" : "s") + ".";
  } else if (text) text += ".";
  return text;
}

function renderWhy(r){
  var el = document.getElementById("why");
  if (el) el.textContent = whyPicked(r);
}

function show(i, keepView){
  var r = state.results[i];
  if (!r) return;
  state.active = i;
  window.dispatchEvent(new Event("backroads:route"));

  var latlngs = r.pts.map(function(p){ return [p[1], p[0]]; });
  if (routeLine) map.removeLayer(routeLine);
  if (ghostLine) map.removeLayer(ghostLine);
  var css = getComputedStyle(document.body);
  var routeColour = css.getPropertyValue("--route").trim() || "#80A3C5";
  var casing = css.getPropertyValue("--casing").trim() || "#FFFFFF";
  ghostLine = L.polyline(latlngs, {color:casing, weight:13, opacity:1,
                                   lineCap:"round", lineJoin:"round"}).addTo(map);
  routeLine = L.polyline(latlngs, {color:routeColour, weight:6, opacity:1,
                                   lineCap:"round", lineJoin:"round"}).addTo(map);
  state.bounds = routeLine.getBounds();
  /* While the search is still running the map holds still — refitting on every
     improvement would throw the view around several times a second. */
  if (!keepView) frameRoute(state.bounds);
  drawLabels();

  document.getElementById("empty").hidden = true;
  document.getElementById("weather").hidden = true;
  document.getElementById("readout").hidden = false;
  document.getElementById("km").innerHTML = Math.round(r.km*MI) + "<span>mi</span>";
  document.getElementById("dur").textContent = clock(r.mins);
  var away = (r.approach || 0) * MI / 1000;
  document.getElementById("approach").textContent =
    away > 0.6 ? "Lap starts " + away.toFixed(away < 10 ? 1 : 0) + " miles away" : "";

  /* Name the places on the map, not just in the panel — the point is to
     recognise where you're going before you commit to driving there.
     describe() must run before this, not after: it's what works the list out,
     and reading it first left every lap unlabelled until its second viewing. */
  describe(r);
  var ls = 111320 * Math.cos(r.pts[0][1] * Math.PI/180);
  labelPlaces = (r.viaPlaces || []).filter(function(p){ return nearRoute(p, r.pts, ls); });

  if (lapMarker){ map.removeLayer(lapMarker); lapMarker = null; }
  if (away > 0.6){
    lapMarker = L.marker([r.pts[0][1], r.pts[0][0]], {
      icon: L.divIcon({className:"", html:'<div class="lap-dot"></div>', iconSize:[20,20], iconAnchor:[10,10]})
    }).addTo(map);
  }

  document.getElementById("stats").hidden = false;
  document.getElementById("s-run").textContent = (r.best*MI).toFixed(1);
  document.getElementById("s-twisty").textContent = Math.round(r.twisty*100) + "%";
  document.getElementById("s-back").textContent =
    Math.round(Math.min(1, Math.max(r.lap*2, r.near || 0))*100) + "%";
  document.getElementById("nav").disabled = false;
  markHasRoute();
  renderVia(r);
  renderWhy(r);
  renderHistory();
  syncStar();
  if (activePane !== "route") showPane("route");
}

/* ---------- saved laps ---------- */

var STORE = "backroad.laps";
var PACE_STORE = "backroads.pace";
var PREF_STORE = "backroads.prefs";

/* What you last asked for. Restored on open so the app can lead with a button
   rather than a form — the settings are still one tap away, they just stop
   being a toll gate on the way to a drive. */
function loadPrefs(){
  try { return JSON.parse(localStorage.getItem(PREF_STORE)) || null; }
  catch(e){ return null; }
}
function savePrefs(){
  try {
    localStorage.setItem(PREF_STORE, JSON.stringify({
      mins: state.mins, reach: state.reach, style: state.style, freshness: state.freshness
    }));
  } catch(e){}
}

/* ---------- calibration ----------

   The speed model is physics plus assumptions about how briskly you drive.
   The physics is sound; the assumptions are guesses. So rather than leave
   them as constants only I can edit, the app learns them: tell it how long
   a lap actually took and it corrects every estimate afterwards.

   Kept separate from the laps themselves, because deleting a lap shouldn't
   throw away what it taught the app. Ratios are actual/predicted, so above
   1 means you're slower than it reckoned. */

var paceCache = null;

function paceSamples(){
  try { return JSON.parse(localStorage.getItem(PACE_STORE)) || []; }
  catch(e){ return []; }
}

function addPaceSample(ratio){
  var s = paceSamples();
  s.push(Math.round(ratio*1000)/1000);
  if (s.length > 10) s = s.slice(s.length-10);      // recent drives only
  try { localStorage.setItem(PACE_STORE, JSON.stringify(s)); } catch(e){}
  paceCache = null;
}

/* Median, not mean: one drive where you stopped for fuel shouldn't drag
   every future estimate with it. Clamped, because a mistyped number
   shouldn't be able to break the app's sense of time either. */
function paceFactor(){
  if (paceCache !== null) return paceCache;
  var s = paceSamples();
  if (!s.length) return (paceCache = 1);
  var v = s.slice().sort(function(a,b){ return a-b; });
  var m = Math.floor(v.length/2);
  var med = v.length % 2 ? v[m] : (v[m-1] + v[m])/2;
  return (paceCache = Math.min(1.8, Math.max(0.6, med)));
}

/* Full geometry is thousands of points per lap and browser storage is small,
   so thin it to a point every 25m and drop the decimals nobody can see. The
   figures are stored alongside, worked out from the full geometry, so
   thinning costs accuracy in the drawing and none in the numbers. */
function thin(pts, minM){
  if (pts.length < 3) return pts.slice();
  var ls = 111320 * Math.cos(pts[0][1] * Math.PI/180);
  var out = [pts[0]], last = pts[0], i;
  for (i=1;i<pts.length-1;i++){
    var dx = (pts[i][0]-last[0])*ls, dy = (pts[i][1]-last[1])*110540;
    if (dx*dx + dy*dy >= minM*minM){ out.push(pts[i]); last = pts[i]; }
  }
  out.push(pts[pts.length-1]);
  return out.map(function(p){ return [+p[0].toFixed(5), +p[1].toFixed(5)]; });
}

function loadLaps(){
  try { return JSON.parse(localStorage.getItem(STORE)) || []; }
  catch(e){ return []; }
}

/* Storage fills up eventually. Drop the oldest lap that isn't a favourite
   and try again, rather than silently losing the save. */
function writeLaps(list){
  for (var attempt=0; attempt<8; attempt++){
    try { localStorage.setItem(STORE, JSON.stringify(list)); return true; }
    catch(e){
      var drop = -1;
      for (var i=0;i<list.length;i++) if (!list[i].fav){ drop = i; break; }
      if (drop < 0) return false;
      list.splice(drop, 1);
    }
  }
  return false;
}

function lapId(r){
  var a = r.pts[0], b = r.pts[Math.floor(r.pts.length/2)];
  return Math.round(r.km*10) + "@" + a[0].toFixed(3) + "," + a[1].toFixed(3)
       + "/" + b[0].toFixed(3) + "," + b[1].toFixed(3);
}

function findLap(id){
  var list = loadLaps();
  for (var i=0;i<list.length;i++) if (list[i].id === id) return list[i];
  return null;
}

/* Naming a lap after the place it passes made two different loops that both
   clip Southam both read as "Southam loop" — impossible to tell apart in the
   saved list, which is the one place they most need telling apart. See
   pickTrackName() below for what replaced it. The place itself is still
   there, just moved to the subtitle (see renderSaved). */
var TRACK_NAMES = ["Silverstone","Brands Hatch","Donington","Goodwood","Oulton Park",
  "Snetterton","Cadwell Park","Thruxton","Knockhill","Croft","Anglesey","Rockingham",
  "Monza","Spa","Nürburgring","Suzuka","Laguna Seca","Imola","Monaco","Le Mans",
  "Zandvoort","Interlagos","Bathurst","Mugello","Hockenheim","Estoril","Paul Ricard",
  "Watkins Glen","Sepang","Fuji","Assen","Jerez"];
var TRACK_FEATURES = ["Hairpin","Chicane","Esses","Sweeper","Switchback",
  "Kink","Bend","Loop","Straight","Curve"];
var TRACK_CHARACTER = ["Flowing","Technical","Quick","Twisty","Tight",
  "Smooth","Fast","Wild"];

/* Three independent word slots, the way what3words gets a huge namespace
   from three short ones — except unlike what3words the meaninglessness
   isn't the point, so these stay inside the app's own driving vocabulary
   (character + track + corner type) rather than arbitrary unrelated words.
   8 x 32 x 10 = 2560 combinations. */
function pickTrackName(){
  var used = {}, name, tries;
  loadLaps().forEach(function(e){ used[e.name] = 1; });
  // Against a saved list of at most a few dozen, a handful of tries is
  // enough that a genuine collision is vanishingly unlikely, and one is
  // harmless if it happens anyway.
  for (tries=0; tries<40; tries++){
    name = TRACK_CHARACTER[Math.floor(Math.random()*TRACK_CHARACTER.length)] + " " +
           TRACK_NAMES[Math.floor(Math.random()*TRACK_NAMES.length)] + " " +
           TRACK_FEATURES[Math.floor(Math.random()*TRACK_FEATURES.length)];
    if (!used[name]) break;
  }
  return name;
}

function saveLap(r, driven){
  var list = loadLaps(), id = lapId(r), i;
  for (i=0;i<list.length;i++){
    if (list[i].id !== id) continue;
    if (driven) list[i].driven = Date.now();
    writeLaps(list); renderSaved(); return list[i];
  }
  describe(r);
  list.push({
    id: id,
    name: pickTrackName(),
    anchor: r.anchor || "",
    km: r.km, mins: r.mins, rawMins: r.rawMins || r.mins, best: r.best, twisty: r.twisty, lap: r.lap, near: r.near,
    via: describe(r), roads: (r.roads || []).slice(0,3),
    viaPlaces: (r.viaPlaces || []).map(function(p){
      return {name:p.name, kind:p.kind, lat:+p.lat.toFixed(4), lon:+p.lon.toFixed(4)};
    }),
    approach: r.approach || 0,
    saved: Date.now(), driven: driven ? Date.now() : null, fav: false,
    pts: thin(r.pts, 25),
    riskPts: (r.riskPts || []).map(function(p){ return [+p[0].toFixed(5), +p[1].toFixed(5)]; })
  });
  if (!writeLaps(list)) say("No room left to save laps. Remove a few first.", true);
  renderSaved();
  return findLap(id);
}

function dropLap(id){
  var list = loadLaps(), out = [];
  for (var i=0;i<list.length;i++) if (list[i].id !== id) out.push(list[i]);
  writeLaps(out); renderSaved(); syncStar();
}

function editLap(id, change){
  var list = loadLaps();
  for (var i=0;i<list.length;i++) if (list[i].id === id) change(list[i]);
  writeLaps(list); renderSaved();
}

function drivenWhen(ts){
  if (!ts) return "not driven yet";
  var days = Math.floor((Date.now() - ts)/86400000);
  if (days <= 0) return "driven today";
  if (days === 1) return "driven yesterday";
  if (days < 14) return "driven " + days + " days ago";
  if (days < 60) return "driven " + Math.round(days/7) + " weeks ago";
  return "driven " + new Date(ts).toLocaleDateString();
}

/* Favourites first, then whatever you drove most recently. */
function sortLaps(list){
  return list.slice().sort(function(a,b){
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    if ((a.driven||0) !== (b.driven||0)) return (b.driven||0) - (a.driven||0);
    return b.saved - a.saved;
  });
}

/* Asking for the actual time. A plain prompt is right here: it's one number,
   typed once, standing still — not something to build a dial for. */
function askActual(e){
  var est = e.rawMins || e.mins;
  var said = prompt("How long did \"" + e.name + "\" take, in minutes?\n\n" +
                    "It estimated " + clock(est) + ". Round to the nearest five.", "");
  if (said === null) return;                       // cancelled, ask again next time
  var mins = parseInt(String(said).replace(/[^0-9]/g, ""), 10);
  if (!mins || mins < 5 || mins > 600){
    say("That didn't look like a number of minutes.", true);
    return;
  }
  editLap(e.id, function(x){ x.actual = mins; });
  addPaceSample(mins / Math.max(est, 1));
  var off = Math.round((paceFactor() - 1) * 100);
  say(off === 0 ? "Spot on. Estimates unchanged."
    : "Noted. Estimates now run " + Math.abs(off) + "% " +
      (off > 0 ? "longer" : "shorter") + " to match you.");
  renderSaved();
}

/* A lap you've driven but never timed is the one thing worth nudging about,
   because it's the only way the estimates ever improve. */
function pendingLap(list){
  for (var i=0;i<list.length;i++){
    var e = list[i];
    if (e.driven && !e.actual && e.actual !== -1 && (e.rawMins || e.mins)) return e;
  }
  return null;
}

function renderSaved(){
  var list = sortLaps(loadLaps());
  var box = document.getElementById("saved-list");
  document.getElementById("saved-count").textContent = list.length ? "(" + list.length + ")" : "";
  box.innerHTML = "";

  if (!list.length){
    document.getElementById("calib-slot").textContent = "";
    var p = document.createElement("p");
    p.id = "saved-empty";
    p.textContent = "Star a lap to keep it. Anything you tap Navigate on is kept automatically.";
    box.appendChild(p);
    return;
  }

  var slot = document.getElementById("calib-slot");
  slot.textContent = "";
  var waiting = pendingLap(list);
  if (waiting){
    var card = document.createElement("div");
    card.className = "calib";
    var q = document.createElement("span");
    q.textContent = "How long did \u201C" + waiting.name + "\u201D actually take?";
    var yes = document.createElement("button");
    yes.textContent = "Tell it";
    yes.addEventListener("click", function(){ askActual(waiting); });
    var no = document.createElement("button");
    no.className = "ghost";
    no.textContent = "Skip";
    no.addEventListener("click", function(){
      editLap(waiting.id, function(x){ x.actual = -1; });
    });
    card.appendChild(q); card.appendChild(yes); card.appendChild(no);
    slot.appendChild(card);   // outside the panes, so it's seen on either tab
  }

  list.forEach(function(e){
    var row = document.createElement("div");
    row.className = "lap";

    var open = document.createElement("button");
    open.className = "lap-open";
    open.innerHTML = '<span class="lap-name"></span><span class="lap-sub"></span>';
    open.querySelector(".lap-name").textContent = e.name;
    open.querySelector(".lap-sub").textContent =
      (e.anchor ? "Near " + e.anchor + " · " : "") +
      (e.best*MI).toFixed(1) + " mi best · " + Math.round(e.twisty*100) + "% cornering · " +
      (e.actual > 0
        ? "took " + clock(e.actual) + ", est " + clock(e.rawMins || e.mins)
        : drivenWhen(e.driven));
    open.addEventListener("click", function(){ openLap(e); });

    var acts = document.createElement("div");
    acts.className = "lap-acts";

    function act(label, title, on, fn){
      var b = document.createElement("button");
      b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
      if (on) b.className = "on";
      b.addEventListener("click", fn);
      acts.appendChild(b);
    }

    act(e.fav ? "★" : "☆", "Favourite", e.fav, function(){
      editLap(e.id, function(x){ x.fav = !x.fav; });
    });
    act("✓", "Mark as driven", false, function(){
      editLap(e.id, function(x){ x.driven = Date.now(); });
    });
    if (e.driven) act("⏱", "How long did it take?", e.actual > 0, function(){
      askActual(e);
    });
    act("✎", "Rename", false, function(){
      var name = prompt("Name this lap", e.name);
      if (name) editLap(e.id, function(x){ x.name = name.slice(0,60); });
    });
    act("×", "Delete", false, function(){ dropLap(e.id); });

    row.appendChild(open); row.appendChild(acts);
    box.appendChild(row);
  });
}

/* A saved lap carries its own figures, so it can be shown without
   re-measuring anything. */
function openLap(e){
  state.results = [{
    pts: e.pts, km: e.km, mins: e.mins, best: e.best, twisty: e.twisty,
    lap: e.lap, near: e.near, approach: e.approach, total: 0,
    via: e.via || "", viaPlaces: e.viaPlaces || [], roads: e.roads || [],
    riskPts: e.riskPts || []
  }];
  show(0);
  say(e.name + " — " + drivenWhen(e.driven) + ".");
}

function syncStar(){
  var btn = document.getElementById("star");
  var r = state.results[state.active];
  var on = !!(r && findLap(lapId(r)));
  btn.disabled = !r;
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.setAttribute("aria-label", on ? "Remove from saved laps" : "Save this lap");
}

/* ---------- exports ---------- */

/* Google Maps is a destination router, not a route follower: it takes a
   handful of waypoints and decides for itself how to join them. Spacing those
   waypoints evenly along the lap — as this used to — pins nothing that
   matters, so between two pins it takes whatever main road it prefers and the
   lap you actually get is not the lap on screen.

   Picking them by shape instead forces its hand. Repeatedly split the route at
   whichever point sits furthest from the straight line joining its neighbours,
   and you end up with the pins that define the loop's corners — the exact
   places Google would otherwise cut. It's Douglas-Peucker, chosen to a fixed
   budget rather than a tolerance. */
function shapePoints(pts, want){
  var n = pts.length;
  if (n <= want) return pts.map(function(_, i){ return i; });

  function dev(a, b){
    // furthest point from the chord a..b, and how far off it sits
    var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    var dx = bx-ax, dy = by-ay, len = Math.sqrt(dx*dx + dy*dy);
    var best = -1, bestD = -1;
    for (var i=a+1;i<b;i++){
      var d;
      if (len < 1e-9){
        d = Math.hypot(pts[i][0]-ax, pts[i][1]-ay);
      } else {
        d = Math.abs((pts[i][0]-ax)*dy - (pts[i][1]-ay)*dx) / len;
      }
      if (d > bestD){ bestD = d; best = i; }
    }
    return {at: best, d: bestD};
  }

  /* A lap ends where it starts, so the chord from first to last is a point
     and the split has to be seeded with the far side of the loop. */
  var far = 0, farD = -1;
  for (var i=1;i<n;i++){
    var d = Math.hypot(pts[i][0]-pts[0][0], pts[i][1]-pts[0][1]);
    if (d > farD){ farD = d; far = i; }
  }

  var keep = [0, far, n-1];
  var segs = [dev(0, far), dev(far, n-1)];
  var bounds = [[0, far], [far, n-1]];

  while (keep.length < want){
    var pick = -1, pickD = 0;
    for (i=0;i<segs.length;i++) if (segs[i] && segs[i].at > 0 && segs[i].d > pickD){
      pickD = segs[i].d; pick = i;
    }
    if (pick < 0) break;

    var at = segs[pick].at, lo = bounds[pick][0], hi = bounds[pick][1];
    keep.push(at);
    segs.splice(pick, 1, dev(lo, at), dev(at, hi));
    bounds.splice(pick, 1, [lo, at], [at, hi]);
  }

  return keep.sort(function(a,b){ return a-b; });
}

/* Google resolves a bare lat/lng to the nearest addressable thing, then routes
   to its door — which is how a waypoint on a lane becomes a detour up someone's
   drive. Junctions have no door, so pins are moved onto them.

   But only onto junctions the lap actually passes through. Snapping to the
   nearest junction anywhere drags the pin off the route onto a neighbouring
   lane, and Google then leaves the loop to go and touch it — an out-and-back
   spur that was never in the lap at all. So the search runs along the route
   itself and asks which of *those* points is a junction. */
function junctionIndex(pts){
  var g = state.graph, on = {};
  if (!g || !g.nodes) return on;

  var ls = g.latScale || 68000, cell = 60, k, n;

  // junctions only, bucketed so the route scan below stays cheap
  var grid = {};
  for (k in g.nodes){
    if ((g.adj[k] || []).length < 3) continue;     // a kink is not a junction
    n = g.nodes[k];
    if (!n) continue;
    var gk = Math.round(n[0]*ls/cell) + ":" + Math.round(n[1]*110540/cell);
    (grid[gk] = grid[gk] || []).push(n);
  }

  for (var i=0;i<pts.length;i++){
    var px = pts[i][0]*ls, py = pts[i][1]*110540;
    var cx = Math.round(px/cell), cy = Math.round(py/cell);
    var best = null, bestD = 14;                   // must be essentially on the road
    for (var dx=-1;dx<=1;dx++) for (var dy=-1;dy<=1;dy++){
      var bucket = grid[(cx+dx) + ":" + (cy+dy)];
      if (!bucket) continue;
      for (var b=0;b<bucket.length;b++){
        var d = Math.sqrt(Math.pow(bucket[b][0]*ls - px, 2) +
                          Math.pow(bucket[b][1]*110540 - py, 2));
        if (d < bestD){ bestD = d; best = bucket[b]; }
      }
    }
    if (best) on[i] = best;
  }
  return on;
}

/* Nudge a chosen pin along the route to the nearest junction it passes. If
   there isn't one within reach, the pin stays where it is — a point on the
   right road beats a junction on the wrong one. */
function snapAlongRoute(pts, idx, onRoute, span){
  if (onRoute[idx]) return onRoute[idx];
  for (var step=1; step<=span; step++){
    if (onRoute[idx-step]) return onRoute[idx-step];
    if (onRoute[idx+step]) return onRoute[idx+step];
  }
  return pts[idx];
}

function navigate(){
  var r = state.results[state.active];
  if (!r) return;

  saveLap(r, true);
  syncStar();

  var lapStart = r.pts[0];
  var at = lapStart[1].toFixed(5) + "," + lapStart[0].toFixed(5);
  var origin = state.start
    ? state.start.lat.toFixed(5) + "," + state.start.lng.toFixed(5)
    : at;

  var away = (r.approach || 0);
  var way = [];
  if (away > 600) way.push(at);            // Google's documented maximum is 9

  /* Junctions the search itself flagged as places a turn-by-turn router would
     plausibly take a different road — these earn a pin before pure shape
     does, because missing one risks Google quietly rerouting rather than
     just drawing the loop a bit rounder. They're already exact junction
     coordinates (see routerWouldDiverge), so unlike shapePoints() picks they
     need no snapping. */
  var ls = 111320 * Math.cos(lapStart[1] * Math.PI/180);
  var placed = (r.riskPts || []).slice(0, Math.max(0, 9 - way.length));
  placed.forEach(function(p){ way.push(p[1].toFixed(6) + "," + p[0].toFixed(6)); });

  if (way.length < 9){
    var idx = shapePoints(r.pts, (9 - way.length) + 2);   // ends are the start/finish pin
    var onRoute = junctionIndex(r.pts);
    var span = Math.max(8, Math.round(r.pts.length / 60));   // how far a pin may slide
    for (var i=0;i<idx.length && way.length < 9; i++){
      if (idx[i] === 0 || idx[i] === r.pts.length-1) continue;
      var p = snapAlongRoute(r.pts, idx[i], onRoute, span);
      if (placed.some(function(q){ return metresBetween(p, q, ls) < 250; })) continue;
      way.push(p[1].toFixed(6) + "," + p[0].toFixed(6));
    }
  }

  window.open("https://www.google.com/maps/dir/?api=1&origin=" + origin +
    "&destination=" + at + "&waypoints=" + encodeURIComponent(way.join("|")) +
    "&travelmode=driving&dir_action=navigate" +
    "&utm_source=backroads&utm_campaign=directions_request", "_blank");
}

/* ---------- the sheet ---------- */

/* Three views in one panel, swapping rather than stacking, so each is one
   tap away without ever hiding what's currently on screen behind another
   verb. Was a two-way toggle (route/options) before Saved got its own tab —
   generalised to a name rather than a boolean so a third view didn't mean a
   second parallel on/off flag drifting out of sync with the first. */
var activePane = "route";   // "route" | "options" | "saved"
var PANES = ["route", "options", "saved"];

function showPane(name){
  activePane = name;
  PANES.forEach(function(p){
    document.getElementById("pane-" + p).hidden = p !== name;
    var tab = document.getElementById("tab-" + p);
    var on = p === name;
    tab.className = on ? "on" : "";
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  var sheet = document.getElementById("sheet");
  PANES.forEach(function(p){ sheet.classList.toggle("on-" + p, p === name); });
  setTimeout(function(){ if (map) map.invalidateSize(); reframe(); }, 30);
}

/* How much of the screen the panel is covering. */
function sheetCover(){
  return document.getElementById("sheet").offsetHeight;
}

/* Show the whole area being read, in the map you can actually see. */
function frameArea(at, radius){
  if (!map || !at) return;
  var ls = 111320 * Math.cos(at.lat * Math.PI/180);
  var dLat = radius/110540, dLng = radius/ls;
  map.fitBounds([[at.lat-dLat, at.lng-dLng], [at.lat+dLat, at.lng+dLng]], {
    paddingTopLeft: [24, 24],
    paddingBottomRight: [24, sheetCover() + 16]
  });
}

function frameRoute(bounds){
  if (!bounds) return;
  state.bounds = bounds;
  map.fitBounds(bounds, {
    paddingTopLeft: [26, 26],
    paddingBottomRight: [26, sheetCover() + 18]
  });
}

/* Whenever the panel changes height, put the route back inside the map that's
   left. Otherwise opening the options hides the thing you're looking at. */
function reframe(){
  if (state.bounds) frameRoute(state.bounds);
}

function wireSheet(){
  document.getElementById("tab-route").addEventListener("click", function(){
    showPane("route");
  });
  document.getElementById("tab-options").addEventListener("click", function(){
    showPane("options");
  });
  document.getElementById("tab-saved").addEventListener("click", function(){
    showPane("saved");
  });

  var settle;
  function relayout(){
    clearTimeout(settle);
    settle = setTimeout(function(){
      if (map){ map.invalidateSize(); reframe(); }
    }, 120);
  }
  if (map){
    var settleLabels;
    map.on("moveend zoomend", function(){
      clearTimeout(settleLabels);
      settleLabels = setTimeout(drawLabels, 80);
    });
  }

  window.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", relayout);
}

/* Pick one value from a row of buttons. */
function wireChips(id, initial, onPick){
  var box = document.getElementById(id);
  box.addEventListener("click", function(e){
    var b = e.target.closest("button");
    if (!b) return;
    Array.prototype.forEach.call(box.querySelectorAll("button"), function(c){
      c.className = c === b ? "on" : "";
    });
    onPick(b.dataset.v);
  });
  return initial;
}

/* ---------- start ---------- */

/* Put a point in the middle of the map you can actually see. The panel covers
   the bottom of the container, so centring on the container's true centre
   drops the point behind it — which is what "it doesn't centre on me" meant.
   Shifting the centre down by half the panel lifts the point into the gap. */
function centreOn(lat, lng, zoom){
  var z = (zoom === undefined) ? map.getZoom() : zoom;
  var pt = map.project([lat, lng], z);
  pt.y += sheetCover() / 2;
  map.setView(map.unproject(pt, z), z);
}

/* ---------- weather ----------

   A nudge, not a search input. Open-Meteo is free and keyless, which matches
   everything else here: no account, no server. "It's clear right now" is as
   real a reason to go for a drive as any mood button — this never touches
   scoring, and asks for nothing if it fails or is slow. */

var WEATHER_WORDS = {
  0:"clear", 1:"mostly clear", 2:"partly cloudy", 3:"cloudy",
  45:"foggy", 48:"foggy",
  51:"light drizzle", 53:"drizzle", 55:"heavy drizzle",
  61:"light rain", 63:"rain", 65:"heavy rain",
  71:"light snow", 73:"snow", 75:"heavy snow",
  80:"showers", 81:"showers", 82:"heavy showers",
  95:"thunderstorms"
};
var WEATHER_GOOD = {0:1, 1:1, 2:1, 3:1};   // no precipitation, just cloud cover

function weatherPhrase(code, tempC){
  var w = WEATHER_WORDS[code] || "mixed conditions";
  return Math.round(tempC) + "°C, " + w + (WEATHER_GOOD[code] ? " — good for a drive" : "");
}

function fetchWeather(lat, lng){
  var el = document.getElementById("weather");
  if (!el) return;
  // Coarse location + an hourly bucket: sw.js caches GETs, so this keeps one
  // fetch an hour per rough area instead of fighting the cache on every call.
  var hour = Math.floor(Date.now() / 3600000);
  var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(2)
    + "&longitude=" + lng.toFixed(2) + "&current=temperature_2m,weather_code"
    + "&timezone=auto&_h=" + hour;
  fetch(url).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
    if (j && j.current) el.textContent = weatherPhrase(j.current.weather_code, j.current.temperature_2m);
  })["catch"](function(){ /* offline, or the service is down — say nothing */ });
}

function setStart(lat, lng, recentre){
  state.start = {lat:lat, lng:lng};
  if (startMarker) startMarker.setLatLng([lat,lng]);
  else startMarker = L.marker([lat,lng], {
    icon: L.divIcon({className:"", html:'<div class="start-dot"></div>', iconSize:[16,16], iconAnchor:[8,8]})
  }).addTo(map);
  if (recentre) centreOn(lat, lng, 12);
  fetchWeather(lat, lng);
}

function init(){
  map = L.map("map", {zoomControl:false, attributionControl:true}).setView([52.4068,-1.5197], 10);
  // The standard OSM tiles are busy and dated next to a drawn route. These are
  // quieter, and there's a dark set for when the phone is in dark mode — which
  // is also what you want in a car at night.
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function tileStyle(){ return dark && dark.matches ? "dark_all" : "rastertiles/voyager"; }
  function tileUrl(){
    return "https://{s}.basemaps.cartocdn.com/" + tileStyle() + "/{z}/{x}/{y}{r}.png"
         + (CARTO_KEY ? "?key=" + CARTO_KEY : "");
  }

  tiles = L.tileLayer(tileUrl(), {
      subdomains: "abcd", maxZoom: 19, detectRetina: true,
      crossOrigin: true,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);

  if (dark && dark.addEventListener){
    dark.addEventListener("change", function(){ tiles.setUrl(tileUrl()); });
  }

  window.addEventListener("load", function(){ map.invalidateSize(); });

  map.on("click", function(e){
    setStart(e.latlng.lat, e.latlng.lng, false);
    say("Start moved. Search again from here.");
  });

  wireChips("mins-chips", 0, function(v){ state.mins = +v; savePrefs(); });
  wireChips("reach-chips", 0, function(v){ state.reach = +v; savePrefs(); });
  wireChips("style-chips", 0, function(v){
    state.style = v; savePrefs();
    if (state.results.length) say("Corner style changed. Search again to pick roads to suit.");
  });

  applyPrefs();

  document.getElementById("go").addEventListener("click", search);
  document.getElementById("nav").addEventListener("click", navigate);
  document.getElementById("moods").addEventListener("click", function(e){
    var b = e.target.closest("button");
    if (b) pickMood(b.dataset.mood);
  });
  document.getElementById("remood").addEventListener("click", function(){
    var on = document.getElementById("sheet").classList.toggle("remood");
    setRemoodLabel(on);
  });

  document.getElementById("star").addEventListener("click", function(){
    var r = state.results[state.active];
    if (!r) return;
    var id = lapId(r);
    if (findLap(id)) dropLap(id); else saveLap(r, false);
    syncStar();
  });

  renderPlan();

  renderSaved();
  wireSheet();
  showPane("route");
  setTimeout(function(){ map.invalidateSize(); }, 80);

  if (navigator.geolocation){
    say("Finding you…");
    navigator.geolocation.getCurrentPosition(function(pos){
      setStart(pos.coords.latitude, pos.coords.longitude, false);
      map.invalidateSize();
      centreOn(pos.coords.latitude, pos.coords.longitude, 12);
      say("");
    }, function(){
      say("Location unavailable. Tap the map to set your start.", true);
    }, {enableHighAccuracy:true, timeout:10000, maximumAge:60000});
  } else {
    say("This browser has no location access. Tap the map to set your start.", true);
  }
}

/* ---------- installed-app behaviour ---------- */

/* Offline: the app still runs — saved laps and cached tiles are local — but
   a new search needs the network, so say so rather than failing cryptically. */
function wireConnection(){
  function show(){
    document.body.classList.toggle("offline", !navigator.onLine);
    if (!navigator.onLine) say("Offline — saved laps still work, new searches don't.", true);
    else if (document.body.dataset.wasOffline === "1") say("");
    document.body.dataset.wasOffline = navigator.onLine ? "0" : "1";
  }
  window.addEventListener("online", show);
  window.addEventListener("offline", show);
  if (!navigator.onLine) show();
}

/* Keep the screen on while a lap is on screen — you're reading it at a
   junction, not typing on it, so the usual idle timer is wrong. */
var wakeLock = null;
function wireWakeLock(){
  if (!("wakeLock" in navigator)) return;
  function acquire(){
    if (wakeLock || document.visibilityState !== "visible" || state.active < 0) return;
    navigator.wakeLock.request("screen").then(function(l){
      wakeLock = l;
      l.addEventListener("release", function(){ wakeLock = null; });
    })["catch"](function(){ /* denied or battery saver — not worth a message */ });
  }
  function release(){
    if (wakeLock){ try { wakeLock.release(); } catch(e){} wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "visible") acquire(); else release();
  });
  window.addEventListener("backroads:route", function(){
    if (state.active >= 0) acquire(); else release();
  });
}

/* Hold the opening screen just long enough to finish drawing, then get out of
   the way. It never blocks: if something below is slow, the deadline wins. */
function wireSplash(){
  var el = document.getElementById("splash");
  if (!el) return;
  var born = Date.now();
  var done = false;

  function dismiss(){
    if (done) return;
    done = true;
    el.classList.add("gone");
    setTimeout(function(){ el.style.display = "none"; }, 380);
  }

  function ready(){
    var held = Date.now() - born;
    setTimeout(dismiss, Math.max(0, 1150 - held));   // let the B finish
  }

  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
  setTimeout(dismiss, 3500);                          // never trap anyone
}

function wireServiceWorker(){
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("./sw.js")["catch"](function(){
      /* Fails on file:// and on plain http — harmless, the app just
         won't work offline. Nothing the driver needs to know about. */
    });
  });
}

init();
wireSplash();
wireConnection();
wireWakeLock();
wireServiceWorker();
