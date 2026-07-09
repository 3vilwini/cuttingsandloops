import { playhtml } from "https://unpkg.com/playhtml";

const TAG_BANK = ["sunny","ambient","delicious","rainy","fuzzy","low bpm","lush","blooming","squishy","pop"];
// the deployed Worker (upload-worker/worker.js) that streams uploads into
// R2 — left empty, plant/seed uploads fall back to session-only blob URLs
// instead, which still work locally but can't be shared across visitors.
const UPLOAD_ENDPOINT = "https://sound-garden-uploads.renxchristiane.workers.dev";
const MAX_TAGS = 3;
const PATTERNS = [
  { id:"lattice", label:"lattice" },   // grid of very thin light lines
  { id:"array",   label:"array" },     // dots arranged in a spiral
  { id:"furrow",  label:"furrow" },    // straight horizontal lines
];

const FIELD_W = 2400, FIELD_H = 1600;   // the field is bigger than the viewport — arrow keys pan it
const STEP = 95;

const garden = {
  id: null,
  meta: {
    tags: [],
    colors: {
      background: ["#3AB704", "#E2FFCB"],   // [sky, soil] — top-to-bottom gradient stops
      seed: "#FFD8B6",                       // also colors the field pattern + decorative seed markers
      text: "#FFFFFF",                       // label color
    },
    pattern: "lattice",       // "lattice" | "array" | "furrow"
    scale: 1,                 // multiplies pattern spacing/dot size
  },
  plants: {},   // plantId -> { id, name, audioRef, sampledFrom (string[]), paths ([[{x,y},...],...]), color, x, y }
  // note: "pinned" is intentionally not part of this shape — see pinnedPlantIds
  seeds: {},    // slot index (string "0".."9") -> { title, artist, audioRef }
};

// declared here rather than down by connectChannels() (where they'd
// conceptually belong) because applyColors() runs at top-level during
// initial page load and calls syncMeta(), which reads metaChannel — a
// `let` declared later would be a temporal-dead-zone ReferenceError there.
let plantSlotsChannel = null;
let metaChannel = null;
let seedsChannel = null;

/* garden.meta itself now lives in playhtml's synced Page Data (see
   connectChannels below) — that's the real persistence, shared across every
   visitor to this URL, not just this browser. No localStorage needed. */

function newId(len=8){
  return crypto.randomUUID ? crypto.randomUUID().slice(0,len) : Math.random().toString(36).slice(2,2+len);
}

/* hex "#rrggbb" -> "r,g,b" so the seed color can be used at low opacity for the field pattern */
function hexToRgb(hex){
  const m = hex.replace("#","").match(/.{2}/g).map(h => parseInt(h,16));
  return m.join(",");
}

/* true color inversion (255-channel), for the empty-seed hover glow — the
   literal "opposite color" of the seed color used for a planted seed's glow */
