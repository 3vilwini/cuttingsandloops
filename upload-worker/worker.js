/* sound-garden seed uploads + garden id counter
   ---------------------------------------------------------------------
   Four routes:
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
     Backed by the GardenCounter Durable Object (below), not KV — KV has
     no real atomic increment, so two people clicking "new garden" at
     the same moment could both land the same number. A Durable Object
     is single-threaded per instance, so its increment is genuinely
     atomic; there's only ever one instance (a fixed id, see
     GARDEN_COUNTER.idFromName("singleton")) so it's a true global
     counter, not one-per-garden.

   Deployed via the Cloudflare dashboard (Workers & Pages → Edit code),
   with an R2 bucket bound as SEEDS, a GARDEN_COUNTER Durable Object
   binding (see wrangler.toml), and PUBLIC_BUCKET_URL/ALLOWED_ORIGIN set
   under the worker's Settings → Variables.
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
    return new Response("not found", { status: 404, headers: corsHeaders(env) });
  },
};

// one Durable Object instance for the whole worker — a fixed name always
// resolves to the same instance, which is what makes this a single global
// counter instead of accidentally sharding into several
async function handleNextGardenId(env) {
  const id = env.GARDEN_COUNTER.idFromName("singleton");
  const stub = env.GARDEN_COUNTER.get(id);
  const res = await stub.fetch("https://do/next", { method: "POST" });
  return new Response(await res.text(), {
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}

// Durable Objects are single-threaded per instance — every request to this
// exact instance runs to completion before the next one starts, so
// read-increment-write here can never race the way it would in KV
export class GardenCounter {
  constructor(state) {
    this.state = state;
  }
  async fetch() {
    const current = (await this.state.storage.get("count")) || 0;
    const next = current + 1;
    await this.state.storage.put("count", next);
    return new Response(JSON.stringify({ id: next }));
  }
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
