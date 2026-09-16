# Backroads — context for Claude Code

A phone web app that finds closed driving laps worth the fuel. Adam drives a
Hyundai i30N around Warwickshire; the app exists to find him B roads and lanes
he can drive round as a circuit, not routes from A to B.

Deployed as a static site on GitHub Pages. No build step, no server, no
framework. Push to `main` and it's live.

## Files

    index.html          markup and all CSS (~17KB)
    app.js              the entire application (~95KB)
    sw.js               service worker — app shell + map tile cache
    manifest.webmanifest
    app/                home-screen icons
    vendor/             Leaflet 1.9.4 and Barlow, served locally (see below)
    tests/              Node harnesses, no dependencies — ./tests/run-all.sh

## How it works

One network request per area, to Overpass (OpenStreetMap's query service).
Everything else is computed on the phone.

    fetchArea       Overpass query: roads + schools + speed cameras + places
    buildGraph      splits ways at shared coordinates into edges
    pruneSpurs      removes dead ends, iteratively
    mergeChains     splices mid-road nodes OSM created at tag changes
    pickStarts      8 spread junctions within the "drive out" radius
    walkCircuit     random outward walk, 200 attempts
    wayBack         edge-based Dijkstra home
    score           ranks them; top 5 shown

`findCircuits` runs straight through; `findCircuitsLive` runs the same jobs in
20ms slices between frames. They share one job list and return identical
results — verified in tests/sliced-search.js.

## Decisions that aren't obvious from the code

**Time, not distance.** The user asks for a duration. Distance is a poor proxy:
an hour of lanes and an hour of open B road are nowhere near the same miles.

**Duration comes from a speed profile, not an average.** Each point is capped by
the limit, the bend (`sqrt(A_LAT * radius)`), and what the road class can
realistically carry. Then a forward pass for acceleration and a backward pass
for braking — which is why one hairpin costs the approach and exit too. See
`edgeSeconds`. Constants near it: `A_LAT` 3.8, `A_ACC` 1.8, `A_DEC` 2.6.

**These constants are guesses and the app learns them.** After driving, the user
enters the real time and a pace factor corrects every future estimate,
including the target the search chases. Median of the last 10, clamped
0.6–1.8, so one fuel stop doesn't skew it. See `paceFactor`.

**Two doubling-back measures, not one.** `overlap` catches the route landing
within 60m of itself. `closePasses` catches the wider shape — out on one lane,
back on the next one over — at 650m, requiring 1.5km of separation along the
route so hairpins aren't punished. The threshold matters: 500m missed real
cases, 800m flagged good twisty laps. Tests in tests/doubling-back.js.

**Fetch radius derives from the walk's leash**, not from a circle's
circumference. The walk can never get further from its start than `LEASH` of
the lap length, so that plus reach is the whole world it can reach. Sizing it
any other way downloads road the search can never use. It's then rounded up to
a 2.5km bucket so a small change in settings hits the stored area instead of
re-downloading.

**Reusing a road costs 25x** in `wayBack`. At 9x it still retraced whenever the
alternative was much longer, producing out-and-back spurs.

**Navigate pins junctions Google might reroute at, not just corners.** Real
driving showed Google Maps' multi-stop nav requires tapping "Continue" at
every waypoint, and there's no URL-scheme parameter to make one a silent
via-point — so waypoint count is a hard cost, not just a shape-fidelity knob.
`routerWouldDiverge` flags junctions along the route where a bigger-or-
straighter alternative exists besides the one arrived on and the one taken —
places a real router would plausibly pick differently — computed once in
`circuitToPath` while the graph is still in hand, stored as `riskPts`
(coordinates, not indices, so they survive save-lap thinning). `navigate()`
spends waypoints on those first and fills any left with `shapePoints`'
geometric picks. Still no way to reduce the *tap count* itself — the fix is
spending the same ~9 pins on the junctions that matter instead of on pure
shape.

## Things that bit us — don't undo these

**Waypoints must sit on junctions the lap actually passes.** Google resolves a
bare lat/lng to the nearest *address* and routes to its door, so a pin on a
lane became a detour up someone's drive. Snapping to the nearest junction
anywhere was worse — it dragged pins off-route and Google left the loop to
touch them. `junctionIndex` + `snapAlongRoute` only ever move a pin to a
junction already on the route.

**Google Maps cannot follow a route.** It takes 9 waypoints (3 from a mobile
browser, i.e. no app installed) and joins them however it likes. Apple Maps
takes none at all; Waze errors on more than one. Don't promise fidelity here.

**Geometry is resampled to even 12m spacing before any curvature maths.** OSM
digitises unevenly; without this you measure the surveyor, not the road.

**Segments under 20m must not be discarded.** An early version did, and it
shattered a 1503-junction network into fragments of 3.

**`rank[kind] || 9` is a trap.** Ranks start at 1 because 0 is falsy, and towns
ranked 0 were silently scored as the least significant place.

**Don't reach for `getElement()` on Leaflet layers.** Use `setStyle`. An earlier
version set label text after adding the marker and failed silently.

**Vendored, not CDN.** Windows Defender flagged the file as
`Trojan:Win32/MalUri.A!cl` — a downloaded HTML page pulling remote scripts is
the shape of a dropper. Leaflet and the fonts are served locally. Don't put
them back on a CDN.

## Known gaps

- Turn restrictions are ignored; a lap can require a banned turn. Rare on the
  road classes we favour, expensive to fix properly.
- Average-speed cameras are tagged as relations in OSM and aren't fetched.
- Approach distance to a lap start is straight-line, not road distance.
- The pace factor is a single global multiplier. If the user is quick on open
  roads but slow in lanes, it settles between and is wrong both ways.

## Deploying

Push to `main`. If `sw.js` changes, bump `VERSION` inside it or phones keep
serving the cached shell. Same applies when a file changes without its name
changing — that's why the icons needed a version bump once.

## Working style Adam has asked for

- Don't keep updating README.md.
- Measure before changing weights. Several rounds were spent tuning the scorer
  for artefacts that turned out to be Google's routing, not ours.
- Ask for the actual error text or number rather than inferring from a
  screenshot. The antivirus detection name settled in one line what four
  guesses hadn't.
