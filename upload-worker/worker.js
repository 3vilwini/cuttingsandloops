/* sound-garden seed uploads + garden id counter
   ---------------------------------------------------------------------
   Seven routes:
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
   - POST /register-garden — a garden reports its (up to 3) tags, which are
     its name, its season settings (which the index previews on hover) and the
     names of the people who planted in it.
     Body: { id, tags, settings, contributors }. Upsert into a second D1 table.
   - GET /gardens — every registered garden's { id, tags, settings, contributors }, for the
     index page. Gardens that haven't reported yet aren't in here; the index
     fills those in from /garden-count as unnamed.

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
    if (request.method === "GET" && url.pathname === "/gardens") {
      return handleListGardens(env);
    }
    if (request.method === "POST" && url.pathname === "/register-garden") {
      return handleRegisterGarden(request, env);
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

// a garden's name is its (up to) 3 "feels like" tags, and its look is its
// season settings (colors, pattern, scale) — both only exist inside that
// garden's own playhtml room, and a page can't read many rooms at once. so each
// garden reports them here and the index page reads them back in one request,
// naming each garden and previewing its look on hover. id 0 is the original
// garden (the bare URL, no ?g=).
let gardensTableReady = false;
async function ensureGardensTable(env) {
  if (gardensTableReady) return;
  await env.GARDEN_DB.prepare(
    "CREATE TABLE IF NOT EXISTS gardens (id INTEGER PRIMARY KEY, tags TEXT NOT NULL DEFAULT '[]', settings TEXT, contributors TEXT, updated_at INTEGER NOT NULL)"
  ).run();
  // a table made before these columns existed lacks them — add each. when one
  // is already there this throws, which is the expected "nothing to do" case
  for (const column of ["settings", "contributors"]) {
    try {
      await env.GARDEN_DB.prepare(`ALTER TABLE gardens ADD COLUMN ${column} TEXT`).run();
    } catch {}
  }
  gardensTableReady = true;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const isHex = c => typeof c === "string" && HEX.test(c);

// season settings as the app stores them: { colors: { background: [sky, soil],
// seed, text }, pattern, scale }. rebuilt from checked pieces rather than passed
// through, so nothing else a client sends ever gets stored. null if unusable.
function parseSettings(s) {
  const bg = s?.colors?.background;
  if (!Array.isArray(bg) || bg.length !== 2 || !bg.every(isHex)) return null;
  if (!isHex(s.colors.seed) || !isHex(s.colors.text)) return null;
  if (!["lattice", "array", "furrow"].includes(s.pattern)) return null;
  if (typeof s.scale !== "number" || !(s.scale >= 0.1 && s.scale <= 5)) return null;
  return {
    colors: { background: [bg[0], bg[1]], seed: s.colors.seed, text: s.colors.text },
    pattern: s.pattern,
    scale: s.scale,
  };
}

// names of the people who planted in a garden: up to 12 distinct non-blank
// strings, trimmed to 40 chars. null (not []) when the page didn't send any
// list at all, so an older page doesn't erase what's stored
function parseContributors(list) {
  if (!Array.isArray(list)) return null;
  const names = [];
  for (const n of list) {
    if (typeof n !== "string") continue;
    const clean = n.trim().slice(0, 40);
    if (clean && !names.includes(clean)) names.push(clean);
    if (names.length === 12) break;
  }
  return names;
}

// returns { id, tags, settings, contributors } for a usable registration, or null. the id
// can't be beyond how many gardens have actually been created, so nobody can
// fill the table with made-up ids; tags are capped to the app's own limit of 3.
// settings are optional (older pages only send tags) and unusable ones are
// dropped rather than failing the whole registration.
function parseGardenRegistration(body, count) {
  const id = body?.id;
  if (!Number.isInteger(id) || id < 0 || id > count) return null;
  if (!Array.isArray(body.tags) || body.tags.length > 3) return null;
  const tags = [];
  for (const t of body.tags) {
    if (typeof t !== "string") return null;
    const clean = t.trim().slice(0, 40);
    if (clean) tags.push(clean);
  }
  return { id, tags, settings: parseSettings(body.settings), contributors: parseContributors(body.contributors) };
}

async function handleRegisterGarden(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400, headers: corsHeaders(env) });
  }
  await ensureCounterTable(env);
  const counter = await env.GARDEN_DB.prepare("SELECT count FROM garden_counter WHERE id = 1").first();
  const parsed = parseGardenRegistration(body, counter?.count || 0);
  if (!parsed) {
    return new Response("invalid garden", { status: 400, headers: corsHeaders(env) });
  }
  await ensureGardensTable(env);
  // COALESCE: a registration without usable settings (or without a contributors
  // list) keeps whatever was already stored instead of erasing it
  await env.GARDEN_DB
    .prepare(
      "INSERT INTO gardens (id, tags, settings, contributors, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT(id) DO UPDATE SET tags = excluded.tags, " +
      "settings = COALESCE(excluded.settings, gardens.settings), " +
      "contributors = COALESCE(excluded.contributors, gardens.contributors), updated_at = excluded.updated_at"
    )
    .bind(
      parsed.id,
      JSON.stringify(parsed.tags),
      parsed.settings && JSON.stringify(parsed.settings),
      parsed.contributors && JSON.stringify(parsed.contributors),
      Date.now()
    )
    .run();
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

async function handleListGardens(env) {
  await ensureGardensTable(env);
  const { results } = await env.GARDEN_DB.prepare("SELECT id, tags, settings, contributors, updated_at FROM gardens ORDER BY id").all();
  const gardens = results.map(r => ({
    id: r.id,
    tags: JSON.parse(r.tags),
    settings: r.settings ? JSON.parse(r.settings) : null,
    contributors: r.contributors ? JSON.parse(r.contributors) : [],
    updatedAt: r.updated_at,
  }));
  return new Response(JSON.stringify({ gardens }), {
    headers: { ...corsHeaders(env), "Content-Type": "application/json", "Cache-Control": "no-store" },
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
