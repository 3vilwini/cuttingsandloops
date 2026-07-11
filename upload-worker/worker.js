/* sound-garden seed uploads + garden id counter
   ---------------------------------------------------------------------
   Five routes:
   - POST /upload — receives a seed's audio file (raw bytes, streamed
     straight into R2 via the bucket binding, never buffered fully in
     memory) and returns the public URL to store in that slot's synced
     playhtml state instead of a session-only blob: URL.
   - GET /download/<key> — streams that same object back with a
     Content-Disposition: attachment header. The public R2 URL returned
     above is cross-origin from the page, so a plain <a download> link
     to it is silently ignored by the browser (it just opens/plays the
     file instead of saving it) — routing the download through here is
     what actually forces the browser's save dialog.
   - DELETE /delete/<key> — removes that object from R2. Deleting a seed
     or plant in the app only ever removed it from the synced playhtml
     state before; the underlying file stayed in the bucket forever,
     orphaned. This is what the app now calls alongside that so the
     file itself actually goes away too.
   - POST /next-garden-id — hands out the next sequential garden number.
     Backed by a one-row D1 table (below), not KV — KV has no real atomic
     increment, so two people clicking "new garden" at the same moment
     could both land the same number. A single D1 UPDATE...RETURNING
     statement is atomic (D1 databases are single-writer under the
     hood), so the increment can't race the way it would in KV — and
     unlike Durable Objects, D1 is available on Cloudflare's free plan.
   - GET /garden-count — read-only peek at the current count (same D1
     table, no increment). Used by the volume meter's
     double-click-to-teleport hint to pick a random existing garden.

   Deployed via the Cloudflare dashboard (Workers & Pages → Edit code),
   with an R2 bucket bound as SEEDS, a D1 database bound as GARDEN_DB
   (create one under Storage & Databases → D1, then bind it to this
   worker under Settings → Bindings — no manual schema setup needed,
   the code below creates its own table on first use), and
   PUBLIC_BUCKET_URL/ALLOWED_ORIGIN set under the worker's Settings →
   Variables.
   --------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/upload") {
      return handleUpload(request, env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/download/")) {
      return handleDownload(url, env);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/delete/")) {
      return handleDelete(url, env);
    }
    if (request.method === "POST" && url.pathname === "/next-garden-id") {
      return handleNextGardenId(env);
    }
    if (request.method === "GET" && url.pathname === "/garden-count") {
      return handleGardenCount(env);
    }
    return new Response("not found", { status: 404, headers: corsHeaders(env) });
  },
};

// single row, single column — the whole "table" is just a counter with
// a fixed id so there's only ever one row to update. IF NOT EXISTS /
// OR IGNORE make this safe to run on every request rather than needing
// a separate one-time migration step run by hand.
async function ensureCounterTable(env) {
  await env.GARDEN_DB.batch([
    env.GARDEN_DB.prepare(
      "CREATE TABLE IF NOT EXISTS garden_counter (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL DEFAULT 0)"
    ),
    env.GARDEN_DB.prepare("INSERT OR IGNORE INTO garden_counter (id, count) VALUES (1, 0)"),
  ]);
}

// a single UPDATE...RETURNING is atomic — D1 serializes writes to a given
// database, so two concurrent requests can't both read the same "current"
// value and increment from it the way they could against KV
async function handleNextGardenId(env) {
  await ensureCounterTable(env);
  const row = await env.GARDEN_DB
    .prepare("UPDATE garden_counter SET count = count + 1 WHERE id = 1 RETURNING count")
    .first();
  return new Response(JSON.stringify({ id: row.count }), {
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

// read-only peek at the current count, for the "teleport to a random
// garden" hint on the volume meter — doesn't allocate a new id, just
// reports how many exist so the client can pick a random one in range
async function handleGardenCount(env) {
  await ensureCounterTable(env);
  const row = await env.GARDEN_DB.prepare("SELECT count FROM garden_counter WHERE id = 1").first();
  return new Response(JSON.stringify({ count: row?.count || 0 }), {
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Garden-Id, X-Slot-Index, X-File-Name",
  };
}

async function handleUpload(request, env) {
  const gardenId = request.headers.get("X-Garden-Id");
  const slot = request.headers.get("X-Slot-Index");
  const fileName = request.headers.get("X-File-Name") || "seed";

  if (!gardenId || slot === null) {
    return new Response("missing X-Garden-Id or X-Slot-Index header", { status: 400, headers: corsHeaders(env) });
  }
  if (!request.body) {
    return new Response("no file body", { status: 400, headers: corsHeaders(env) });
  }

  // one object per (garden, slot) — re-saving that slot overwrites the old file,
  // matching the "save" button's replace-on-resave behavior in the UI
  const key = `${gardenId}/${slot}/${sanitize(fileName)}`;

  await env.SEEDS.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
  });

  const url = `${env.PUBLIC_BUCKET_URL}/${key}`;
  return new Response(JSON.stringify({ url }), {
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

async function handleDownload(url, env) {
  const key = decodeURIComponent(url.pathname.slice("/download/".length));
  const object = await env.SEEDS.get(key);
  if (!object) {
    return new Response("not found", { status: 404, headers: corsHeaders(env) });
  }
  const fileName = key.split("/").pop();
  return new Response(object.body, {
    headers: {
      ...corsHeaders(env),
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

async function handleDelete(url, env) {
  const key = decodeURIComponent(url.pathname.slice("/delete/".length));
  await env.SEEDS.delete(key);   // no-op (not an error) if the key doesn't exist
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function sanitize(name) {
  return name.replace(/[^\w.\-]+/g, "_");
}
