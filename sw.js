/* Backroads service worker.

   Three jobs:
     1. Open instantly and work with no signal (app shell).
     2. Keep map tiles you've already seen, so a lap you saved is still
        readable in a valley with no bars.
     3. Never get in the way of a fresh road-network query.

   Bump VERSION to force everyone onto new code. */

var VERSION = "backroads-v17";   // bumped: three-word lap names (character + track + corner)
var SHELL   = VERSION + "-shell";
var TILES   = VERSION + "-tiles";
var TILE_CAP = 1200;                 // roughly 60-80 MB of retina PNGs

var SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./app/icon-180.png",
  "./app/icon-192.png",
  "./app/icon-512.png",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/fonts.css",
  "./vendor/fonts/barlow-latin-400-normal.woff2",
  "./vendor/fonts/barlow-latin-500-normal.woff2",
  "./vendor/fonts/barlow-latin-600-normal.woff2",
  "./vendor/fonts/barlow-condensed-latin-500-normal.woff2",
  "./vendor/fonts/barlow-condensed-latin-600-normal.woff2",
  "./vendor/fonts/barlow-condensed-latin-700-normal.woff2"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(SHELL).then(function(c){
      // addAll is all-or-nothing; one slow CDN shouldn't fail the install.
      return Promise.all(SHELL_FILES.map(function(u){
        return c.add(new Request(u, {cache: "reload"}))["catch"](function(){});
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if (k.indexOf(VERSION) !== 0) return caches["delete"](k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Keep the tile cache from growing without limit. Oldest out first —
   approximate, but cache order is insertion order in practice. */
function trimTiles(){
  return caches.open(TILES).then(function(c){
    return c.keys().then(function(keys){
      if (keys.length <= TILE_CAP) return;
      return Promise.all(keys.slice(0, keys.length - TILE_CAP).map(function(k){
        return c["delete"](k);
      }));
    });
  });
}

self.addEventListener("fetch", function(e){
  var req = e.request;

  // Road-network queries are POSTs and must always go to the network.
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  // Map tiles: cache first. A stale tile is a perfectly good tile.
  if (/basemaps\.cartocdn\.com$/.test(url.hostname)){
    e.respondWith(
      caches.open(TILES).then(function(c){
        return c.match(req).then(function(hit){
          if (hit) return hit;
          return fetch(req).then(function(res){
            if (res && (res.ok || res.type === "opaque")){
              c.put(req, res.clone());
              trimTiles();
            }
            return res;
          });
        });
      })
    );
    return;
  }

  // The page itself: network first, so updates land, cache as the safety net.
  if (req.mode === "navigate"){
    e.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(SHELL).then(function(c){ c.put("./index.html", copy); });
        return res;
      })["catch"](function(){
        return caches.match("./index.html").then(function(hit){
          return hit || caches.match("./");
        });
      })
    );
    return;
  }

  // Everything else (Leaflet, fonts, icons): cache first, refresh behind.
  e.respondWith(
    caches.match(req).then(function(hit){
      var net = fetch(req).then(function(res){
        if (res && (res.ok || res.type === "opaque")){
          var copy = res.clone();
          caches.open(SHELL).then(function(c){ c.put(req, copy); });
        }
        return res;
      })["catch"](function(){ return hit; });
      return hit || net;
    })
  );
});
