"""Builds the website from the source files.

    python3 tools/build.py

Reads src/template.html and src/engine.js, writes index.html and sw.js at the top of the repo.
The score library (opensheetmusicdisplay.min.js) and the icons are already in the repo.
"""
import hashlib, json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
t = (root / 'src/template.html').read_text()
engine = (root / 'src/engine.js').read_text()

pwa = '''<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" type="image/png" href="icon-192.png">
<meta name="theme-color" content="#2a52be">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Hum to Score">
<meta name="apple-mobile-web-app-status-bar-style" content="default">'''

site = (t.replace('/*ENGINE*/', engine)
         .replace('/*OSMD*/', 'opensheetmusicdisplay.min.js')
         .replace('<!--PWA-->', pwa)
         .replace('/*SITE*/false', 'true'))
(root / 'index.html').write_text(site)

# The service worker keeps the app working offline. Its cache name changes whenever the
# page changes, so phones pick up the new version.
files = ['./', 'index.html', 'opensheetmusicdisplay.min.js', 'manifest.webmanifest',
         'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
version = hashlib.sha1(site.encode()).hexdigest()[:10]
(root / 'sw.js').write_text(f'''// Keeps Hum to Score working without internet once it has loaded.
const CACHE = 'hum-to-score-{version}';
const FILES = {json.dumps(files)};
self.addEventListener('install', e => {{ e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); }});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
}});
// Network first for the page (so updates show up), cache first for everything else.
self.addEventListener('fetch', e => {{
  if (e.request.method !== 'GET') return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(isPage
    ? fetch(e.request).then(r => {{ const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return r; }}).catch(() => caches.match('index.html'))
    : caches.match(e.request).then(hit => hit || fetch(e.request)));
}});
''')
print('Built index.html and sw.js, version', version)
