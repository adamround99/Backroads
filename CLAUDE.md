# Backroads — context for Claude Code

A phone web app that finds closed driving laps worth the fuel. Adam drives a
Hyundai i30N around Warwickshire; the app exists to find him B roads and lanes
he can drive round as a circuit, not routes from A to B.

Deployed as a static site on GitHub Pages. No build step, no server, no
framework. Push to `main` and it's live.

## Purpose, reframed (2026-09-16)

Started as "find the best closed loop for a time budget." Real driving and
repeat use exposed the actual job: **never run out of a good reason to go for
a drive.** That changes what "best" means — not the best lap in isolation, but
the best lap you haven't already had — and it means saved-lap/driven history
should stop being a bookmarks list and become the thing the search reasons
over, so it doesn't keep resurfacing the same greatest hits once the good
local roads have been found.

The loop itself is an implementation choice (no second car, no plan needed to
get home), not the identity of the app. A there-and-back or an open route is
fine wherever it serves "go for a drive" better than a forced closed circuit
does — that's no longer a bigger call than any other search-behaviour tweak.

**Built (2026-09-17): mood buttons replaced the landing "Find me a drive"
button.** `Quick drive` / `Scenic drive` / `Fresh drive` / `Long drive` in
`MOODS` each set duration + reach + `state.freshness` in one tap and search
immediately — see `pickMood`. (Originally named for the vibe — "Quick hit",
"Clear my head", "Somewhere new", "The good stuff" — renamed the same day to
say plainly what each does; `clear` and `best` were also folded into one
`long`, since they'd differed only in reach.)

Corner style deliberately isn't part of most moods — it's a standing taste,
not something the reason for the drive should overrule — **except `scenic`**,
which sets `style:"flowing"` in its `MOODS` entry because asking for scenic
roads *is* asking for flowing over technical. `pickMood` resolves style fresh
from the saved preference on every tap, then lets a mood override it just for
that search: `savePrefs()` runs *before* the override is applied, so a scenic
drive never quietly becomes the new everyday taste, and tapping any other
mood afterward can't inherit scenic's leftover override either.

Each mood button carries a one-line subtitle (`<i>` under `<b>`, same pattern
as the stat tiles) naming what it actually sets — plain duration/reach/
freshness/style in words, not just a vibe. It's hardcoded text in index.html,
not generated from `MOODS`, so **if the preset values in `MOODS` change, the
subtitle text needs updating by hand to match** — same duplication the
mins/reach chips already accept.

`state.freshness` drives `drivenCells` — a "somewhere new" grid built from
points in laps `driven` in the last `FRESH_DAYS` (60), gridded the same way
`hazardCells` marks schools and cameras. `makeSearch` builds it once per
search (only when asked for) and `step()` charges `hazardShare(fresh, r.pts)
* FRESH_WEIGHT` against `total`, same shape as the doubling-back terms. It's a
flat cutoff, not a fade — the simple version, on purpose, until it's actually
been driven with. `FRESH_WEIGHT` (18) is a first guess, not a measurement,
same caveat as the pace constants.

Options' mins/reach/style chips still exist and still work — a mood just
presets them and searches; tweaking a chip afterward and hitting `#go` (now
inside Options only) re-searches with whatever's currently set, freshness
included, until a different mood is tapped.

**Saved laps are named character + track + corner type, not the place they
pass (2026-09-18 — README still says "Southam loop", now stale).** Two
different loops that both clip the same town used to both read as "Southam
loop" in the saved list — impossible to tell apart in the one place they most
needed telling apart. `pickTrackName()` combines three independent word
lists — `TRACK_CHARACTER` ("Flowing", "Technical"...), `TRACK_NAMES` (real
circuits — Silverstone, Spa, Nürburgring...), `TRACK_FEATURES` ("Hairpin",
"Chicane"...) — for 2560 combinations, the what3words idea (a few short word
lists multiplied together beats one long one) minus what3words' actual
choice of meaningless words: these stay in the app's own driving vocabulary
on purpose, since evocative is upside here rather than a risk. Skips any
combination currently in use by another saved lap; falls back to a repeat
only if 40 tries all collide, which at this namespace against a saved list of
a few dozen won't happen in practice.

The place isn't gone, just moved: `saveLap` stores `anchor` (the biggest
place the lap passes, from `describe(r)`/`anchorPlace`) separately from
`name`, and `renderSaved` prepends "Near Southam ·" to the row's subtitle.
Renaming (already existed, the ✎ button) still works exactly as before — the
generated name is just a better starting point than the old scheme, not a
rule.