function invertHex(hex){
  const [r,g,b] = hex.replace("#","").match(/.{2}/g).map(h => parseInt(h,16));
  const toHex = n => (255-n).toString(16).padStart(2,"0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const randInt = (min,max) => Math.floor(Math.random()*(max-min+1))+min;

/* hsl -> hex, so random defaults can be constrained to sane saturation/lightness
   ranges instead of raw random RGB (which mostly produces muddy, low-contrast colors) */
function hsl2hex(h, s, l){
  s/=100; l/=100;
  const k = n => (n + h/30) % 12;
  const a = s * Math.min(l, 1-l);
  const f = n => l - a*Math.max(-1, Math.min(k(n)-3, Math.min(9-k(n), 1)));
  const toHex = n => Math.round(255*f(n)).toString(16).padStart(2,"0");
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

/* random but constrained: a saturated seed color, a sky->soil pair with real
   lightness contrast, and labels picked for contrast against the sky. */
function randomizeDefaultColors(){
  const bgHue = randInt(0,359);
  const seedHue = (bgHue + 180 + randInt(-40,40) + 360) % 360; // roughly complementary -> pops against the field
  const skyLightness = randInt(35,45);
  cBg1.value = hsl2hex(bgHue, randInt(55,75), skyLightness);
  cBg2.value = hsl2hex((bgHue + randInt(-15,15) + 360) % 360, randInt(30,50), randInt(85,92));
  cSeed.value = hsl2hex(seedHue, randInt(65,85), randInt(55,70));
  cText.value = skyLightness < 50 ? "#FFFFFF" : "#000000";
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/* seed slots — one fixed layout per pattern (not random), so a given pattern
   always shows its seeds in the same arrangement, matching how that pattern
   reads visually (grid cells for lattice, spiral arms for array, rows for furrow). */
const CX = FIELD_W/2, CY = FIELD_H/2;
const SEED_COLS = [-400,-200,0,200,400];

/* base offsets from field center, one fixed layout per pattern (10 seeds each) —
   actual on-screen position is these offsets times the current scale, so slot
   placement spreads/tightens together with the pattern itself. */
const LATTICE_ROWS = [
  { dy:-180, xs:[-300, 0, 300] },
  { dy:0,    xs:[-375, -125, 125, 375] },
  { dy:180,  xs:[-300, 0, 300] },
];
const SEED_SLOTS_BASE = {
  // 3 / 4 / 3 rows — deliberately not the same grid as furrow, so the two
  // patterns' seed layouts actually look different from each other
  lattice: LATTICE_ROWS.flatMap(row => row.xs.map(dx => ({ dx, dy:row.dy }))),
  // every other column (both its seeds together) nudged lower than its
  // neighbors, so a long name doesn't run into the column right next to it
  furrow: SEED_COLS.flatMap((dx, col) => {
    const extra = col % 2 === 1 ? 90 : 0;
    return [{dx,dy:-90+extra}, {dx,dy:90+extra}];
  }),
};
function arraySlotOffsets(scale){
  // same spiral formula the pattern itself uses, so seeds land along its arms
  return Array.from({length:10}, (_,i) => {
    const t = 1 + i*0.9, r = 44*t*scale;
    return { dx:r*Math.cos(t), dy:r*Math.sin(t) };
  });
}
/* the current pattern's seed positions, in field coordinates — the single
   source of truth both renderSeedSlots and the field's hover/click
   handling (seedOccupiedBoxes) read from. */
function seedFieldOffsets(){
  const scale = garden.meta.scale || 1;
  return garden.meta.pattern === "array"
    ? arraySlotOffsets(scale)
    : SEED_SLOTS_BASE[garden.meta.pattern].map(o => ({ dx:o.dx*scale, dy:o.dy*scale }));
}

/* an empty slot invites a click (opens the add-seed modal); a filled one
   shows "title - artist" and previews on hover, same as a plant does. */
function renderSeedSlots(){
  const layer = document.getElementById("seedSlots");
  layer.innerHTML = "";
  seedFieldOffsets().forEach((o, i) => {
    const seed = garden.seeds[i];
    const el = document.createElement("div");
    el.className = "seedslot" + (seed ? "" : " empty");
    el.style.left = (CX + o.dx) + "px"; el.style.top = (CY + o.dy) + "px";
    el.style.color = garden.meta.colors.text;
    // a planted seed glows its own seed color on hover; an empty one glows
    // the exact opposite (inverted) color, so the two states read distinctly
    el.style.setProperty("--glow", seed ? garden.meta.colors.seed : invertHex(garden.meta.colors.seed));
    el.style.setProperty("--text-color", garden.meta.colors.text);
    el.style.setProperty("--soil-color", garden.meta.colors.background[1]);
    const dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = garden.meta.colors.seed;
    const label = document.createElement("span");
    label.className = "txt";
    label.textContent = seed ? `${seed.title} - ${seed.artist}` : "+ add seed";
    el.appendChild(dot); el.appendChild(label);

    if(seed){
      el.addEventListener("mouseenter", () => {
        // peek at the roots regardless of the persistent toggle state —
        // mouseleave reverts to whatever that toggle actually says
        document.getElementById("connectionsLayer").style.display = "";
      });
      el.addEventListener("mouseleave", () => {
        applyViewToggles();
      });
      // click opens the seed list panel instead of touching roots at all —
      // hover is what shows them now, see mouseenter/mouseleave above
      el.addEventListener("click", e => { e.stopPropagation(); showSeedList(); });
    } else {
      // stopPropagation matters here — without it this click also bubbles to
      // the field's own click handler, which independently checks proximity
      // to a *plant* hot spot (a completely different, denser grid) and
      // would immediately close this seed modal and open the plant one
      // instead, since a seed slot and a plant hot spot can easily overlap
      el.addEventListener("click", e => { e.stopPropagation(); openSeedModal(i); });
    }
    layer.appendChild(el);
  });
}

function renderPlantSlots(){
  const layer = document.getElementById("plantSlots");
  layer.innerHTML = "";
  Object.values(garden.plants || {}).forEach(p => {
    const el = document.createElement("div");
    // pinned/loading are local-only state, never read from the synced
    // plant object — see the notes by their declarations
    el.className = "plantmark" + (pinnedPlantIds.has(p.id) ? " pinned" : "") + (loadingPlantIds.has(p.id) ? " loading" : "");
    el.dataset.plantId = p.id;   // lets renderConnections find this plant's own labeldot
    el.style.left = p.x + "px"; el.style.top = p.y + "px";
    el.title = p.name;
    // opposite of a filled seed's own hover glow color (see .seedslot:hover)
    el.style.setProperty("--glow", invertHex(garden.meta.colors.seed));
    // same two custom properties a seed slot sets, so .plantmark.loading .txt
    // can reuse its exact pulsing-gradient CSS
    el.style.setProperty("--text-color", garden.meta.colors.text);
    el.style.setProperty("--soil-color", garden.meta.colors.background[1]);

    if(p.paths && p.paths.length){
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${pCanvas.width} ${pCanvas.height}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      p.paths.forEach(stroke => {
        if(stroke.length < 2) return;
        const poly = document.createElementNS(SVG_NS, "polyline");
        poly.setAttribute("points", stroke.map(pt => `${pt.x},${pt.y}`).join(" "));
        poly.setAttribute("fill", "none");
        poly.setAttribute("stroke", p.color);
        poly.setAttribute("stroke-width", "1.5");
        poly.setAttribute("stroke-linecap", "butt");
        poly.setAttribute("stroke-linejoin", "miter");
        poly.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(poly);
      });
      el.appendChild(svg);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "fallback";
      fallback.style.background = p.color;
      el.appendChild(fallback);
    }

    // inverse of the current seed color (not the fixed p.color used for the
    // drawing/roots) — recomputed live so it stays in sync if seed color
    // changes later, same reasoning as renderField() calling renderPlantSlots()
    const labelDot = document.createElement("span");
    labelDot.className = "labeldot";
    labelDot.style.background = invertHex(garden.meta.colors.seed);
    el.appendChild(labelDot);

    // the planter's name — same "txt" class the seed labels use, so the
    // existing "labels" toggle shows/hides this one too for free
    const label = document.createElement("span");
    label.className = "txt";
    label.textContent = p.name;
    label.style.color = garden.meta.colors.text;
    el.appendChild(label);

    // no per-element hover audio anymore — updateAmbientAudio() plays/fades
    // every plant continuously based on distance from the cursor, so simply
    // being near one (not necessarily directly over it) is enough
    el.addEventListener("click", e => e.stopPropagation()); // don't let this also trigger the field's plant-here click

    // drag to reposition (from anywhere on the marker) — persists for
    // everyone via plantSlotsChannel. A mousedown that never actually moves
    // is a plain click instead: toggles pinned. A second one landing soon
    // after (hand-rolled double-click detection, not the native dblclick
    // event, so it isn't thrown off by renderPlantSlots rebuilding this
    // element's DOM node in between) opens this plant for editing.
    el.addEventListener("mousedown", e => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const origX = p.x, origY = p.y;
      let moved = false;
      function onMove(ev){
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if(!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        p.x = origX + dx; p.y = origY + dy;
        el.style.left = p.x + "px"; el.style.top = p.y + "px";
        // pitch/volume both update on their own every frame in
        // updateAmbientAudio() — no need to touch audio here while dragging.
        // roots aren't on any per-frame loop, though — without this, a
        // connection line stays frozen at the old spot until the drag ends
        renderConnections();
      }
      function onUp(){
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if(moved){
          // position is real shared state — every visitor sees this move,
          // and it's what drives everyone's pitch/volume for this plant too
          garden.plants[p.id] = p;
          plantSlotsChannel?.setData(draft => { draft[p.id] = p; });
        } else if(Date.now() - (lastPlantClickTimes[p.id] || 0) < 350){
          lastPlantClickTimes[p.id] = 0;
          openPlantEditModal(p);
        } else {
          lastPlantClickTimes[p.id] = Date.now();
          // pin/unpin is local-only — nothing written to plantSlotsChannel.
          // updateAmbientAudio() picks up the change on its next frame, so
          // no direct play/stop call is needed here either.
          if(pinnedPlantIds.has(p.id)) pinnedPlantIds.delete(p.id);
          else pinnedPlantIds.add(p.id);
          renderPlantSlots();
        }
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    layer.appendChild(el);
  });
  applyViewToggles();
  renderConnections();   // plants (and their positions) may have changed
}

/* dashed curved lines from every filled seed to each plant whose
   sampledFrom includes it. Always rendered (same as the seed/plant/label
   layers) — visibility is purely VIEW_STATE.roots via applyViewToggles, the
   same "roots" switch in the bottom bar. Clicking a filled seed doesn't
   pick which one to show anymore — it just flips that same switch, via
   toggleView, exactly like clicking the bottom-bar button does. */
function renderConnections(){
  const svg = document.getElementById("connectionsLayer");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${FIELD_W} ${FIELD_H}`);
  const defs = document.createElementNS(SVG_NS, "defs");
  svg.appendChild(defs);
  let gradientCount = 0;
  const offsets = seedFieldOffsets();
  const plants = Object.values(garden.plants || {});
  const fieldRect = fieldEl.getBoundingClientRect();
  for(const i in garden.seeds){
    const seed = garden.seeds[i];
    if(!seed) continue;
    const label = `${seed.title} - ${seed.artist}`;
    const o = offsets[i];
    const from = { x: CX + o.dx, y: CY + o.dy };
    const connected = plants.filter(p => Array.isArray(p.sampledFrom) && p.sampledFrom.includes(label));
    for(const p of connected){
      // ends on the plant's own labeldot, not its drawing's center — measured
      // live (same idea as occupiedBoxes/seedOccupiedBoxes) rather than
      // computed from margin/size constants, so it stays correct even if
      // that dot's CSS changes. Falls back to the plant's raw x/y if the
      // dot isn't actually rendered right now (e.g. the "plants" toggle is off).
      const dotEl = document.querySelector(`#plantSlots .plantmark[data-plant-id="${p.id}"] .labeldot`);
      const dotRect = dotEl?.getBoundingClientRect();
      const toX = dotRect?.width ? dotRect.left + dotRect.width/2 - fieldRect.left : p.x;
      const toY = dotRect?.width ? dotRect.top + dotRect.height/2 - fieldRect.top : p.y;
      // bow the line out to the side, perpendicular to the straight path
      // between them, so overlapping connections stay visually distinct
      // instead of stacking as straight lines
      const dx = toX - from.x, dy = toY - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = 40;
      const midX = (from.x + toX) / 2 - (dy / len) * bow;
      const midY = (from.y + toY) / 2 + (dx / len) * bow;

      // gradient from the seed's own dot color to this plant's dot color,
      // so the line itself reads as flowing from one to the other — each
      // connection needs its own gradient since the endpoints differ
      const gradientId = `rootGradient-${gradientCount++}`;
      const gradient = document.createElementNS(SVG_NS, "linearGradient");
      gradient.setAttribute("id", gradientId);
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      gradient.setAttribute("x1", from.x); gradient.setAttribute("y1", from.y);
      gradient.setAttribute("x2", toX); gradient.setAttribute("y2", toY);
      const stop1 = document.createElementNS(SVG_NS, "stop");
      stop1.setAttribute("offset", "0%"); stop1.setAttribute("stop-color", garden.meta.colors.seed);
      const stop2 = document.createElementNS(SVG_NS, "stop");
      stop2.setAttribute("offset", "100%"); stop2.setAttribute("stop-color", p.color);
      gradient.appendChild(stop1); gradient.appendChild(stop2);
      defs.appendChild(gradient);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${from.x} ${from.y} Q ${midX} ${midY} ${toX} ${toY}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", `url(#${gradientId})`);
      path.setAttribute("stroke-width", "2");
      // tight dotted line: a near-zero dash length with a round cap draws a
      // small dot at each point, spaced close together, instead of dashes
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-dasharray", "0.1 3");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    }
  }
}

/* draws the current garden.meta.colors/pattern onto the field (gradient)
   and the SVG layer (pattern lines/dots), sized to the whole (bigger-than-
   viewport) field rather than just what's on screen. */
function renderField(){
  const { background, text, seed } = garden.meta.colors;
  const fieldEl = document.getElementById("field");
  fieldEl.style.background = `linear-gradient(to bottom, ${background[0]}, ${background[1]})`; // sky -> soil
  fieldEl.style.color = text;
  renderSeedSlots();
  // plant labeldots are colored from garden.meta.colors.text too — without
  // this they'd keep whatever color was current when each plant last
  // rendered, drifting out of sync with the seed dots the moment "labels" changes
  renderPlantSlots();

  const svg = document.getElementById("patternLayer");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${FIELD_W} ${FIELD_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const rgb = hexToRgb(seed);

  const scale = garden.meta.scale || 1;
  const LATTICE_BASE = 104;   // grid cell size (doubled again from 52)
  const FURROW_BASE = 26;     // independent of LATTICE_BASE now, so furrow's spacing doesn't change too

  if(garden.meta.pattern === "array"){
    // dots arranged in an outward spiral from center, spaced evenly along
    // the curve (not by fixed angle step, or it thins into spokes at radius) —
    // wider pitch + smaller dots so it reads as a spiral, not concentric rings.
    const maxR = Math.hypot(FIELD_W, FIELD_H)/2 + 60;
    const a = 16 * scale;      // spiral pitch — distance between successive arms
    const dotGap = 10 * scale; // arc-length distance between dots — doubled density vs before
    const dotR = Math.max(0.6, 0.9 * scale);
    const group = svgEl("g", { fill:`rgba(${rgb},.55)` });
    let t = 1;
    for(let r = a*t; r <= maxR; r = a*t){
      const x = CX + r*Math.cos(t), y = CY + r*Math.sin(t);
      group.appendChild(svgEl("circle", { cx:x.toFixed(1), cy:y.toFixed(1), r:dotR }));
      t += dotGap / r;       // shrink angular step as radius grows -> even spacing
    }
    svg.appendChild(group);
  } else {
    // lattice (grid) or furrow (horizontal-only) — both are a tiled <pattern>
    const spacing = (garden.meta.pattern === "lattice" ? LATTICE_BASE : FURROW_BASE) * scale;
    const defs = svgEl("defs", {});
    const pattern = svgEl("pattern", { id:"fieldPattern", width:spacing, height:spacing, patternUnits:"userSpaceOnUse" });
    const stroke = `rgba(${rgb},.4)`;
    pattern.appendChild(svgEl("line", { x1:0, y1:spacing/2, x2:spacing, y2:spacing/2, stroke, "stroke-width":0.6 }));
    if(garden.meta.pattern === "lattice"){
      pattern.appendChild(svgEl("line", { x1:spacing/2, y1:0, x2:spacing/2, y2:spacing, stroke, "stroke-width":0.6 }));
    }
    defs.appendChild(pattern);
    svg.appendChild(defs);
    svg.appendChild(svgEl("rect", { width:"100%", height:"100%", fill:"url(#fieldPattern)" }));
  }

  applyViewToggles(); // re-apply since renderSeedSlots() just rebuilt the label spans
}

/* ---- tag bank ---- */
const tagBankEl = document.getElementById("tagBank");
const tagCountLabel = document.getElementById("tagCountLabel");
function renderTagBank(){
  tagBankEl.innerHTML = "";
  // bank tags first, in fixed order
  for(const t of TAG_BANK){
    const chosen = garden.meta.tags.includes(t);
    const b = document.createElement("button");
    b.type = "button"; b.className = "tag"; b.textContent = t;
    b.setAttribute("data-selected", chosen ? "true" : "false");
    b.disabled = !chosen && garden.meta.tags.length >= MAX_TAGS;
    b.addEventListener("click", () => toggleTag(t));
    tagBankEl.appendChild(b);
  }
  // then any custom (typed-in) tags — these aren't in TAG_BANK, so they need
  // their own chips or they'd be stored in state but never shown.
  for(const t of garden.meta.tags){
    if(TAG_BANK.includes(t)) continue;
    const b = document.createElement("button");
    b.type = "button"; b.className = "tag"; b.textContent = t;
    b.setAttribute("data-selected", "true");
    b.addEventListener("click", () => toggleTag(t));
    tagBankEl.appendChild(b);
  }
  tagCountLabel.textContent = `(${garden.meta.tags.length}/${MAX_TAGS})`;
  renderTagDisplay();
}

/* top-center readout of the chosen tags — mirrors the bank, glows the
   garden's seed color on hover. */
const tagDisplayEl = document.getElementById("tagDisplay");
function renderTagDisplay(){
  tagDisplayEl.innerHTML = "";
  for(const t of garden.meta.tags){
    const s = document.createElement("span");
    s.textContent = t;
    s.style.setProperty("--glow", garden.meta.colors.seed);
    tagDisplayEl.appendChild(s);
  }
}

function toggleTag(t){
  const i = garden.meta.tags.indexOf(t);
  if(i>=0) garden.meta.tags.splice(i,1);
  else if(garden.meta.tags.length < MAX_TAGS) garden.meta.tags.push(t);
  renderTagBank();
  syncMeta();
}
document.getElementById("tagCustomBtn").addEventListener("click", () => {
  const input = document.getElementById("tagCustomInput");
  const v = input.value.trim().toLowerCase();
  if(!v || garden.meta.tags.length >= MAX_TAGS || garden.meta.tags.includes(v)) return;
  garden.meta.tags.push(v);
  input.value = "";
  renderTagBank();
  syncMeta();
});

/* ---- colors ---- */
const cBg1 = document.getElementById("cBg1"), cBg2 = document.getElementById("cBg2");
const cText = document.getElementById("cText"), cSeed = document.getElementById("cSeed");
function applyColors(){
  garden.meta.colors = { background:[cBg1.value, cBg2.value], text:cText.value, seed:cSeed.value };
  renderField();
  syncMeta();
}
[cBg1,cBg2,cText,cSeed].forEach(el => el.addEventListener("input", applyColors));

/* ---- scale slider ---- */
const fieldScale = document.getElementById("fieldScale");
const fieldScaleLabel = document.getElementById("fieldScaleLabel");
fieldScale.addEventListener("input", () => {
  garden.meta.scale = parseFloat(fieldScale.value);
  fieldScaleLabel.textContent = garden.meta.scale.toFixed(1) + "×";
  renderField();
  syncMeta();
});

/* ---- pattern picker ---- */
const patternBankEl = document.getElementById("patternBank");
function renderPatternBank(){
  patternBankEl.innerHTML = "";
  for(const p of PATTERNS){
    const b = document.createElement("button");
    b.type = "button"; b.className = "patternbtn"; b.textContent = p.label;
    b.setAttribute("data-selected", garden.meta.pattern === p.id ? "true" : "false");
    b.addEventListener("click", () => {
      garden.meta.pattern = p.id;
      renderPatternBank();
      renderField();
      syncMeta();
    });
    patternBankEl.appendChild(b);
  }
}

renderTagBank();
renderPatternBank();

/* ---- bottom toggle bar: seeds / plants / roots / labels visibility ---- */
const VIEW_STATE = { seeds:true, plants:true, labels:true, roots:true };
function applyViewToggles(){
  document.getElementById("seedSlots").style.display = VIEW_STATE.seeds ? "" : "none";
  document.getElementById("plantSlots").style.display = VIEW_STATE.plants ? "" : "none";
  document.getElementById("connectionsLayer").style.display = VIEW_STATE.roots ? "" : "none";
  document.querySelectorAll("#seedSlots .txt, #plantSlots .txt")
    .forEach(el => el.style.display = VIEW_STATE.labels ? "" : "none");
}
// shared by the bottom-bar buttons themselves and anything else that wants
// to flip one of these (a filled seed's click uses this same function for
// "roots" — same mechanism, not a separate parallel toggle)
function toggleView(key){
  VIEW_STATE[key] = !VIEW_STATE[key];
  document.querySelectorAll(`#viewToggles button[data-key="${key}"]`)
    .forEach(b => b.setAttribute("data-on", String(VIEW_STATE[key])));
  applyViewToggles();
}
document.querySelectorAll("#viewToggles button").forEach(b => {
  b.setAttribute("data-on", "true");
  b.addEventListener("click", () => toggleView(b.dataset.key));
});

const viewportEl = document.getElementById("viewport");
const fieldEl = document.getElementById("field");
fieldEl.style.width = FIELD_W + "px";
fieldEl.style.height = FIELD_H + "px";

// these local defaults only matter for whoever connects to this garden's
// shared channel first ever — connectChannels() below immediately overwrites
// garden.meta with whatever's already synced for everyone else on this URL.
randomizeDefaultColors();
applyColors();

/* ---- arrow-key / arrow-pad panning, same idea as the main garden view ---- */
function panBy(dx, dy){
  viewportEl.scrollBy({ left:dx, top:dy, behavior:"smooth" });
  // ambient sound follows you even when you're navigating by keyboard/pad,
  // not just when the mouse itself is moving over the field
  listener.x = Math.max(0, Math.min(FIELD_W, listener.x + dx));
  listener.y = Math.max(0, Math.min(FIELD_H, listener.y + dy));
}
document.getElementById("panUp").addEventListener("click", () => panBy(0,-STEP));
document.getElementById("panDown").addEventListener("click", () => panBy(0,STEP));
document.getElementById("panLeft").addEventListener("click", () => panBy(-STEP,0));
document.getElementById("panRight").addEventListener("click", () => panBy(STEP,0));

document.addEventListener("keydown", e => {
  const typing = /input|textarea/i.test(e.target.tagName) || e.target.isContentEditable;
  if(typing || plantScrim.classList.contains("open") || seedScrim.classList.contains("open") || document.getElementById("confirmScrim").classList.contains("open") || document.getElementById("entryScrim").classList.contains("open")) return;
  const move = { ArrowLeft:[-STEP,0], ArrowRight:[STEP,0], ArrowUp:[0,-STEP], ArrowDown:[0,STEP] }[e.key];
  if(move){ e.preventDefault(); panBy(move[0], move[1]); }
});

// Escape closes whatever's open — works even while typing in one of these
// panels' own fields, unlike the arrow-key panning guard above.
document.addEventListener("keydown", e => {
  if(e.key !== "Escape") return;
  if(document.getElementById("confirmScrim").classList.contains("open")){ hideConfirmDialog(false); return; }
  document.getElementById("entryScrim").classList.remove("open");
  hideBuilder(); hidePlantModal(); hideSeedModal(); hideSeedList();
});

// the click (or Escape) that dismisses this is also what satisfies the
// browser's autoplay-gesture requirement, so updateAmbientAudio()'s
// eventual audio.play() calls are actually allowed to produce sound
document.getElementById("enterBtn").addEventListener("click", () => {
  document.getElementById("entryScrim").classList.remove("open");
});

// start centered on the field, like the main garden view does — deferred a
// frame so the viewport has actually been laid out before we measure it
requestAnimationFrame(() => {
  viewportEl.scrollTo({ left: FIELD_W/2 - viewportEl.clientWidth/2, top: FIELD_H/2 - viewportEl.clientHeight/2 });
});

/* ---- create garden ---- */
// a namespace for this garden's uploaded files (see uploadSeedFile's
// X-Garden-Id header) — does not decide which synced room a visitor joins,
// see connectChannels below. Derived from the page's own path rather than a
// random id per load, so every visitor to the same garden page uploads into
// the same stable folder (and re-uploading to a slot correctly overwrites
// the old file there, instead of leaving it orphaned under a new random id).
garden.id = location.pathname.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "garden";

const builderCardEl = document.getElementById("builderCard");
// declared here (not down by the click listener below) because hideBuilder()
// is called immediately, and showBuilder()/hideBuilder() both reference this
// button to show whether the panel is open — same TDZ trap as before if this
// were declared any later.
const navToggleBtn = document.getElementById("navToggleBtn");

/* ---- modal exclusivity: opening either one always closes the other ----
   the swirl button itself shows pressed (inverted) while the panel is open —
   it's the only way to open or close it now, so that state has to be obvious. */
function showBuilder(){ hidePlantModal(); hideSeedModal(); hideSeedList(); builderCardEl.style.display = ""; navToggleBtn.setAttribute("data-open", "true"); }
function hideBuilder(){ builderCardEl.style.display = "none"; navToggleBtn.setAttribute("data-open", "false"); }

// closed by default for every visitor — opened only via the nav swirl icon
hideBuilder();

/* ---- nav stack (icon-only): toggle the builder window ---- */
navToggleBtn.addEventListener("click", () => {
  const hidden = builderCardEl.style.display === "none";
  if(hidden) showBuilder(); else hideBuilder();
});

/* ==========================================================================
   PLAYHTML — plants and garden meta (colors/tags/pattern/scale) sync live
   across everyone who has the link, via Page Data (one JSON blob per
   channel), plus always-on cursor presence.

   LIMITATION: playhtml syncs JSON only. A plant's audioRef is a `blob:` URL,
   valid only in the browser tab that uploaded it, unless UPLOAD_ENDPOINT is
   configured — without it, a plant's metadata syncs to every visitor but the
   audio itself is only playable by whoever planted it.

   `cursors: { enabled: true }` is required — `cursors: {}` leaves the cursor
   client disabled.
   ========================================================================== */
// init() returns a promise; createPageData() (inside connectChannels) isn't
// usable until it resolves, so this has to chain off .then().
playhtml.init({ cursors: { enabled: true } }).then(connectChannels);

/* live visitor count — window.cursors.allColors is playhtml's own list of
   currently-connected players in this room; .length is "here right now".
   It isn't available the instant init() returns (the cursor room connects
   async), so poll briefly until it exists, then just listen. */
const visitorCountText = document.getElementById("visitorCountText");
function renderVisitorCount(){
  const n = window.cursors ? window.cursors.allColors.length : 1;
  visitorCountText.textContent = `${n} here now`;
}
(function waitForCursors(){
  if(window.cursors){
    renderVisitorCount();
    window.cursors.on("allColors", renderVisitorCount);
  } else {
    setTimeout(waitForCursors, 200);
  }
})();

/* connect once, immediately on load — guarded so a stray repeat call is a
   no-op. Channel names are fixed (not per-visitor garden.id) so every
   visitor on this same URL joins the same synced documents, exactly like
   playhtml's cursor room does by default (scoped to location.pathname +
   search). garden.id is only ever used to namespace uploaded files. */
function connectChannels(){
  if(plantSlotsChannel) return;

  plantSlotsChannel = playhtml.createPageData("garden-plants", garden.plants);
  garden.plants = plantSlotsChannel.getData();
  renderPlantSlots();   // draw whatever was already planted by anyone — the
                        // only render calls before this point ran with the
                        // empty local default, since this pull is async
  plantSlotsChannel.onUpdate(data => { garden.plants = data; renderPlantSlots(); });

  // colors/tags/pattern/scale. Whole-object/array replacement is fine here —
  // it's only *index* assignment into a top-level array that playhtml's
  // Page Data rejects, and meta is a plain object throughout.
  metaChannel = playhtml.createPageData("garden-meta", garden.meta);
  garden.meta = metaChannel.getData();
  applyMetaToUI();
  metaChannel.onUpdate(data => { garden.meta = data; applyMetaToUI(); });

  seedsChannel = playhtml.createPageData("garden-seeds", garden.seeds);
  garden.seeds = seedsChannel.getData();
  onSeedsChanged();
  seedsChannel.onUpdate(data => { garden.seeds = data; onSeedsChanged(); });
}

/* re-renders everywhere seed title/artist text shows up: the field markers
   themselves, the seed-list panel, and the plant modal's "sampled from"
   options — kept in one place so nothing can drift out of sync. */
function onSeedsChanged(){
  renderSeedSlots();
  renderSeedList();
  renderSampledFromBank();
  renderConnections();
}

/* pushes garden.meta as a whole to everyone else in the room */
function syncMeta(){ metaChannel?.setData(draft => Object.assign(draft, garden.meta)); }

/* the reverse of applyColors()/etc — takes garden.meta (just replaced by an
   incoming sync, or restored on connect) and pushes it into the actual
   inputs + re-renders, instead of reading the inputs to build garden.meta. */
function applyMetaToUI(){
  cBg1.value = garden.meta.colors.background[0];
  cBg2.value = garden.meta.colors.background[1];
  cSeed.value = garden.meta.colors.seed;
  cText.value = garden.meta.colors.text;
  fieldScale.value = garden.meta.scale;
  fieldScaleLabel.textContent = garden.meta.scale.toFixed(1) + "×";
  renderTagBank();
  renderPatternBank();
  renderField();
}

/* streams a file straight to the Worker, which writes it into R2 and hands
   back the public URL. Throws on any failure — the caller decides what to
   fall back to (see the plant save handler). */
async function uploadSeedFile(file, key){
  if(!UPLOAD_ENDPOINT) throw new Error("UPLOAD_ENDPOINT not configured");
  const res = await fetch(`${UPLOAD_ENDPOINT}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Garden-Id": garden.id,
      "X-Slot-Index": String(key),
      "X-File-Name": file.name,
    },
    body: file,
  });
  if(!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { url } = await res.json();
  return url;
}

/* ==========================================================================
   PLANTING — a plant carries a small freehand drawing and gets placed
   wherever the user clicked on the field. Hovering an empty patch of ground
   shows a square outline; clicking it opens this modal with that spot
   pre-filled as the plant's position.
   ========================================================================== */
const plantScrim = document.getElementById("plantScrim");
const pSub = document.getElementById("pSub");
const pFile = document.getElementById("pFile");
const pFileLabel = document.getElementById("pFileLabel");
const pFileLabelText = document.getElementById("pFileLabelText");
const pSampledFromBank = document.getElementById("pSampledFromBank");
const pCanvas = document.getElementById("pCanvas");
const pClearCanvas = document.getElementById("pClearCanvas");
const pName = document.getElementById("pName");
const pSaveBtn = document.getElementById("pSaveBtn");
const pDeleteBtn = document.getElementById("pDeleteBtn");
const pCancelBtn = document.getElementById("pCancelBtn");
const hoverSquare = document.getElementById("hoverSquare");
const cursorPulse = document.getElementById("cursorPulse");

const localPlantAudioRefs = {};
const localSeedAudioRefs = {};
// keyed by plant id, not a per-marker closure variable — a pin-toggle click
// re-renders the whole plant layer (fresh DOM node, fresh closure) before a
// second click could ever land, so timing has to survive that rebuild
const lastPlantClickTimes = {};

/* pinning is local/per-visitor only — deliberately never synced via
   playhtml, so each person decides for themselves which plants keep
   playing continuously. Keyed by plant id (not stored on the synced plant
   object itself), so it survives renderPlantSlots() rebuilding the DOM on
   every position sync from other visitors. */
const pinnedPlantIds = new Set();

/* plants whose Audio element exists but hasn't fired "canplay" yet — local
   UI state only, same reasoning as pinnedPlantIds. Drives the "loading"
   class in renderPlantSlots(), which reuses a seed's own empty-slot
   pulsing-gradient CSS. */
const loadingPlantIds = new Set();

/* ambient wandering sound: every plant's volume is a function of how far
   the "listener" (wherever the cursor is, or wherever arrow-key panning has
   taken you) currently is from it — recomputed continuously in
   updateAmbientAudio() below, not gated by hovering any one element.
   Multiple nearby plants can be audible at once (the "layering"), and each
   one's volume glides toward its target every frame instead of snapping
   (the "decay" as you wander away). */
const listener = { x: CX, y: CY };
const AUDIBLE_RADIUS = 400;   // beyond this a plant is silent, unless pinned
const MAX_VOICES = 6;         // only the closest N (plus any pinned) actually play at once
const PIN_VOLUME = 0.8;       // floor volume for a pinned plant, regardless of distance
const STICK_MS = 4000;        // how long a plant keeps playing at its last volume after you leave range, before it starts fading
const VOLUME_LERP = 0.08;     // how fast volume glides toward its target each frame, once fading (0-1, higher = snappier)

// currently-playing plant audio, keyed by plant id — survives re-renders
// for the same reason pinnedPlantIds does, which is what lets a sound keep
// fading/playing uninterrupted while someone else drags that plant around.
const activePlantAudio = {};

const smoothstep = t => t*t*(3-2*t);
function volumeForDistance(dist){
  return dist >= AUDIBLE_RADIUS ? 0 : smoothstep(1 - dist/AUDIBLE_RADIUS);
}

/* pitch follows vertical position on the field: one octave higher at the
   very top, one octave lower at the very bottom, unchanged at dead center.
   playbackRate shifts pitch and tempo together — the simplest native way
   to do this without building a real Web Audio pitch-shifting graph. */
function pitchForY(y){
  return Math.pow(2, (FIELD_H/2 - y) / (FIELD_H/2));
}

// creates a plant's Audio element once, starting silent — updateAmbientAudio
// fades it in by raising targetVolume, so play() only ever happens here,
// never repeatedly on every little hover in and out
function ensurePlantAudio(p){
  if(activePlantAudio[p.id]) return;
  const ref = p.audioRef || localPlantAudioRefs[p.id];
  if(!ref) return;
  const audioEl = new Audio(ref);
  audioEl.loop = true;
  audioEl.volume = 0;
  audioEl.playbackRate = pitchForY(p.y);
  loadingPlantIds.add(p.id);
  renderPlantSlots();
  const stopLoading = () => { if(loadingPlantIds.delete(p.id)) renderPlantSlots(); };
  audioEl.addEventListener("canplay", stopLoading, { once: true });
  audioEl.addEventListener("error", stopLoading, { once: true });
  audioEl.play().catch(() => {});
  activePlantAudio[p.id] = { audioEl, currentVolume: 0, targetVolume: 0, leftRangeAt: null };
}
function stopPlantAudio(id){
  const entry = activePlantAudio[id];
  if(!entry) return;
  entry.audioEl.pause();
  delete activePlantAudio[id];
  loadingPlantIds.delete(id);
}

/* the one continuous audio update — recomputes every plant's distance from
   the listener, decides who's audible (the closest MAX_VOICES within
   range, plus anything pinned), and glides each one's volume toward its
   target every frame instead of snapping. A plant you've wandered away
   from doesn't start fading immediately — it sticks at its last volume
   for STICK_MS, then decays, and only gets torn down once it's actually
   silent, instead of tearing down and re-fetching on every back-and-forth. */
function updateAmbientAudio(){
  const now = performance.now();
  const plants = Object.values(garden.plants || {});
  for(const p of plants) p._dist = Math.hypot(p.x - listener.x, p.y - listener.y);

  const inRange = plants.filter(p => p._dist < AUDIBLE_RADIUS).sort((a,b) => a._dist - b._dist);
  const desired = new Set(inRange.slice(0, MAX_VOICES).map(p => p.id));
  for(const id of pinnedPlantIds) desired.add(id);

  for(const p of plants){
    if(!desired.has(p.id)) continue;
    ensurePlantAudio(p);
    const entry = activePlantAudio[p.id];
    if(!entry) continue;
    // in range (or pinned) — live volume, and reset the stick timer since
    // it's not "away" anymore
    entry.targetVolume = Math.max(volumeForDistance(p._dist), pinnedPlantIds.has(p.id) ? PIN_VOLUME : 0);
    entry.leftRangeAt = null;
  }
  for(const id in activePlantAudio){
    const entry = activePlantAudio[id];
    if(desired.has(id)) continue;
    if(entry.leftRangeAt == null) entry.leftRangeAt = now;   // just left range this frame
    if(now - entry.leftRangeAt >= STICK_MS) entry.targetVolume = 0;   // stuck long enough — now decay
    // else: still within the stick window — leave targetVolume alone, holding at its last value
  }
  let totalVolume = 0;
  for(const id in activePlantAudio){
    const entry = activePlantAudio[id];
    entry.currentVolume += (entry.targetVolume - entry.currentVolume) * VOLUME_LERP;
    entry.audioEl.volume = Math.max(0, Math.min(1, entry.currentVolume));
    totalVolume += entry.currentVolume;
    const p = garden.plants[id];
    if(p) entry.audioEl.playbackRate = pitchForY(p.y);
    if(!desired.has(id) && entry.targetVolume === 0 && entry.currentVolume < 0.01){
      stopPlantAudio(id);
    }
  }

  // rings at the listener's own position, more visible/intense the more is
  // currently audible nearby — a felt sense of "getting louder here"
  cursorPulse.style.left = listener.x + "px";
  cursorPulse.style.top = listener.y + "px";
  cursorPulse.style.setProperty("--pulse-intensity", Math.min(1.5, totalVolume).toFixed(3));
  cursorPulse.style.setProperty("--pulse-color", garden.meta.colors.text);

  requestAnimationFrame(updateAmbientAudio);
}
requestAnimationFrame(updateAmbientAudio);
let plantDraftFile = null;
let pendingPlantPos = null;
let editingPlantId = null;   // null while planting new — set to a plant's id while editing it
let selectedSampledFrom = [];   // "title - artist" strings, multi-select chips — see renderSampledFromBank
// no color picker anymore — a new plant's drawing color is always the
// inverse of the garden's current seed color; editing an existing plant
// keeps whatever color it already has, so old and new strokes still match
let plantDraftColor = "#000000";

const pctx = pCanvas.getContext("2d");
// butt cap/miter join (canvas defaults) instead of round — jagged edges,
// no smoothing, matching the field's SVG polylines exactly
pctx.lineWidth = 1.5; pctx.lineCap = "butt"; pctx.lineJoin = "miter";
let drawing = false;
// the canvas is just live drawing feedback in the modal — what actually gets
// saved/rendered on the map is the raw stroke points themselves (see
// renderPlantSlots), as SVG polylines, so the marker is the drawing itself
// instead of a rasterized square thumbnail.
let plantDraftPaths = [];
let currentStroke = null;
function canvasPos(e){
  const r = pCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
pCanvas.addEventListener("pointerdown", e => {
  drawing = true;
  const p = canvasPos(e);
  currentStroke = [p];
  plantDraftPaths.push(currentStroke);
  pctx.beginPath(); pctx.moveTo(p.x, p.y);
});
pCanvas.addEventListener("pointermove", e => {
  if(!drawing) return;
  const p = canvasPos(e);
  currentStroke.push(p);
  pctx.lineTo(p.x, p.y); pctx.stroke();
});
window.addEventListener("pointerup", () => { drawing = false; validatePlant(); });
pClearCanvas.addEventListener("click", () => {
  pctx.clearRect(0, 0, pCanvas.width, pCanvas.height);
  plantDraftPaths = [];
  validatePlant();
});

pFile.addEventListener("change", () => {
  plantDraftFile = pFile.files[0] || null;
  pFileLabelText.textContent = plantDraftFile ? plantDraftFile.name : "choose audio file…";
  pFileLabel.classList.toggle("has-file", !!plantDraftFile);
  validatePlant();
});
pFileLabel.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); pFile.click(); } });

pName.addEventListener("input", validatePlant);
function validatePlant(){
  // a drawing is required now — no plant without one, so there's never a
  // plain colored box on the map, only ever the drawing itself. A new
  // audio file is only required when planting new — editing can keep
  // whatever audio was already there.
  const needsFile = !editingPlantId;
  pSaveBtn.disabled = (needsFile && !plantDraftFile) || !pName.value.trim() || !plantDraftPaths.length;
}

function redrawPaths(paths){
  pctx.clearRect(0, 0, pCanvas.width, pCanvas.height);
  for(const stroke of paths){
    if(stroke.length < 2) continue;
    pctx.beginPath();
    pctx.moveTo(stroke[0].x, stroke[0].y);
    for(const pt of stroke.slice(1)) pctx.lineTo(pt.x, pt.y);
    pctx.stroke();
  }
}

/* "sampled from" options are just every filled seed's "title - artist"
   text, doubling as the option's own value — reused as-is in both the
   plant modal and the seed-list panel (see renderSeedList). */
/* chip multi-select, same look/interaction as the "feels like" tag bank —
   one chip per filled seed, toggled on/off, tracked in selectedSampledFrom. */
function renderSampledFromBank(){
  pSampledFromBank.innerHTML = "";
  const seeds = Object.values(garden.seeds || {});
  if(!seeds.length){
    const empty = document.createElement("span");
    empty.className = "sub";
    empty.style.margin = "0";
    empty.textContent = "no seeds planted yet";
    pSampledFromBank.appendChild(empty);
    return;
  }
  for(const seed of seeds){
    const label = `${seed.title} - ${seed.artist}`;
    const b = document.createElement("button");
    b.type = "button"; b.className = "tag"; b.textContent = label;
    b.setAttribute("data-selected", selectedSampledFrom.includes(label) ? "true" : "false");
    b.addEventListener("click", () => toggleSampledFrom(label));
    pSampledFromBank.appendChild(b);
  }
}
function toggleSampledFrom(label){
  const i = selectedSampledFrom.indexOf(label);
  if(i >= 0) selectedSampledFrom.splice(i, 1);
  else selectedSampledFrom.push(label);
  renderSampledFromBank();
}

function openPlantModal(pos){
  editingPlantId = null;
  pSub.textContent = "plant your own sound mixed from the seedlist, and watch it grow next to others.";
  pSaveBtn.textContent = "plant";
  pendingPlantPos = pos || { x: CX, y: CY };
  plantDraftFile = null;
  pFile.value = ""; pFileLabelText.textContent = "choose audio file…"; pFileLabel.classList.remove("has-file");
  pName.value = ""; pctx.clearRect(0, 0, pCanvas.width, pCanvas.height); plantDraftPaths = [];
  plantDraftColor = invertHex(garden.meta.colors.seed); pctx.strokeStyle = plantDraftColor;
  pDeleteBtn.style.display = "none";
  selectedSampledFrom = [];
  renderSampledFromBank();
  validatePlant();
  hideBuilder(); hideSeedModal(); hideSeedList();
  plantScrim.classList.add("open");
}

/* editing reuses the same modal — pre-filled with the plant's current
   name/drawing, position unchanged. A new audio file is optional; leaving
   it blank keeps what was already there (see pSaveBtn below). */
function openPlantEditModal(p){
  editingPlantId = p.id;
  pSub.textContent = "edit this planting.";
  pSaveBtn.textContent = "save";
  pendingPlantPos = { x: p.x, y: p.y };
  plantDraftFile = null;
  pFile.value = ""; pFileLabelText.textContent = "choose audio file… (keeps current if left blank)"; pFileLabel.classList.remove("has-file");
  pName.value = p.name;
  plantDraftColor = p.color; pctx.strokeStyle = p.color;
  plantDraftPaths = p.paths.map(stroke => stroke.map(pt => ({ ...pt })));
  redrawPaths(plantDraftPaths);
  // backward-compat: sampledFrom used to be a single string before this
  // became a multi-select
  selectedSampledFrom = Array.isArray(p.sampledFrom) ? p.sampledFrom.slice() : (p.sampledFrom ? [p.sampledFrom] : []);
  renderSampledFromBank();
  pDeleteBtn.style.display = "";
  validatePlant();
  hideBuilder(); hideSeedModal(); hideSeedList();
  plantScrim.classList.add("open");
}
function hidePlantModal(){ plantScrim?.classList.remove("open"); editingPlantId = null; }
pCancelBtn.addEventListener("click", hidePlantModal);

pDeleteBtn.addEventListener("click", () => {
  if(!editingPlantId) return;
  const id = editingPlantId;
  delete garden.plants[id];
  plantSlotsChannel?.setData(draft => { delete draft[id]; });
  renderPlantSlots();
  hidePlantModal();
});

pSaveBtn.addEventListener("click", async () => {
  const isEdit = !!editingPlantId;
  pSaveBtn.disabled = true; pSaveBtn.textContent = isEdit ? "saving…" : "planting…";
  const plantId = editingPlantId || newId();
  const existing = garden.plants[plantId];

  let audioRef = existing?.audioRef;
  if(plantDraftFile){
    audioRef = await uploadSeedFile(plantDraftFile, `plant-${plantId}`).catch(err => {
      console.warn("plant upload failed, falling back to a local-only blob URL:", err);
      return URL.createObjectURL(plantDraftFile);
    });
    localPlantAudioRefs[plantId] = audioRef;
  }

  const plant = {
    id: plantId, name: pName.value.trim(), audioRef,
    sampledFrom: selectedSampledFrom.slice(),
    paths: plantDraftPaths, color: plantDraftColor,
    x: pendingPlantPos.x, y: pendingPlantPos.y,
  };
  garden.plants[plantId] = plant;
  plantSlotsChannel?.setData(draft => { draft[plantId] = plant; });
  renderPlantSlots();
  hidePlantModal();
  pSaveBtn.disabled = false; pSaveBtn.textContent = "plant";
});

/* ==========================================================================
   SEEDS — clicking an empty seed slot lets you name/upload a sound for it.
   A filled slot just shows "title - artist" and previews on hover; there's
   no re-editing a seed once it's set, unlike plants.
   ========================================================================== */
const seedScrim = document.getElementById("seedScrim");
const sTitle = document.getElementById("sTitle");
const sArtist = document.getElementById("sArtist");
const sFile = document.getElementById("sFile");
const sFileLabel = document.getElementById("sFileLabel");
const sFileLabelText = document.getElementById("sFileLabelText");
const sSaveBtn = document.getElementById("sSaveBtn");
const sCancelBtn = document.getElementById("sCancelBtn");

let seedDraftFile = null;
let pendingSeedSlot = null;

function validateSeed(){
  sSaveBtn.disabled = !seedDraftFile || !sTitle.value.trim() || !sArtist.value.trim();
}
sTitle.addEventListener("input", validateSeed);
sArtist.addEventListener("input", validateSeed);
sFile.addEventListener("change", () => {
  seedDraftFile = sFile.files[0] || null;
  sFileLabelText.textContent = seedDraftFile ? seedDraftFile.name : "choose audio file…";
  sFileLabel.classList.toggle("has-file", !!seedDraftFile);
  validateSeed();
});
sFileLabel.addEventListener("keydown", e => { if(e.key==="Enter"||e.key===" "){ e.preventDefault(); sFile.click(); } });

function openSeedModal(slotIndex){
  pendingSeedSlot = slotIndex;
  seedDraftFile = null;
  sTitle.value = ""; sArtist.value = "";
  sFile.value = ""; sFileLabelText.textContent = "choose audio file…"; sFileLabel.classList.remove("has-file");
  validateSeed();
  hideBuilder(); hidePlantModal(); hideSeedList();
  seedScrim.classList.add("open");
}
function hideSeedModal(){ seedScrim?.classList.remove("open"); }
sCancelBtn.addEventListener("click", hideSeedModal);

/* generic yes/no confirmation — resolves true if the user confirms, false
   if they cancel/Escape/click away. One shared modal, re-used for every
   confirmation in the app rather than a bespoke dialog per action. */
const confirmScrim = document.getElementById("confirmScrim");
const confirmMsg = document.getElementById("confirmMsg");
const confirmOkBtn = document.getElementById("confirmOkBtn");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
let resolveConfirm = null;
function confirmDialog(message){
  confirmMsg.textContent = message;
  confirmScrim.classList.add("open");
  return new Promise(resolve => { resolveConfirm = resolve; });
}
function hideConfirmDialog(result){
  confirmScrim.classList.remove("open");
  if(resolveConfirm){ resolveConfirm(result); resolveConfirm = null; }
}
confirmOkBtn.addEventListener("click", () => hideConfirmDialog(true));
confirmCancelBtn.addEventListener("click", () => hideConfirmDialog(false));

sSaveBtn.addEventListener("click", async () => {
  sSaveBtn.disabled = true; sSaveBtn.textContent = "adding…";
  const slot = pendingSeedSlot;
  const audioRef = await uploadSeedFile(seedDraftFile, `seed-${slot}`).catch(err => {
    console.warn("seed upload failed, falling back to a local-only blob URL:", err);
    return URL.createObjectURL(seedDraftFile);
  });
  localSeedAudioRefs[slot] = audioRef;
  const seed = { title: sTitle.value.trim(), artist: sArtist.value.trim(), audioRef };
  garden.seeds[slot] = seed;
  seedsChannel?.setData(draft => { draft[slot] = seed; });
  onSeedsChanged();
  hideSeedModal();
  sSaveBtn.disabled = false; sSaveBtn.textContent = "add seed";
});

/* the seed-list panel — every seed added so far, each with a download link */
const seedListCardEl = document.getElementById("seedListCard");
const seedListToggleBtn = document.getElementById("seedListToggleBtn");
function showSeedList(){ hideBuilder(); hidePlantModal(); hideSeedModal(); seedListCardEl.style.display = ""; seedListToggleBtn.setAttribute("data-open", "true"); }
function hideSeedList(){ seedListCardEl.style.display = "none"; seedListToggleBtn.setAttribute("data-open", "false"); }
hideSeedList();
seedListToggleBtn.addEventListener("click", () => {
  const hidden = seedListCardEl.style.display === "none";
  if(hidden) showSeedList(); else hideSeedList();
});

function renderSeedList(){
  const list = document.getElementById("seedListItems");
  list.innerHTML = "";
  const seeds = Object.values(garden.seeds || {});
  if(!seeds.length){
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.style.margin = "0";
    empty.textContent = "no seeds yet — click an empty seed on the field to add one.";
    list.appendChild(empty);
    return;
  }
  for(const [i, seed] of Object.entries(garden.seeds || {})){
    const row = document.createElement("div");
    row.className = "seedlistitem";
    const label = document.createElement("span");
    label.textContent = `${seed.title} - ${seed.artist}`;
    const dl = document.createElement("a");
    dl.href = seed.audioRef; dl.download = `${seed.title} - ${seed.artist}`; dl.textContent = "⇩";
    const del = document.createElement("button");
    del.type = "button"; del.className = "seedlistdelete"; del.textContent = "🗑";
    del.title = "delete this seed";
    del.addEventListener("click", async () => {
      const ok = await confirmDialog(`delete "${seed.title} - ${seed.artist}"? this can't be undone.`);
      if(!ok) return;
      delete garden.seeds[i];
      seedsChannel?.setData(draft => { delete draft[i]; });
      onSeedsChanged();
    });
    row.appendChild(label); row.appendChild(dl); row.appendChild(del);
    list.appendChild(row);
  }
}

/* planting is only allowed on a hot spot — a fixed grid spread evenly across
   the field, unrelated to the decorative seed markers (those are clickable
   some other way, not this). A spot with a plant in it already is excluded,
   so hovering/clicking an existing plant never offers it as a target. */
const HOTSPOT_COLS = 15, HOTSPOT_ROWS = 8, HOTSPOT_MARGIN = 150;
function hotSpotPositions(){
  const usableW = FIELD_W - HOTSPOT_MARGIN * 2, usableH = FIELD_H - HOTSPOT_MARGIN * 2;
  const spots = [];
  for(let row = 0; row < HOTSPOT_ROWS; row++){
    for(let col = 0; col < HOTSPOT_COLS; col++){
      spots.push({
        x: HOTSPOT_MARGIN + (usableW * col) / (HOTSPOT_COLS - 1),
        y: HOTSPOT_MARGIN + (usableH * row) / (HOTSPOT_ROWS - 1),
      });
    }
  }
  return spots;
}

// half of the hover square's 140x140 footprint (matches .hoversquare/
// .plantmark/pCanvas) — a square hit test, not a circular radius, so the
// square appears/disappears exactly at its own visible edge, not some
// smaller invisible area inside it.
const HOTSPOT_HALF = 70;
/* a plant's *actual* rendered box (drawing + its name label, which sits to
   the right and can extend well past the 140px drawing itself for a longer
   name) — measured live rather than assumed, so a "plant here" square never
   lands on top of a long label's overflow. */
function occupiedBoxes(){
  const fieldRect = fieldEl.getBoundingClientRect();
  return Array.from(document.querySelectorAll("#plantSlots .plantmark")).map(m => {
    // .plantmark's own rect stops at 140x140 even though its name label is
    // an absolutely-positioned child sitting outside that box (to the
    // right) — an overflowing absolutely-positioned child never enlarges
    // its ancestor's own bounding rect, so the label has to be measured
    // separately and unioned in, or a long name's overflow goes unprotected
    const markRect = m.getBoundingClientRect();
    const txtEl = m.querySelector(".txt");
    const txtRect = txtEl ? txtEl.getBoundingClientRect() : markRect;
    const left = Math.min(markRect.left, txtRect.left), right = Math.max(markRect.right, txtRect.right);
    const top = Math.min(markRect.top, txtRect.top), bottom = Math.max(markRect.bottom, txtRect.bottom);
    return {
      left: left - fieldRect.left, right: right - fieldRect.left,
      top: top - fieldRect.top, bottom: bottom - fieldRect.top,
    };
  });
}
// same idea as occupiedBoxes above, but for seed slots — a hot spot whose
// square would cover a seed's own clickable area (dot + label) is skipped,
// so hovering near a seed always reads as "click the seed", never "plant
// here". Unlike occupiedBoxes this is a box-vs-square overlap test rather
// than a point-in-box test, since a seed's dot is much smaller than a hot
// spot's 140x140 square and a point test would almost never catch it.
function seedOccupiedBoxes(){
  const fieldRect = fieldEl.getBoundingClientRect();
  return Array.from(document.querySelectorAll("#seedSlots .seedslot")).map(m => {
    const dotRect = m.getBoundingClientRect();
    const txtEl = m.querySelector(".txt");
    const txtRect = txtEl ? txtEl.getBoundingClientRect() : dotRect;
    const left = Math.min(dotRect.left, txtRect.left), right = Math.max(dotRect.right, txtRect.right);
    const top = Math.min(dotRect.top, txtRect.top), bottom = Math.max(dotRect.bottom, txtRect.bottom);
    return {
      left: left - fieldRect.left, right: right - fieldRect.left,
      top: top - fieldRect.top, bottom: bottom - fieldRect.top,
    };
  });
}
function nearestHotSpot(x, y){
  const boxes = occupiedBoxes();
  const seedBoxes = seedOccupiedBoxes();
  let best = null, bestDist = Infinity;
  for(const s of hotSpotPositions()){
    // a hot spot inside an existing plant's real rendered box (drawing +
    // label) is never offered — being near a plant means dragging it, not
    // planting a new one on top of it
    if(boxes.some(b => s.x >= b.left && s.x <= b.right && s.y >= b.top && s.y <= b.bottom)) continue;
    const sqLeft = s.x - HOTSPOT_HALF, sqRight = s.x + HOTSPOT_HALF, sqTop = s.y - HOTSPOT_HALF, sqBottom = s.y + HOTSPOT_HALF;
    if(seedBoxes.some(b => sqLeft < b.right && sqRight > b.left && sqTop < b.bottom && sqBottom > b.top)) continue;
    if(Math.abs(x - s.x) > HOTSPOT_HALF || Math.abs(y - s.y) > HOTSPOT_HALF) continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if(d < bestDist){ bestDist = d; best = s; }
  }
  return best;
}

const NO_SEEDS_MSG = "you can’t plant just yet! add at least one seed as the source before other plants can grow";
fieldEl.addEventListener("mousemove", e => {
  const r = fieldEl.getBoundingClientRect();
  // ambient sound's "listener" position — same field-space coordinates as
  // a plant's own x/y, so distance comparisons in updateAmbientAudio() just work
  listener.x = e.clientX - r.left;
  listener.y = e.clientY - r.top;
  const spot = nearestHotSpot(e.clientX - r.left, e.clientY - r.top);
  if(!spot){ hoverSquare.style.display = "none"; fieldEl.style.cursor = ""; fieldEl.title = ""; return; }
  const hasSeeds = Object.keys(garden.seeds || {}).length > 0;
  hoverSquare.style.left = spot.x + "px";
  hoverSquare.style.top = spot.y + "px";
  hoverSquare.style.borderColor = garden.meta.colors.seed;
  hoverSquare.style.display = "block";
  fieldEl.style.cursor = hasSeeds ? "" : "not-allowed";
  fieldEl.title = hasSeeds ? "" : NO_SEEDS_MSG;
});
fieldEl.addEventListener("mouseleave", () => { hoverSquare.style.display = "none"; fieldEl.style.cursor = ""; fieldEl.title = ""; });
fieldEl.addEventListener("click", e => {
  const r = fieldEl.getBoundingClientRect();
  const spot = nearestHotSpot(e.clientX - r.left, e.clientY - r.top);
  if(!spot) return;   // clicking away from a hot spot does nothing now
  if(!Object.keys(garden.seeds || {}).length) return;   // can't plant until at least one seed exists
  openPlantModal(spot);
});

// connectChannels() runs async (after playhtml.init resolves) and re-renders
// on its own once the real synced data arrives — these are just the
// unsynced first paint using local defaults.
renderSeedSlots();
renderPlantSlots();
renderSeedList();
renderSampledFromBank();
