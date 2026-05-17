// =============================================================
// DRG-Garantidora — Service Worker
// Versão: 1.0 (2026-05-16)
//
// Estratégia:
// - HTML e JS: network-first (sempre busca a versão nova; usa cache
//   só se estiver offline) — evita travar numa versão antiga.
// - Assets estáticos (logo, css, manifest): cache-first.
// - Firebase, Workers Cloudflare e APIs externas: nunca cacheia.
// =============================================================

const CACHE_VERSION = 'drg-garantidora-v1-20260516b';

const STATIC_ASSETS = [
  './logo.png?v=20260516b',
  './manifest.json',
];

// Hosts que NUNCA devem ser cacheados (precisam estar sempre online)
const NEVER_CACHE_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebase.googleapis.com',
  'gstatic.com',
  'workers.dev',        // Workers Cloudflare da DRG
  'asaas.com',          // API de cobrança (boleto + Pix)
  'brasilapi.com.br',
  'viacep.com.br',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Pré-cache falhou pra alguns assets:', err);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (NEVER_CACHE_HOSTS.some((h) => url.hostname.includes(h))) {
    return; // deixa o browser fazer o fetch normal, sempre online
  }

  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('/') ||
    url.pathname === ''
  ) {
    event.respondWith(networkFirst(req));
    return;
  }

  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200 && fresh.type === 'basic') {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(
      '<html lang="pt-BR"><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
      '<h1>Sem conexão</h1><p>A DRG-Garantidora precisa de internet pra funcionar.</p>' +
      '<p>Verifique sua conexão e recarregue.</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_) {
    return new Response('', { status: 503 });
  }
}
