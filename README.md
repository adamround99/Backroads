# Backroad — setup

Getting this onto your phone takes about ten minutes and costs nothing.

## 1. Get a routing key

Go to [graphhopper.com](https://www.graphhopper.com/), create a free account,
and open the dashboard. There'll be an API key on it — a long string of letters
and numbers. Copy it somewhere you can get at from your phone (email it to
yourself, whatever's easiest).

### What the free plan actually allows

Worth knowing, because two of its limits shape how this app is built:

| | Free plan |
|---|---|
| Credits per day | 500 |
| Stops per routing request | 5 |
| Flexible mode | not allowed |
| Cost of a routing request | 1 credit (2–10 stops) |

**Flexible mode being off** rules out GraphHopper's own round-trip feature and
its custom road weighting. The app uses neither. It works out the loop itself
from OpenStreetMap data and asks GraphHopper only for ordinary point-to-point
directions.

**Five stops per request** means a loop with more stops than that gets routed in
legs and stitched back together. Most candidates cost two credits, so a search
at the default six candidates costs about twelve — roughly 40 searches a day.

There's also an unpublished per-minute limit. The app leaves a gap between
requests to stay under it, and tells you if you hit it anyway. The credits you
have left appear in the status line after each search.

## 2. Put the app on the internet

The app is one file, `index.html`. It needs to be served over HTTPS, because
phone browsers refuse to hand out GPS location to anything less. GitHub Pages
does this free:

1. Make a [GitHub](https://github.com) account if you don't have one.
2. Click **New repository**. Name it `backroad`. Set it to **Public**. Tick
   **Add a README file**. Click **Create repository**.
3. On the repository page, click **Add file** → **Upload files**, drag
   `index.html` in, and click **Commit changes**.
4. Go to **Settings** → **Pages** (left sidebar). Under "Branch", pick `main`
   and `/ (root)`, then **Save**.
5. Wait about a minute, then refresh that page. It'll show your address —
   something like `https://yourname.github.io/backroad/`.

## 3. Open it on your phone

Visit that address in Safari or Chrome. It'll ask for your location — allow it.

Open **Setup** at the bottom of the screen, paste your GraphHopper key in, and
it'll be remembered on that phone from then on.

To make it behave like a real app: in Safari tap the share button and **Add to
Home Screen**; in Chrome it's the three-dot menu and **Add to Home screen**.
You'll get an icon, and it opens full screen with no browser chrome.

## Using it

Set the loop length, pick a corner style, and tap **Find a drive**.

The first search in a new area takes a few seconds longer than the rest. The app
is asking OpenStreetMap for every minor road in a ring around you and measuring
each one for corners. It keeps those measurements while you stay put, so
searching again is quick. Move the start and it fetches fresh ones.

It then picks the twistiest road in each direction of the compass and asks
GraphHopper to link them into a loop, tries several different combinations, and
keeps the best few. Tap between them along the strip above the buttons.

The bar chart under the distance is the corner profile — it shows where the good
bits fall across the drive, start to finish. Red means tight, black means
moderate, grey means straight. A loop that's all grey in the middle is telling
you it's got a boring section you might want to avoid.

**Tap the map** to move the start somewhere else — useful for planning a drive
from somewhere you're not yet.

**GPX** downloads the route for anything that reads GPX.

**Navigate** hands off to Google Maps. Be aware it only accepts 8 waypoints, so
Google will fill in the gaps its own way and may straighten out some of your
route. It gets you round roughly the right loop, not exactly it. Proper
turn-by-turn is a much bigger job and worth doing only if you decide you like
the rest of this.

### If a search fails

The message appears at the bottom of the sheet.

- *Busy* — OpenStreetMap's query service is shared and free, and it throttles
  when it's under load. Wait a minute.
- *Too sparse* — you've asked for a loop longer than the road network out there
  can fill. Shorten it.
- *Credit limit reached* — either you've used the day's 500, or you've searched
  too fast for the per-minute cap. Wait a minute and see which it was.

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