Once a lap exists, "Change mood" (`#remood`) sits beside Navigate/Star and
stays there — tapping it swaps the mood grid back in (with a "Back to this
lap" button to cancel out, nothing lost) rather than losing the lap on the
way back to Options. The result tabs that used to let you compare 5
candidates are gone — `present()` now keeps only the top-scoring lap (see
2026-09-17 commits); `whyPicked()`/`renderWhy()` names the trait(s) that
actually drove the score plus how many attempts it beat, since dropping the
comparison meant losing the "why this one" signal too.

**Recent-searches history (2026-09-18), not to be confused with the removed
result tabs above.** Those compared *candidates from one search*; this is
*results across separate searches* — re-searching (a new mood, a chip tweak)
used to throw the previous winner away entirely, including one you liked but
hadn't starred yet. `pushHistory()` keeps the last `HISTORY_MAX` (5) in
`state.history`, deduped by `lapId()` so re-landing the same lap doesn't
repeat it; `#history`/`.hist` render the same pill-row style the old result
tabs used. Deliberately session-only, not persisted to `localStorage` —
favouriting stays the one durable way to keep a lap, this is just a shorter
path back to one you haven't decided about yet.

**Saved laps got their own tab (2026-09-18).** Used to be a `<details>`
disclosure collapsed at the bottom of Options — easy to forget it existed,
which was the actual complaint. The two-way `showOptions(bool)` toggle is
gone; `showPane("route"|"options"|"saved")` and `activePane` generalise it,
looping over a `PANES` array rather than hand-listing three states, so a
fourth pane later is one array entry, not a rewritten function. The CSS
mirrors this: rules that used to say "hide on options" now mostly say "show
only on route" or "hide unless route" (e.g. `#sheet:not(.on-route) #nav`),
so they cover saved for free instead of needing a third clause bolted on.
`#saved-list` and `#saved-count` kept their ids and just moved house —
`renderSaved()` didn't need to change at all.

`#calib-slot` (the "how long did X actually take" nudge) moved inside the
Saved pane the same day, found on a real drive — it used to sit outside all
three panes so it'd show "on either tab", which before the Saved tab existed
meant "on Route or Options". It asks about `pendingLap()` — whichever saved
lap is driven-but-untimed, picked independently of whatever's currently on
screen — so floating it below a *different* lap's stats read as if it were
asking about that one. It only ever made sense grouped with the list it's
actually about.

**A lap's name is a title now (2026-09-18), not a line in `say()`.** It used
to only ever surface inside the transient status message — small, muted,
overwritten by the next thing that needed to say anything. `#lapname`
(`.lap-title`, an `<h2>` above the distance/duration numbers) shows it
properly, via `renderLapName(r)`. A fresh, unsaved result has no name yet
(naming only ever happened at save time, see `pickTrackName`) — the element
stays empty and collapses (`.lap-title:empty{display:none}`) rather than
showing something misleading. Saving or un-favouriting the *currently
displayed* lap sets `r.name` directly (`navigate()`, the star handler) and
re-renders immediately, rather than waiting for the next `show()` call to
notice.

**The splash dot traces the line now (2026-09-18), it used to just fade in.**
`#splash-dot` used a fixed-position pop-in animation timed to start after the
line was mostly drawn — visually disconnected from it. It now rides the
identical `d=` path via `offset-path`, with the *exact* duration and easing
`#splash-b`'s stroke-reveal uses, so the dot stays at the tip of the drawing
line the whole way round rather than a marker appearing afterward. One SVG
gotcha: a `<circle>`'s own `cx`/`cy` compose with `offset-path`'s translation
rather than being replaced by it, so they're pinned to `0 0` — any other
value drifts the dot away from the line as it travels. Reduced-motion now
disables it the same way as the other two elements (`animation:none`, held
at the final `offset-distance:100%`) rather than needing a separate
mechanism, which is the reason `offset-path` was chosen over SMIL
`<animateMotion>` — the latter isn't `animation` and that media query
couldn't have touched it.

Draw/trace duration is 1.5s, not the .95s it launched with the same day —
felt rushed once the dot actually had somewhere to travel to, rather than
just popping in. `#splash-b` and `#splash-dot` must stay the same duration as
each other or the dot drifts off the tip of the line; the text fade (`.7s`
starting at `.95s`) and `wireSplash`'s hold (1700ms, in app.js) were both
scaled up to match rather than left at their old values, which would have
cut the animation off before it finished or shown the text too early
relative to the now-slower line.

**Weather (2026-09-17) is a nudge, not a search input.** `fetchWeather` calls
Open-Meteo (free, keyless — matches the no-account/no-server approach
everywhere else) whenever `setStart` runs, and shows a plain "9°C, clear —
good for a drive" line on the landing screen only. It never touches scoring.
The URL is bucketed by hour (`_h=`) purely so `sw.js`'s cache-first handling
of GET requests refreshes it hourly instead of serving one stale reading
forever from the same rough spot.

**Brand colour (2026-09-17): `--route` is Hyundai N Performance Blue,
`#80A3C5`.** Sourced from a paint retailer's colour-matched swatch (verified
identical across several Performance Blue product listings), not a guess —
Hyundai doesn't publish a digital hex for this specific car paint, and their
published corporate blue (`#00287A`, Pantone 288C) is a different, unrelated
navy used for the logo. The real paint is lighter and more desaturated than
photos suggest, which is why it's paired with a fixed dark `--on-route`
(`#0E1417`, same value in both themes) rather than white — white text on it
fails contrast. One colour in both light and dark mode now, not a light/dark
pair like before; it's light enough already to hold up on a dark map, unlike
the old indigo it replaced. Applies to the route line, the mood grid, `#go`,
the splash screen mark (inherits `--route` for free), and the timing-prompt
button. `--accent` (start marker, favourites, orange) is unchanged — it needs
to contrast against the route colour, not match it.

