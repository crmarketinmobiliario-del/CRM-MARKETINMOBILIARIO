
const CACHE = "crm-capture-shell-v21";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./capture-bridge.js",
  "./manifest.webmanifest",
  "./crm.html",
  "./crm.css",
  "./crm.js",
  "./push-config.js",
  "./supabase-config.js",
  "./icon-rm-192.png",
  "./icon-rm-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);

    try {
      await cache.add(
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
      );
    } catch (_) {}
  })());

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE)
          .map(k => caches.delete(k))
      )
    ),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  if (
    event.request.method === "GET" &&
    url.href ===
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
  ) {
    event.respondWith(
      caches.match(event.request).then(
        cached => cached || fetch(event.request)
      )
    );
    return;
  }

  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();

          caches.open(CACHE).then(cache =>
            cache.put(event.request, copy)
          );
        }

        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// NOTIFICACIONES PUSH

self.addEventListener("push", event => {
  let message = {
    title: "CRM Torres Maldonado",
    body: "Tienes actividades pendientes.",
    url: "./crm.html"
  };

  try {
    if (event.data) {
      message = {
        ...message,
        ...event.data.json()
      };
    }
  } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(
      message.title,
      {
        body: message.body,

        icon: "./icon-rm-192.png",

        tag: message.tag || "crm-reminders",

        data: {
          url: message.url || "./crm.html"
        }
      }
    )
  );
});

// ABRIR CRM AL TOCAR LA NOTIFICACIÓN

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil((async () => {
    const url = new URL(
      event.notification.data?.url || "./crm.html",
      self.registration.scope
    ).href;

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (
        new URL(client.url).origin ===
        new URL(url).origin
      ) {
        await client.navigate(url);
        return client.focus();
      }
    }

    return self.clients.openWindow(url);
  })());
});
