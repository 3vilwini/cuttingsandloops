/* sound-garden seed uploads
   ---------------------------------------------------------------------
   Three routes:
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

   Deployed via the Cloudflare dashboard (Workers & Pages → Edit code),
   with an R2 bucket bound as SEEDS and PUBLIC_BUCKET_URL/ALLOWED_ORIGIN
   set under the worker's Settings → Variables.
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
    return new Response("not found", { status: 404, headers: corsHeaders(env) });
  },
};

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