**Place-label collisions (found on a real drive, pre-dates today's changes):**
`drawLabels()`'s clash check compared label *dots* against a flat 96px
threshold, blind to how wide the rendered pill actually is — "Harborough
Magna" is nearly twice the box width of "Brinklow", so two dots that passed
as "far enough apart" still overlapped once drawn. `labelWidth()` now
estimates each pill's width from its name length and sizes the check
per-pair instead of using one constant. Still an estimate, not a DOM
measurement — good enough given the nudge-and-drop fallback already there.

**Place-label distance from the route (also found on a real drive):** a place
pinned on the map could be nowhere near the drawn line — `PLACE_REACH` (up to
1500m for a town) decides what's fair to call "through Southam" in a
sentence, and that's deliberately generous, but reused as-is for the map pin
it just looked like a dot floating off the route. `nearRoute()` adds a flat
350m check against the actual route geometry (not the coarse sample points
`placesAlong` walks) that only gates which places get a pin — the sentence
still uses the original generous `PLACE_REACH`, since a place can fairly be
"gone through" in words without earning a pin that has to look attached to
the line.

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
    score           ranks them; only the best is shown (2026-09-17: was top 5,
                    tabs to switch between candidates removed)

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

**Approach distance is by road, not as the crow flies (2026-09-17).**
`roadDistances` runs one Dijkstra from the user's nearest node (plain metres,
respecting `oneway` — this is "how far is the drive out", not a lap, so none
of `wayBack`'s fun/quality cost applies) and `pickStarts` reads every
candidate's distance off that single tree instead of `metresBetween`. One
Dijkstra for all candidates, not one shortest path each. Falls back to the
straight line only where road distance can't be had — a disconnected node, or
no node in the graph at all. `nearestNode` existed unused before this; this
is what it was for.

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
