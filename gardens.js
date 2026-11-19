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

// a garden's name is its tags, and settings ({ colors, pattern, scale }) are
// what the index previews on hover — report both so it can list and show it.
// skipped on localhost: a local test garden 0 would otherwise overwrite the
// real original garden's name and look in the shared list
export async function registerGarden(id, { tags, settings }){
  if(["localhost", "127.0.0.1"].includes(location.hostname)) return;
  try {
    await fetch(`${UPLOAD_ENDPOINT}/register-garden`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, tags, settings }),
    });
  } catch(err) {
    console.warn("couldn't register this garden's name:", err);
  }
}

// every garden that exists: the original, plus 1..count from the counter, with
// names and settings filled in for whichever have reported them ({ id, tags,
// settings } — settings is null until a garden has). if that list can't be
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
  if(namesRes.status === "fulfilled" && namesRes.value.ok){
    const { gardens } = await namesRes.value.json();
    for(const g of gardens) reported[g.id] = g;
  }
  return Array.from({ length: count + 1 }, (_, id) => ({
    id,
    tags: reported[id]?.tags || [],
    settings: reported[id]?.settings || null,
  }));
}
