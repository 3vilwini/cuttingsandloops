/* ୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.
   GARDENS — shared by water.js (a garden) and index.html (the list of them)
   ୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚. */

// the deployed Worker (upload-worker/worker.js)
export const UPLOAD_ENDPOINT = "https://sound-garden-uploads.renxchristiane.workers.dev";

// garden 0 is the original one (the bare URL, no ?g=); every other garden is ?g=<id>
export function gardenUrl(id){
  return id === 0 ? "feelthegrass.html" : `feelthegrass.html?g=${id}`;
}

// the next unused garden number, from the Worker's atomic counter — not made up
// locally, since two people starting one at once could otherwise land on the
// same number and end up sharing one room
export async function startNewGarden(){
  const res = await fetch(`${UPLOAD_ENDPOINT}/next-garden-id`, { method: "POST" });
  if(!res.ok) throw new Error(`next-garden-id failed: ${res.status}`);
  const { id } = await res.json();
  return id;
}

// a garden's name is its tags, settings ({ colors, pattern, scale }) are what
// the index previews on hover, and contributors are the names of whoever planted
// in it — report them so the index can list and show it.
// skipped on localhost: a local test garden 0 would otherwise overwrite the
// real original garden's name and look in the shared list
export async function registerGarden(id, { tags, settings, contributors }){
  if(["localhost", "127.0.0.1"].includes(location.hostname)) return;
  try {
    await fetch(`${UPLOAD_ENDPOINT}/register-garden`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, tags, settings, contributors }),
    });
  } catch(err) {
    console.warn("couldn't register this garden's name:", err);
  }
}

// tells the Worker someone is in this garden, so the index can show "N here
// now". a random id per page load (nothing personal) is pinged every
// PRESENCE_PING_MS while the tab is visible, and dropped when the page closes.
// skipped on localhost for the same reason registerGarden is
const PRESENCE_PING_MS = 45 * 1000;
export function startPresence(id){
  if(["localhost", "127.0.0.1"].includes(location.hostname)) return;
  const visitor = crypto.randomUUID();
  const send = leaving => fetch(`${UPLOAD_ENDPOINT}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(leaving ? { id, visitor, leaving: true } : { id, visitor }),
    keepalive: true,
  }).catch(() => {});
  const ping = () => { if(document.visibilityState === "visible") send(false); };
  ping();
  setInterval(ping, PRESENCE_PING_MS);
  document.addEventListener("visibilitychange", ping);
  window.addEventListener("pagehide", () => send(true));
}

// { "<garden id>": how many are in it right now } — just the live counts, cheap
// enough to re-ask every few seconds. {} when it can't be reached
export async function fetchHereNow(){
  try {
    const res = await fetch(`${UPLOAD_ENDPOINT}/gardens`, { cache: "no-store" });
    if(!res.ok) return {};
    return (await res.json()).here || {};
  } catch {
    return {};
  }
}

// every garden that exists: the original, plus 1..count from the counter, with
// names, settings and contributors filled in for whichever have reported them
// ({ id, tags, settings, contributors } — settings is null until a garden has). if that list can't be
// reached the gardens still come back, just unnamed — only losing the counter
// too (nothing to list) throws.
export async function fetchGardens(){
  const [countRes, namesRes] = await Promise.allSettled([
    fetch(`${UPLOAD_ENDPOINT}/garden-count`),
    fetch(`${UPLOAD_ENDPOINT}/gardens`),
  ]);
  if(countRes.status !== "fulfilled" || !countRes.value.ok) throw new Error("couldn't read the garden count");
  const { count } = await countRes.value.json();

  const reported = {};
  let here = {};
  if(namesRes.status === "fulfilled" && namesRes.value.ok){
    const data = await namesRes.value.json();
    for(const g of data.gardens) reported[g.id] = g;
    here = data.here || {};
  }
  return Array.from({ length: count + 1 }, (_, id) => ({
    id,
    tags: reported[id]?.tags || [],
    settings: reported[id]?.settings || null,
    contributors: reported[id]?.contributors || [],
    here: here[id] || 0,
  }));
}
