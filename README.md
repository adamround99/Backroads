# Backroads — setup

Getting this onto your phone takes about ten minutes and costs nothing.

## 1. Put the app on the internet

The app needs to be served over HTTPS — phone browsers refuse to hand out GPS
location to anything less, and service workers only run on HTTPS. GitHub Pages
does this free.

Upload **all of these, keeping the folder structure**:

    index.html
    sw.js
    manifest.webmanifest
    app/icon-180.png
    app/icon-192.png
    app/icon-512.png
    app/icon-maskable-512.png

`sw.js` must sit next to `index.html`, not in a subfolder — a service worker
can only control files at or below its own level.

1. Make a [GitHub](https://github.com) account if you don't have one.
2. Click **New repository**. Name it `backroads`. Set it to **Public**. Tick
   **Add a README file**. Click **Create repository**.
3. On the repository page, click **Add file** → **Upload files**, drag the
   whole set in, and click **Commit changes**.
4. Go to **Settings** → **Pages** (left sidebar). Under "Branch", pick `main`
   and `/ (root)`, then **Save**.
5. Wait about a minute, then refresh that page. It'll show your address —
   something like `https://yourname.github.io/backroads/`.

### Updating it later

The page is fetched fresh whenever you're online, so a re-upload lands on the
next open. If you change `sw.js` itself, bump the `VERSION` string at the top —
that's what tells phones to throw away the old cached copy.

## 2. Open it on your phone

Visit that address in Safari or Chrome. It'll ask for your location — allow it.

To make it behave like a real app: in Safari tap the share button and **Add to
Home Screen**; in Chrome it's the three-dot menu and **Add to Home screen**.
You'll get the Backroads icon, and it opens full screen with no browser chrome.

Do this rather than using a bookmark. Safari wipes local storage for sites you
haven't added to the home screen after seven days of not visiting — which would
take your saved laps with it.

Once installed it opens with no connection at all. Saved laps and any map tiles
you've already looked at are held on the phone. Finding a *new* lap still needs
signal, since that's a fresh query to OpenStreetMap; when you're offline the
Find a drive button dims and says so.

While a lap is on screen the phone won't dim, so you can glance at it at a
junction without prodding the screen.

## Using it

It reads the road network around you, breaks it into segments at every
junction, scores each segment for corners and for whether it's worth driving,
then searches for a lap: connected road all the way round and back to where
you started.

Nothing is sent to a routing service. Routing services optimise for arriving,
which is the opposite of the point, and their free tiers came with limits that
shaped the app badly. Everything is worked out on the phone from OpenStreetMap
data, so there's no account and no daily quota.

The one key involved is for the map background. CARTO began requiring one in
August 2026 — without it the tiles come back stamped "API KEY REQUIRED". It's
free up to five million tiles a month, which is far beyond anything you'll use.
It sits in `index.html` near the top as `CARTO_KEY` and is visible to anyone who
views the page source; that's unavoidable in a static page, so restrict it to
your own domain at `carto.com/basemaps/apikey` rather than treating it as a
secret.

Road data comes from Overpass, which is free, keyless and shared. Busy servers
are common on weekend mornings, so the app tries three mirrors twice before
giving up, and tells you which problem it hit.

Four things make that work on real roads rather than in theory:

- **Dead ends are stripped out first.** A spur can never be part of a lap —
  you'd have to come back out the way you went in. They're removed repeatedly,
  since removing one spur often exposes another behind it.
- **Roads split across several map entries are rejoined.** OpenStreetMap breaks
  one road into several ways wherever a tag changes, which leaves nodes sitting
  mid-road where nothing actually meets. Those get spliced back together, and
  laps are started at junctions where three or more roads meet.
- **It won't start you on an island.** Lanes cut off from everything else by a
  main road form their own network. The app finds the separate networks and
  starts you on a usable one.
- **Forks follow the road.** At a Y, one branch is the road carrying on and the
  other is a turning off it. Nothing in the map says which, so it's inferred
  from how far you'd have to steer and whether the road keeps its name. Both
  the outward leg and the way home pay for sharp turns, so a lap follows roads
  through junctions instead of hopping between them.
- **The way home is calculated, not stumbled upon.** The outward leg is random,
  which is what makes every attempt different. The homeward leg is a shortest
  path, weighted to prefer good road, to charge nine times over for road
  already driven, and to charge for sharp turns.

That last point is the compromise: a lap may repeat a short connector where
there's no reasonable alternative. The **doubling back** figure tells you how
much, usually a few percent.

### What makes a road score well

Corners are only half of it. Every segment also gets a quality figure, and the
two multiply — so a bendy road through a 20mph estate loses to a bendy B road
by a wide margin.

| | Weight |
|---|---|
| B road (`secondary`) | 1.25 |
| C road / better lanes (`tertiary`) | 1.15 |
| Country lane (`unclassified`) | 1.00 |
| A road (`primary`) | 0.55 |
| Residential | 0.18 |
| Service road, track | 0.04 |

That's then multiplied by the speed limit: 50mph and above scores 1.15, 40mph
0.80, 30mph 0.32, 20mph 0.10. Speed bumps cost a further 65% and roundabouts
50%.

Schools and speed cameras are pulled from the map in the same query and cost a
road up to 80% and 45% respectively — scaled by how much of the road actually
runs past them, so a lane that clips the corner of a school zone isn't treated
like one running the length of the playground.

The camera weighting is deliberately moderate. It exists because a camera
reliably marks a road that's busy, built up or has a crash history, which is
not a road worth lapping. It is **not** a camera-avoidance feature, and
nothing here should be read as a reason to treat an uncameraed road as
unlimited — the limit applies either way.

A roads are fetched rather than excluded. Most are dull, but a few are
excellent, and they link lane networks that would otherwise be separate
islands — which was one reason laps failed to close. They're weighted down so
they only get used where they earn it or where there's no alternative.

Three honest limits. Minor roads in Britain are often missing a `maxspeed` tag
altogether, in which case the app falls back on whether the road is lit as a
rough proxy for being built up. School and camera proximity are squares drawn
around whatever OpenStreetMap has tagged — not real zones, and useless where
the school or camera isn't mapped. And average-speed camera stretches are
tagged as relations rather than points, so they're missed entirely.

### The lap doesn't have to start at your door

**Drive out to the start** sets how far the app may look for somewhere better
to begin. The good lanes are usually a few junctions out of town, and requiring
a lap to start exactly where you're standing throws most of them away.

With it set above zero, the app picks eight candidate starting junctions spread
across the area — favouring ones that touch good road — and searches from all
of them, then tells you how far the winning lap begins from you. A shorter
drive out breaks ties, so it won't send you 20 miles for a marginally better
lap. Set it to zero to insist the lap starts where you are.

**Navigate** then sends you out to the lap start first and round from there,
finishing where the lap began, ready to go again.

Anything from 10 to 100 miles works; longer laps close less often, because they
need a lot of joined-up lane to exist at all.

### What makes a road score well

Corners are only half of it. Every segment also gets a quality figure, and the
two multiply — so a bendy road through a 20mph estate loses to a bendy B road
by a wide margin.

| | Weight |
|---|---|
| B road (`secondary`) | 1.25 |
| C road / better lanes (`tertiary`) | 1.15 |
| Country lane (`unclassified`) | 1.00 |
| A road (`primary`) | 0.55 |
| Residential | 0.18 |
| Service road, track | 0.04 |

That's then multiplied by the speed limit: 50mph and above scores 1.15, 40mph
0.80, 30mph 0.32, 20mph 0.10. Speed bumps cost a further 65% and roundabouts
50%.

Schools and speed cameras are pulled from the map in the same query and cost a
road up to 80% and 45% respectively — scaled by how much of the road actually
runs past them, so a lane that clips the corner of a school zone isn't treated
like one running the length of the playground.

The camera weighting is deliberately moderate. It exists because a camera
reliably marks a road that's busy, built up or has a crash history, which is
not a road worth lapping. It is **not** a camera-avoidance feature, and
nothing here should be read as a reason to treat an uncameraed road as
unlimited — the limit applies either way.

A roads are fetched rather than excluded. Most are dull, but a few are
excellent, and they link lane networks that would otherwise be separate
islands — which was one reason laps failed to close. They're weighted down so
they only get used where they earn it or where there's no alternative.

Three honest limits. Minor roads in Britain are often missing a `maxspeed` tag
altogether, in which case the app falls back on whether the road is lit as a
rough proxy for being built up. School and camera proximity are squares drawn
around whatever OpenStreetMap has tagged — not real zones, and useless where
the school or camera isn't mapped. And average-speed camera stretches are
tagged as relations rather than points, so they're missed entirely.

### The lap doesn't have to start at your door

**Drive out to the start** sets how far the app may look for somewhere better
to begin. The good lanes are usually a few junctions out of town, and requiring
a lap to start exactly where you're standing throws most of them away.

With it set above zero, the app picks eight candidate starting junctions spread
across the area — favouring ones that touch good road — and searches from all
of them, then tells you how far the winning lap begins from you. A shorter
drive out breaks ties, so it won't send you 20 miles for a marginally better
lap. Set it to zero to insist the lap starts where you are.

**Navigate** then sends you out to the lap start first and round from there,
finishing where the lap began, ready to go again.

Anything from 10 to 100 miles works; longer laps close less often, because they
need a lot of joined-up lane to exist at all.

### Look and feel

The app follows your phone's light or dark setting, including the map itself —
a dark basemap at night is easier on the eyes and better in a car. The basemap
is CARTO's, which is quieter than the standard OpenStreetMap tiles and lets the
drawn lap stand out; both OpenStreetMap and CARTO are credited in the corner,
as their licences require.

Colours are defined once as tokens at the top of the stylesheet, so changing
the palette means editing about a dozen lines rather than hunting through the
file. `--route` is the drawn lap, `--accent` marks where a lap begins and which
laps are favourites, and `--ink`, `--surface`, `--raised` and `--line` carry the
rest.

### The panel

**Options** at the top swaps the panel between the route and the settings. They
replace each other rather than stack, so the settings are always one tap away
even with a route on screen, and neither view is tall enough to need scrolling.
Search from either view; it returns to the route when results arrive.

Settings are tappable values rather than sliders — lap length 10 to 50 miles,
drive out to the start 0 to 20, and the corner style. Dragging a slider
accurately on a phone is harder than it looks, and these are a single tap.

The panel takes a little over a third of the screen, and the route is re-fitted
into whatever map is left whenever the view changes, so the whole route stays
visible in both.

### Reading the results

The three numbers under the distance are the ones that decide whether a route
is worth driving:

- **miles best stretch** — the longest run of continuous cornering, ignoring
  short straights between bends. A 60 mile loop with a 2 mile best stretch is
  mostly transit; one with a 9 mile best stretch is a drive.
- **of it cornering** — how much of the whole route is actually bends rather
  than getting between them.
- **doubling back** — how much of it retraces ground already covered. Circuits
  should read 0%.

**Tap the map** to move the start somewhere else.

**Navigate** hands off to Google Maps, which only accepts 8 waypoints, so it
fills in the gaps its own way and may straighten parts of your route out. It
gets you round roughly the right shape, not exactly it.

### Saved laps

The star beside Navigate keeps a lap. Anything you tap **Navigate** on is kept
automatically and marked as driven, on the reasoning that tapping Navigate is
what you do just before driving something.

Open **Saved laps**, at the bottom of the options view, for the list — favourites first, then whatever
you drove most recently. Each row has:

- **☆** favourite, which pins it to the top and protects it from being culled
- **✓** mark as driven, for when you drove it without going through Navigate
- **✎** rename
- **×** delete

Tap the name to put it back on the map.

A word on how "driven" is worked out, because it's a guess rather than a
measurement. A web app can't watch your GPS in the background — the phone
suspends it the moment you switch away — so nothing here knows whether you
actually drove anything. It infers it from tapping Navigate, which is right
most of the time, and the ✓ button is there to correct it when it isn't.

The list scrolls within its own box, so a long one never pushes the buttons
around.

Laps are stored on the phone. Geometry is thinned to a point every 25m before
saving, which takes a 30-mile lap from about 170KB to 20KB, so a few dozen fit
comfortably. The figures are calculated from the full geometry before thinning,
so they stay exact. If storage does fill up, the oldest non-favourite is dropped
to make room — favourites are never culled.

One caveat outside my control: Safari clears storage for ordinary websites after
seven days of not visiting. Sites added to the home screen are exempt, so add
Backroads to your home screen if you want saved laps to persist.

### One warning about circuits

Circuit mode respects one-way streets but does **not** know about turn
restrictions — no-right-turns, banned manoeuvres at junctions. On quiet lanes
that rarely matters, but check the route rather than following it blindly, and
don't take a lap through anywhere built-up on trust.

### If a circuit search fails

The message now reports what it actually found, e.g. *"No lap closed here. 412
segments, 9 separate networks, biggest has 38 junctions."* That tells you which
problem you have:

- **Few segments** — the area is thin on minor roads, or the Overpass query
  returned little. Move the start or lengthen the lap.

These counts only appear when a search fails; a successful one just shows the
laps.
- **Many separate networks, small biggest** — the lanes around you don't join
  up into anything loop-shaped, usually because main roads cut them apart.
  Starting somewhere more rural fixes this.
- **Lots of runs hitting dead ends** — genuinely spur-heavy country.

If laps close but none match your length, it shows the closest ones anyway and
says so, rather than reporting failure.

### If a search fails

The message appears at the bottom of the sheet.

- *Busy* — OpenStreetMap's query service is shared and free, and it throttles
  when it's under load. Wait a minute.
- *Too sparse* — you've asked for a loop longer than the road network out there
  can fill. Shorten it.

## Tuning it

Everything worth fiddling with is near the top of the `<script>` section:

- `WEIGHTS` — how much a corner of a given radius counts for, under each style.
  The numbers are corner radius in metres, then how much it's worth. If routes
  feel too gentle, raise the weight on the tight buckets.
- `GOOD` and `DULL` — which road types the scoring likes and dislikes.
- The Overpass query inside `fetchRoads` — which road types get considered at
  all. It currently looks at secondary, tertiary and unclassified roads and
  skips anything tagged private or unsurfaced.
- The `total:` line inside `score()` — how the separate measures combine into
  one number. This is the single most useful thing to adjust once you've
  actually driven a few of the routes it suggests.

Change something, re-upload `index.html` to GitHub, wait a minute, reload.
