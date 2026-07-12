/* ==========================================================================
   SETUP / GLOBAL — mirrors mood.css "global style"
   ========================================================================== */

import { playhtml } from "https://unpkg.com/playhtml";

const TAG_BANK = ["sunny","ambient","delicious","rainy","fuzzy","low bpm","lush","blooming","squishy","pop"];
// the deployed Worker (upload-worker/worker.js) that streams uploads into R2
const UPLOAD_ENDPOINT = "https://sound-garden-uploads.renxchristiane.workers.dev";
const MAX_TAGS = 3;
const PATTERNS = [
  { id:"lattice", label:"lattice" },   
  { id:"array",   label:"array" },    
  { id:"furrow",  label:"furrow" },    
];

const FIELD_W = 2400, FIELD_H = 1600;   
const STEP = 95;
const PLANT_MARGIN_LEFT = 70;
const PLANT_MARGIN_RIGHT = 280;
const PLANT_MARGIN_Y = 70;

const garden = {
  id: null,
  meta: {
    tags: [],
    colors: {
      background: ["#3AB704", "#E2FFCB"],  
      seed: "#FFD8B6",                      
      text: "#FFFFFF",                      
    },
    pattern: "lattice",     
    scale: 1,                 
  },
  plants: {},   // plantId -> { id, name, audioRef, sampledFrom, paths, color, x, y }
  seeds: {},    // slot index (string "0".."9") 
};

let plantSlotsChannel = null;
let metaChannel = null;
let tagPressChannel = null;
let seedsChannel = null;

// random id per browser session for playthml unique clicks (not 2 distinct user ids) 
function newId(len=8){
  return crypto.randomUUID ? crypto.randomUUID().slice(0,len) : Math.random().toString(36).slice(2,2+len);
}

const clientId = newId();

// hex "#rrggbb" -> "r,g,b" so seed color can be used at low opacity for field pattern 
function hexToRgb(hex){
  const m = hex.replace("#","").match(/.{2}/g).map(h => parseInt(h,16));
  return m.join(",");
}

// color inversion - used mostly on seed color 
function invertHex(hex){
  const [r,g,b] = hex.replace("#","").match(/.{2}/g).map(h => parseInt(h,16));
  const toHex = n => (255-n).toString(16).padStart(2,"0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const randInt = (min,max) => Math.floor(Math.random()*(max-min+1))+min;

// hsl -> hex, so random defaults can be constrained to complementary saturation/lightness instead of random RGB 
function hsl2hex(h, s, l){
  s/=100; l/=100;
  const k = n => (n + h/30) % 12;
  const a = s * Math.min(l, 1-l);
  const f = n => l - a*Math.max(-1, Math.min(k(n)-3, Math.min(9-k(n), 1)));
  const toHex = n => Math.round(255*f(n)).toString(16).padStart(2,"0");
  return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
}

// saturated seed color, sky->soil gradient, labels contrast against sky, random field pattern and scale 
function randomizeDefaults(){
  const bgHue = randInt(0,359);
  const seedHue = (bgHue + 180 + randInt(-40,40) + 360) % 360; 
  const skyLightness = randInt(35,45);
  cBg1.value = hsl2hex(bgHue, randInt(55,75), skyLightness);
  cBg2.value = hsl2hex((bgHue + randInt(-15,15) + 360) % 360, randInt(30,50), randInt(85,92));
  cSeed.value = hsl2hex(seedHue, randInt(65,85), randInt(55,70));
  cText.value = skyLightness < 50 ? "#FFFFFF" : "#000000";

  garden.meta.pattern = PATTERNS[randInt(0, PATTERNS.length - 1)].id;

  const scaleMin = parseFloat(fieldScale.min), scaleMax = parseFloat(fieldScale.max), scaleStep = parseFloat(fieldScale.step);
  const scale = Math.round((scaleMin + randInt(0, Math.round((scaleMax - scaleMin) / scaleStep)) * scaleStep) * 10) / 10;
  garden.meta.scale = scale;
  fieldScale.value = scale;
  fieldScaleLabel.textContent = scale.toFixed(1) + "×";
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

/* ---- create garden ---- */
// a namespace for this garden's uploaded files (see uploadSeedFile's
// X-Garden-Id header) — does not decide which synced room a visitor joins,
// see connectChannels below. Derived from the page's own path AND query
// string (not just pathname) rather than a random id per load, so every
// visitor to the same garden page uploads into the same stable folder
// (and re-uploading to a slot correctly overwrites the old file there,
// instead of leaving it orphaned under a new random id) — the query
// string has to be included now that ?g=<id> is what actually
// distinguishes one garden from another; pathname alone would put every
// garden's uploads in the same folder and overwrite across gardens.
garden.id = (location.pathname + location.search).replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "garden";

/* ==========================================================================
   GARDEN / FIELD — mirrors mood.css "garden"
   ========================================================================== */


// seed slots — one fixed layout per pattern 
const CX = FIELD_W/2, CY = FIELD_H/2;
const SEED_COLS = [-600,-300,0,300,600];

const LATTICE_ROWS = [
  { dy:-300, xs:[-500, 0, 500] },
  { dy:0,    xs:[-625, -210, 210, 625] },
  { dy:300,  xs:[-500, 0, 500] },
];
const SEED_SLOTS_BASE = {
  lattice: LATTICE_ROWS.flatMap(row => row.xs.map(dx => ({ dx, dy:row.dy }))),
  furrow: SEED_COLS.flatMap((dx, col) => {
    const extra = col % 2 === 1 ? 130 : 0;
    return [{dx,dy:-130+extra}, {dx,dy:130+extra}];
  }),
};
function arraySlotOffsets(scale){
  return Array.from({length:10}, (_,i) => {
    const t = 1 + i*0.9, r = 52*t*scale;
    return { dx:r*Math.cos(t), dy:r*Math.sin(t) };
  });
}

function seedFieldOffsets(){
  const scale = garden.meta.scale || 1;
  return garden.meta.pattern === "array"
    ? arraySlotOffsets(scale)
    : SEED_SLOTS_BASE[garden.meta.pattern].map(o => ({ dx:o.dx*scale, dy:o.dy*scale }));
}

// svg pattern and background sized to full field rather viewport only 
function renderField(){
  const { background, text, seed } = garden.meta.colors;
  const fieldEl = document.getElementById("field");
  fieldEl.style.background = `linear-gradient(to bottom, ${background[0]}, ${background[1]})`; // sky -> soil
  fieldEl.style.color = text;
  const volumeMeterEl = document.getElementById("volumeMeter");
  volumeMeterEl.style.setProperty("--glow", seed);
  volumeMeterEl.style.setProperty("--soil-color", background[1]);
  renderSeedSlots();
  renderPlantSlots();

  const svg = document.getElementById("patternLayer");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${FIELD_W} ${FIELD_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const rgb = hexToRgb(seed);

  const scale = garden.meta.scale || 1;
  const LATTICE_BASE = 104;   
  const FURROW_BASE = 26;     

  if(garden.meta.pattern === "array"){
    const maxR = Math.hypot(FIELD_W, FIELD_H)/2 + 60;
    const a = 16 * scale;      // spiral pitch — distance between successive arms
    const dotGap = 10 * scale; // arc-length distance between dots 
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

  applyViewToggles(); 
}

const viewportEl = document.getElementById("viewport");
const fieldEl = document.getElementById("field");
fieldEl.style.width = FIELD_W + "px";
fieldEl.style.height = FIELD_H + "px";

// arrow-key wander 
function panBy(dx, dy){
  viewportEl.scrollBy({ left:dx, top:dy, behavior:"smooth" });
  listener.x = Math.max(0, Math.min(FIELD_W, listener.x + dx));
  listener.y = Math.max(0, Math.min(FIELD_H, listener.y + dy));
}

document.addEventListener("keydown", e => {
  const typing = /input|textarea/i.test(e.target.tagName) || e.target.isContentEditable;
  if(typing || plantScrim.classList.contains("open") || seedScrim.classList.contains("open") || document.getElementById("confirmScrim").classList.contains("open") || document.getElementById("entryScrim").classList.contains("open")) return;
  const move = { ArrowLeft:[-STEP,0], ArrowRight:[STEP,0], ArrowUp:[0,-STEP], ArrowDown:[0,STEP] }[e.key];
  if(move){ e.preventDefault(); panBy(move[0], move[1]); }
});

requestAnimationFrame(() => {
  viewportEl.scrollTo({ left: FIELD_W/2 - viewportEl.clientWidth/2, top: FIELD_H/2 - viewportEl.clientHeight/2 });
});

/* ==========================================================================
   HOT SOIL SPOTS — mirrors mood.css "hot soil spots"
   ========================================================================== */

// one plant her hot spot - exclude seed areas or live plant areas as targets 
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

const HOTSPOT_HALF = 70;

function occupiedBoxes(){
  const fieldRect = fieldEl.getBoundingClientRect();
  return Array.from(document.querySelectorAll("#plantSlots .plantmark")).map(m => {
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
    if(boxes.some(b => s.x >= b.left && s.x <= b.right && s.y >= b.top && s.y <= b.bottom)) continue;
    const sqLeft = s.x - HOTSPOT_HALF, sqRight = s.x + HOTSPOT_HALF, sqTop = s.y - HOTSPOT_HALF, sqBottom = s.y + HOTSPOT_HALF;
    if(seedBoxes.some(b => sqLeft < b.right && sqRight > b.left && sqTop < b.bottom && sqBottom > b.top)) continue;
    if(Math.abs(x - s.x) > HOTSPOT_HALF || Math.abs(y - s.y) > HOTSPOT_HALF) continue;
    const d = Math.hypot(x - s.x, y - s.y);
    if(d < bestDist){ bestDist = d; best = s; }
  }
  return best;
}

const NO_SEEDS_MSG = "you can’t plant yet! add at least one seed (a source sound) before you can grow something here.";
fieldEl.addEventListener("mousemove", e => {
  const r = fieldEl.getBoundingClientRect();
  // listener position 
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
  if(!Object.keys(garden.seeds || {}).length) return;   
  openPlantModal(spot);
});

/* ==========================================================================
   TOP LEFT — NAV BUTTONS — mirrors mood.css "top left - nav buttons"
   ========================================================================== */

const builderCardEl = document.getElementById("builderCard");
const navToggleBtn = document.getElementById("navToggleBtn");

// opening one modal closes the other open modal 
function showBuilder(){ hidePlantModal(); hideSeedModal(); hideSeedList(); hideGardenInfo(); builderCardEl.style.display = ""; navToggleBtn.setAttribute("data-open", "true"); }
function hideBuilder(){ builderCardEl.style.display = "none"; navToggleBtn.setAttribute("data-open", "false"); }

// closed by default 
hideBuilder();

navToggleBtn.addEventListener("click", () => {
  const hidden = builderCardEl.style.display === "none";
  if(hidden) showBuilder(); else hideBuilder();
});

const seedListCardEl = document.getElementById("seedListCard");
const seedListToggleBtn = document.getElementById("seedListToggleBtn");
function showSeedList(){ hideBuilder(); hidePlantModal(); hideSeedModal(); hideGardenInfo(); seedListCardEl.style.display = ""; seedListToggleBtn.setAttribute("data-open", "true"); }
function hideSeedList(){ seedListCardEl.style.display = "none"; seedListToggleBtn.setAttribute("data-open", "false"); }
hideSeedList();
seedListToggleBtn.addEventListener("click", () => {
  const hidden = seedListCardEl.style.display === "none";
  if(hidden) showSeedList(); else hideSeedList();
});

/* ==========================================================================
   TOP CENTER — CLICKABLE TAGS — mirrors mood.css "top center - clickable tags"
   ========================================================================== */

// top center tags — mirrors the bank, glows seed color on hover, easter egg click (see checkTagPresses)
const tagDisplayEl = document.getElementById("tagDisplay");
function renderTagDisplay(){
  tagDisplayEl.innerHTML = "";
  for(const t of garden.meta.tags){
    const s = document.createElement("span");
    s.textContent = t;
    s.title = "click here with a friend ˚Ი⑅𐑼˖";   
    s.style.setProperty("--glow", garden.meta.colors.seed);
    s.addEventListener("click", () => pressTag(t));
    tagDisplayEl.appendChild(s);
  }
}

// soundcloud easter egg
const TAG_PRESS_WINDOW_MS = 2000;
function pressTag(t){
  tagPressChannel?.setData(draft => {
    draft[`${t}:${clientId}`] = Date.now();
  });
}
function checkTagPresses(data){
  const now = Date.now();
  const clientIdsByTag = {};
  for(const key in data){
    const sep = key.lastIndexOf(":");
    const t = key.slice(0, sep), cid = key.slice(sep + 1);
    if(now - data[key] >= TAG_PRESS_WINDOW_MS) continue;
    (clientIdsByTag[t] ??= new Set()).add(cid);
  }
  for(const t in clientIdsByTag){
    if(clientIdsByTag[t].size >= 2){
      window.open(`https://soundcloud.com/tags/${encodeURIComponent(t)}`, "_blank", "noopener");
      return;
    }
  }
}

/* ==========================================================================
   BOTTOM LEFT — TOGGLE BAR — mirrors mood.css "bottom left - toggle bar"
   ========================================================================== */

// bottom left toggles: seeds / plants / roots / labels 
const VIEW_STATE = { seeds:true, plants:true, labels:true, roots:true };
function applyViewToggles(){
  document.getElementById("seedSlots").style.display = VIEW_STATE.seeds ? "" : "none";
  document.getElementById("plantSlots").style.display = VIEW_STATE.plants ? "" : "none";
  document.getElementById("connectionsLayer").style.display = VIEW_STATE.roots ? "" : "none";
  document.querySelectorAll("#seedSlots .txt, #plantSlots .txt")
    .forEach(el => el.style.display = VIEW_STATE.labels ? "" : "none");
}

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

/* ==========================================================================
   SEED SLOTS — mirrors mood.css "seed slots"
   ========================================================================== */

// empty slot -> click to open add-seed modal, filled slot shows "title - artist" -> click to open seed list
function renderSeedSlots(){
  const layer = document.getElementById("seedSlots");
  layer.innerHTML = "";
  seedFieldOffsets().forEach((o, i) => {
    const seed = garden.seeds[i];
    const el = document.createElement("div");
    el.className = "seedslot" + (seed ? "" : " empty");
    el.style.left = (CX + o.dx) + "px"; el.style.top = (CY + o.dy) + "px";
    el.style.color = garden.meta.colors.text;
    // planted seed glows seed color on hover, empty slot glows inverted color
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
        // hovering on seed shows roots 
        document.getElementById("connectionsLayer").style.display = "";
      });
      el.addEventListener("mouseleave", () => {
        applyViewToggles();
      });
      // click to open seed list panel 
      el.addEventListener("click", e => { e.stopPropagation(); showSeedList(); });
    } else {
      // stopPropagation ignores plant hotspots when clicking on seed
      el.addEventListener("click", e => { e.stopPropagation(); openSeedModal(i); });
    }
    layer.appendChild(el);
  });
}

/* ==========================================================================
   ROOTS — mirrors mood.css "roots"
   ========================================================================== */

// roots are dashed curved lines
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
      // root connects on the plant dot, not at the drawing's center 
      const dotEl = document.querySelector(`#plantSlots .plantmark[data-plant-id="${p.id}"] .labeldot`);
      const dotRect = dotEl?.getBoundingClientRect();
      const toX = dotRect?.width ? dotRect.left + dotRect.width/2 - fieldRect.left : p.x;
      const toY = dotRect?.width ? dotRect.top + dotRect.height/2 - fieldRect.top : p.y;
      const dx = toX - from.x, dy = toY - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = 40;
      const midX = (from.x + toX) / 2 - (dy / len) * bow;
      const midY = (from.y + toY) / 2 + (dx / len) * bow;

      // gradient from the seed dot color to plants dot color
      const gradientId = `rootGradient-${gradientCount++}`;
      const gradient = document.createElementNS(SVG_NS, "linearGradient");
      gradient.setAttribute("id", gradientId);
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      gradient.setAttribute("x1", from.x); gradient.setAttribute("y1", from.y);
      gradient.setAttribute("x2", toX); gradient.setAttribute("y2", toY);
      const stop1 = document.createElementNS(SVG_NS, "stop");
      stop1.setAttribute("offset", "0%"); stop1.setAttribute("stop-color", garden.meta.colors.seed);
      const stop2 = document.createElementNS(SVG_NS, "stop");
      stop2.setAttribute("offset", "100%"); stop2.setAttribute("stop-color", invertHex(garden.meta.colors.seed));
      gradient.appendChild(stop1); gradient.appendChild(stop2);
      defs.appendChild(gradient);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M ${from.x} ${from.y} Q ${midX} ${midY} ${toX} ${toY}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", `url(#${gradientId})`);
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-dasharray", "0.1 3");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    }
  }
}

/* ==========================================================================
   PLANT SLOTS — mirrors mood.css "plant slots"
   ========================================================================== */

function renderPlantSlots(){
  const layer = document.getElementById("plantSlots");
  layer.innerHTML = "";
  Object.values(garden.plants || {}).forEach(p => {
    const el = document.createElement("div");
    // pinned is local-only 
    el.className = "plantmark" + (pinnedPlantIds.has(p.id) ? " pinned" : "");
    el.dataset.plantId = p.id;   // lets renderConnections find this plant's own labeldot
    el.style.left = p.x + "px"; el.style.top = p.y + "px";
    const dotColor = invertHex(garden.meta.colors.seed);
    el.style.setProperty("--glow", garden.meta.colors.seed);
    el.style.setProperty("--dot-color", dotColor);
    el.style.setProperty("--seed-color", garden.meta.colors.seed);
    el.style.setProperty("--text-color", garden.meta.colors.text);
    el.style.setProperty("--soil-color", garden.meta.colors.background[1]);
    el.style.setProperty("--sky-color", garden.meta.colors.background[0]);

    // plant drawing
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

    // inverse of the current seed color 
    const labelDot = document.createElement("span");
    labelDot.className = "labeldot";
    labelDot.style.background = invertHex(garden.meta.colors.seed);
    el.appendChild(labelDot);

    // label for plants is name of gardener
    const label = document.createElement("span");
    label.className = "txt";
    label.textContent = p.name;
    label.style.color = garden.meta.colors.text;
    el.appendChild(label);

 
    el.addEventListener("click", e => e.stopPropagation()); 

    // drag to reposition 
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
        // keep the drawing and label to stay within bounds on the field
        p.x = Math.max(PLANT_MARGIN_LEFT, Math.min(FIELD_W - PLANT_MARGIN_RIGHT, origX + dx));
        p.y = Math.max(PLANT_MARGIN_Y, Math.min(FIELD_H - PLANT_MARGIN_Y, origY + dy));
        el.style.left = p.x + "px"; el.style.top = p.y + "px";
        renderConnections();
      }
      function onUp(){
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if(moved){
          // position is shared state (affecting pitch for everyone)
          garden.plants[p.id] = p;
          plantSlotsChannel?.setData(draft => { draft[p.id] = p; });
        } else if(Date.now() - (lastPlantClickTimes[p.id] || 0) < 350){
          lastPlantClickTimes[p.id] = 0;
          openPlantEditModal(p);
        } else {
          lastPlantClickTimes[p.id] = Date.now();
          // pin/unpin is local-only 
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

/* ==========================================================================
   MODAL / LOADING SCRIM — mirrors mood.css "loading scrim" + "modal styling"
   ========================================================================== */

// esc closes an open modal 
document.addEventListener("keydown", e => {
  if(e.key !== "Escape") return;
  if(document.getElementById("confirmScrim").classList.contains("open")){ hideConfirmDialog(false); return; }
  document.getElementById("entryScrim").classList.remove("open");
  hideBuilder(); hidePlantModal(); hideSeedModal(); hideSeedList(); hideGardenInfo();
});

// the click to enter satisfies browser requirement for autoplaying sound
document.getElementById("enterBtn").addEventListener("click", () => {
  document.getElementById("entryScrim").classList.remove("open");
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
//
// room is only passed explicitly when ?g=<id> is actually present. playhtml's
// own default (confirmed by inspecting window.playhtml.roomId at runtime) is
// origin + pathname ONLY, with the .html extension stripped and the query
// string dropped entirely — that's what silently let every ?g= value share
// one room before. But that native default is also where THE ORIGINAL
// garden (no ?g= at all) has always actually lived — passing an explicit
// room unconditionally would point the bare URL at a brand-new empty room
// instead of that real one, orphaning it exactly the way the file rename
// once did. So: no ?g= -> no room override, keep using playhtml's real
// default; ?g=<id> present -> use garden.id (pathname + search, sanitized)
// so each numbered garden actually gets its own separate room.
const gardenParam = new URLSearchParams(location.search).get("g");
playhtml.init({
  ...(gardenParam ? { room: garden.id } : {}),
  cursors: { enabled: true },
}).then(connectChannels);

// fallback so a slow/broken connection doesn't block the page forever —
// if connectChannels() never even ran, preloadGardenAudio() never got a
// chance to enable this either, so it's done here instead
setTimeout(() => {
  const enterBtn = document.getElementById("enterBtn");
  enterBtn.disabled = false;
  enterBtn.textContent = "feel the grass";
}, 6000);

/* preloads every seed/plant sound into the browser's HTTP cache while the
   entry gate is up (see connectChannels), so wandering in right after
   clicking through doesn't make the first pass near any plant wait on it —
   ensurePlantAudio()/the seed list's play button fetch the exact same URL
   again later, which the browser then just serves from cache instantly.
   enterBtn stays disabled until everything's loaded (or ENTRY_PRELOAD_TIMEOUT_MS
   gives up waiting on a slow/broken file, rather than blocking forever). */
const ENTRY_PRELOAD_TIMEOUT_MS = 8000;
function preloadGardenAudio(){
  // {label, ref} instead of bare URLs, so a failed one can be reported by
  // name — see the console.warn in finish() below, the one place to spot a
  // dead sound (broken URL, stale blob: ref, etc.) without hunting for it
  const items = [
    ...Object.values(garden.plants || {}).map(p => ({ label:`plant "${p.name}"`, ref:p.audioRef })),
    ...Object.values(garden.seeds || {}).map(s => ({ label:`seed "${s.title} - ${s.artist}"`, ref:s.audioRef })),
  ].filter(item => item.ref);

  const bar = document.getElementById("entryProgressBar");
  const enterBtn = document.getElementById("enterBtn");
  const failed = [];

  let done = false;
  const finish = () => {
    if(done) return;
    done = true;
    bar.style.width = "100%";
    enterBtn.disabled = false;
    enterBtn.textContent = "feel the grass";
    if(failed.length){
      console.warn(`sound garden: ${failed.length} dead sound(s) — audio that never loaded:`,
        failed.map(item => `${item.label}: ${item.ref}`));
    }
  };

  if(items.length === 0){ finish(); return; }

  let loaded = 0;
  const bump = () => {
    loaded++;
    bar.style.width = Math.round((loaded / items.length) * 100) + "%";
    if(loaded >= items.length) finish();
  };
  for(const item of items){
    const a = new Audio();
    a.preload = "auto";
    a.addEventListener("canplaythrough", bump, { once:true });
    a.addEventListener("error", () => { failed.push(item); bump(); }, { once:true });   // don't let one bad file block everything else
    a.src = item.ref;
  }
  setTimeout(finish, ENTRY_PRELOAD_TIMEOUT_MS);
}

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

  // tag-press easter egg — see checkTagPresses above
  tagPressChannel = playhtml.createPageData("tag-presses", {});
  tagPressChannel.onUpdate(checkTagPresses);

  seedsChannel = playhtml.createPageData("garden-seeds", garden.seeds);
  garden.seeds = seedsChannel.getData();
  onSeedsChanged();
  seedsChannel.onUpdate(data => { garden.seeds = data; onSeedsChanged(); });

  preloadGardenAudio();
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

/* ==========================================================================
   SEASON SETTINGS + SEED LIST — mirrors mood.css "season settings + seed list" + "tags" + "colors" + "field pattern picker" + "scale slider"
   ========================================================================== */

/* ---- tag bank ---- */
const tagBankEl = document.getElementById("tagBank");
const tagCountLabel = document.getElementById("tagCountLabel");
function renderTagBank(){
  tagBankEl.innerHTML = "";
  // bank tags first
  for(const t of TAG_BANK){
    const chosen = garden.meta.tags.includes(t);
    const b = document.createElement("button");
    b.type = "button"; b.className = "tag"; b.textContent = t;
    b.setAttribute("data-selected", chosen ? "true" : "false");
    b.disabled = !chosen && garden.meta.tags.length >= MAX_TAGS;
    b.addEventListener("click", () => toggleTag(t));
    tagBankEl.appendChild(b);
  }
  // custom tag chips are created as user inputs
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

// colors - sky, soil, seed, label
const cBg1 = document.getElementById("cBg1"), cBg2 = document.getElementById("cBg2");
const cText = document.getElementById("cText"), cSeed = document.getElementById("cSeed");
function applyColors(){
  garden.meta.colors = { background:[cBg1.value, cBg2.value], text:cText.value, seed:cSeed.value };
  renderField();
  syncMeta();
}
[cBg1,cBg2,cText,cSeed].forEach(el => el.addEventListener("input", applyColors));

// field pattern scale slider
const fieldScale = document.getElementById("fieldScale");
const fieldScaleLabel = document.getElementById("fieldScaleLabel");
fieldScale.addEventListener("input", () => {
  garden.meta.scale = parseFloat(fieldScale.value);
  fieldScaleLabel.textContent = garden.meta.scale.toFixed(1) + "×";
  renderField();
  syncMeta();
});

// field pattern picker
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
randomizeDefaults();
renderPatternBank();   
applyColors();

// play seed preview automatically stops other preview
let seedListPlaying = null;  
function stopSeedListPreview(){
  if(!seedListPlaying) return;
  seedListPlaying.audioEl.pause();
  seedListPlaying.btn.textContent = "▶";
  seedListPlaying.progress.style.width = "0%";
  seedListPlaying = null;
}

function renderSeedList(){
  stopSeedListPreview();   
  const list = document.getElementById("seedListItems");
  list.innerHTML = "";
  const seeds = Object.values(garden.seeds || {});
  if(!seeds.length){
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.style.margin = "0";
    empty.textContent = "no seeds yet ~ click an empty seed on the field to add one.";
    list.appendChild(empty);
    return;
  }
  for(const [i, seed] of Object.entries(garden.seeds || {})){
    const row = document.createElement("div");
    row.className = "seedlistitem";
    const progress = document.createElement("div");
    progress.className = "seedlistprogress";
    const label = document.createElement("span");
    label.textContent = `${seed.title} - ${seed.artist}`;
    const play = document.createElement("button");
    play.type = "button"; play.className = "seedlistplay"; play.textContent = "▶";
    play.addEventListener("click", () => {
      const wasThisOne = seedListPlaying?.btn === play;
      stopSeedListPreview();
      if(wasThisOne) return;   
      const audioEl = new Audio(seed.audioRef);
      audioEl.addEventListener("timeupdate", () => {
        if(audioEl.duration) progress.style.width = (audioEl.currentTime / audioEl.duration * 100) + "%";
      });
      audioEl.addEventListener("ended", () => { if(seedListPlaying?.audioEl === audioEl) stopSeedListPreview(); });
      audioEl.play().catch(() => {});
      play.textContent = "⏸";
      seedListPlaying = { audioEl, btn: play, progress };
    });
    const dl = document.createElement("a");
    const seedKey = new URL(seed.audioRef).pathname.replace(/^\//, "");
    dl.href = `${UPLOAD_ENDPOINT}/download/${seedKey}`;
    dl.download = `${seed.title} - ${seed.artist}`;
    dl.textContent = "⤓";
    const del = document.createElement("button");
    del.type = "button"; del.className = "seedlistdelete"; del.textContent = "✕";
    del.addEventListener("click", async () => {
      const ok = await confirmDialog(`delete "${seed.title} - ${seed.artist}"? this can't be undone.`);
      if(!ok) return;
      deleteR2File(seed.audioRef);
      delete garden.seeds[i];
      seedsChannel?.setData(draft => { delete draft[i]; });
      onSeedsChanged();
    });
    row.appendChild(progress); row.appendChild(play); row.appendChild(label); row.appendChild(dl); row.appendChild(del);
    list.appendChild(row);
  }
}

/* ==========================================================================
   VISITOR INFO — mirrors mood.css "visitor info"
   ========================================================================== */

const gardenInfoCardEl = document.getElementById("gardenInfoCard");
const visitorCountBtn = document.getElementById("visitorCountBtn");
const gardenUrlInput = document.getElementById("gardenUrl");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const newGardenBtn = document.getElementById("newGardenBtn");
function showGardenInfo(){
  hideBuilder(); hidePlantModal(); hideSeedModal(); hideSeedList();
  const names = [...new Set(Object.values(garden.plants || {}).map(p => p.name).filter(Boolean))];
  document.getElementById("plantedByNames").textContent = names.length ? names.join(", ") : "no one yet";
  // plants don't hold date data other than latest plant for visitor info panel
  const timestamps = Object.values(garden.plants || {}).map(p => p.plantedAt).filter(Boolean);
  const lastPlanted = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  document.getElementById("lastPlantedDate").textContent = lastPlanted
    ? lastPlanted.toLocaleDateString(undefined, { year:"numeric", month:"long", day:"numeric" })
    : "not yet";
  gardenUrlInput.value = location.href;
  gardenInfoCardEl.style.display = "";
}
function hideGardenInfo(){ gardenInfoCardEl.style.display = "none"; }
hideGardenInfo();
visitorCountBtn.addEventListener("click", () => {
  const hidden = gardenInfoCardEl.style.display === "none";
  if(hidden) showGardenInfo(); else hideGardenInfo();
});
copyUrlBtn.addEventListener("click", async () => {
  const label = copyUrlBtn.textContent;
  let copied = true;
  try {
    await navigator.clipboard.writeText(gardenUrlInput.value);
  } catch {
    copied = false;
    gardenUrlInput.select();
  }
  copyUrlBtn.textContent = copied ? "copied!" : "press ⌘C";
  setTimeout(() => { copyUrlBtn.textContent = label; }, 1500);
});

// new "garden" is location.pathname + location.search — playhtml default room scoping — id from Worker's atomic counter (GardenCounter, see upload-worker/worker.js) 
const newGardenLabel = newGardenBtn?.textContent;
newGardenBtn?.addEventListener("click", async () => {
  newGardenBtn.disabled = true;
  newGardenBtn.textContent = "planting a new one…";
  try {
    const res = await fetch(`${UPLOAD_ENDPOINT}/next-garden-id`, { method: "POST" });
    if(!res.ok) throw new Error(`next-garden-id failed: ${res.status}`);
    const { id } = await res.json();
    location.href = `${location.pathname}?g=${id}`;
  } catch(err) {
    console.warn("couldn't allocate a new garden id:", err);
    newGardenBtn.disabled = false;
    newGardenBtn.textContent = "couldn't start one — try again";
    setTimeout(() => { newGardenBtn.textContent = newGardenLabel; }, 2500);
  }
});

/* ==========================================================================
   FILE LABEL / PLANT DRAWING SPACE — mirrors mood.css "file label" + "plant drawing space"
   PLUS ambient audio, cursor trail, volume meter threshold logic live here (not under their own matching CSS sections)
   ========================================================================== */

// streams a file straight to the Worker, which writes it into R2 and hands back public URL
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

async function deleteR2File(audioRef){
  if(!UPLOAD_ENDPOINT || !audioRef || audioRef.startsWith("blob:")) return;
  const key = new URL(audioRef).pathname.replace(/^\//, "");
  fetch(`${UPLOAD_ENDPOINT}/delete/${key}`, { method: "DELETE" }).catch(() => {});
}

/* ==========================================================================
   SEEDS 
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
  hideBuilder(); hidePlantModal(); hideSeedList(); hideGardenInfo();
  seedScrim.classList.add("open");
}
function hideSeedModal(){ seedScrim?.classList.remove("open"); }
sCancelBtn.addEventListener("click", hideSeedModal);

// generic yes/no confirmation used for all dialogs
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
  const audioRef = await uploadSeedFile(seedDraftFile, `seeds/${slot}`).catch(err => {
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

/* ==========================================================================
   PLANT
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

/* ambient wandering sound: every plant's volume is a function of how far
   the "listener" (wherever the cursor is, or wherever arrow-key panning has
   taken you) currently is from it — recomputed continuously in
   updateAmbientAudio() below, not gated by hovering any one element.
   Multiple nearby plants can be audible at once (the "layering"), and each
   one's volume glides toward its target every frame instead of snapping
   (the "decay" as you wander away). */
const listener = { x: CX, y: CY };

/* the listener position only ever moves on a real mousemove/pan — if the
   user clicks away to another tab or app, those events just stop firing
   and everything would otherwise keep playing forever at whatever volume
   it happened to be at. windowFocused gates the final volume in
   updateAmbientAudio() so leaving actually fades everything to silence,
   instead of freezing in place. */
let windowFocused = true;
window.addEventListener("blur", () => { windowFocused = false; });
window.addEventListener("focus", () => { windowFocused = true; });

const AUDIBLE_RADIUS = 400;   // beyond this a plant is silent, unless pinned
const MAX_VOICES = 6;         // only the closest N (plus any pinned) actually play at once
const PIN_VOLUME = 0.8;       // floor volume for a pinned plant, regardless of distance
const STICK_MS = 3000;        // how long a plant keeps playing at its last volume after you leave range, before it starts fading
const DECAY_MS = 3500;        // once fading, how long the eased trail-off takes to reach silence
const VOLUME_LERP = 0.08;     // how fast volume glides toward its target each frame (0-1, higher = snappier)
// ease-in cubic: barely drops at first, then falls away faster — a plant
// that had already built up volume holds onto most of it a while longer
// before curving down, instead of decaying at a constant rate the whole way
const decayEase = t => t*t*t;

/* a faint footprint dropped every so often you actually move (mouse or
   keyboard/arrow-pad panning both update listener.x/y, so both leave a
   trail) — checked once per frame in updateAmbientAudio(), same as
   everything else audio-related, even though this part is purely visual. */
let lastTrailX = listener.x, lastTrailY = listener.y;
const TRAIL_MIN_DIST = 30;      // spawn a new footprint every ~this many px of movement
const TRAIL_LIFETIME_MS = 1800; // how long a footprint takes to fully fade and remove itself
// decorative glyphs matching the site's own title treatment — one is picked
// at random for each footprint instead of a plain dot
const TRAIL_GLYPHS = ["݁˖","˖᯽","જ˚","˚ ༘♡","⋆｡˚","ੈ✩‧","⋆˚❀","༉‧₊"];
function spawnTrailDot(x, y){
  const dot = document.createElement("span");
  dot.className = "traildot";
  dot.textContent = TRAIL_GLYPHS[Math.floor(Math.random() * TRAIL_GLYPHS.length)];
  dot.style.left = x + "px";
  dot.style.top = y + "px";
  // seed color -> sky color, same gradient-text technique as the seed/pinned pulse.
  // background-image (not the "background" shorthand) — the shorthand resets
  // background-clip to its initial value even when unmentioned, which would
  // silently override the class's own background-clip:text rule below.
  dot.style.backgroundImage = `linear-gradient(135deg, ${garden.meta.colors.seed}, ${garden.meta.colors.background[0]})`;
  fieldEl.appendChild(dot);
  setTimeout(() => dot.remove(), TRAIL_LIFETIME_MS);
}

// currently-playing plant audio, keyed by plant id — survives re-renders
// for the same reason pinnedPlantIds does, which is what lets a sound keep
// fading/playing uninterrupted while someone else drags that plant around.
const activePlantAudio = {};

// which plants currently get the .playing pulse class — hovered/in-range,
// still decaying (STICK_MS), or pinned, all read the same currentVolume
// off activePlantAudio, so there's nothing pin-specific to check separately.
// Walks every rendered plantmark (not just activePlantAudio's keys) so a
// class survives renderPlantSlots() rebuilding the DOM out from under it.
// Also clears/restores the label's inline color to match — renderPlantSlots()
// always sets that color inline, and an inline style always beats a
// stylesheet rule, so .plantmark.playing .txt's transparent (for the
// gradient-clip pulse) needs this to actually take effect.
const PLAYING_THRESHOLD = 0.02;
function updatePlayingClasses(){
  for(const mark of document.querySelectorAll("#plantSlots .plantmark")){
    const entry = activePlantAudio[mark.dataset.plantId];
    const playing = !!entry && entry.currentVolume >= PLAYING_THRESHOLD;
    mark.classList.toggle("playing", playing);
    const txt = mark.querySelector(".txt");
    if(txt) txt.style.color = playing ? "" : garden.meta.colors.text;
  }
}

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

/* bottom-right sound level meter — not a control, just a readout of the
   loudest currently-playing voice (0-1), updated every frame alongside
   everything else in updateAmbientAudio(). Bars light up past their own
   threshold, same idea as a classic VU meter. */
const volumeMeterEl = document.getElementById("volumeMeter");
// .bar only — volumeMeterEl also has a .volumemeterhint span as a sibling,
// which .children would include and throw off the index-to-threshold mapping
const volumeMeterBars = Array.from(volumeMeterEl.querySelectorAll(".bar"));
// the last one is 0.99, not 1.0 — currentVolume glides toward its target via
// a lerp (see updateAmbientAudio), which asymptotically approaches but can
// never exactly equal 1.0 in floating point, so a literal 1.0 threshold here
// would leave the top bar permanently unreachable
const VOLUME_METER_THRESHOLDS = [0.063, 0.125, 0.188, 0.25, 0.313, 0.375, 0.438, 0.5, 0.563, 0.625, 0.688, 0.75, 0.813, 0.875, 0.938, 0.99];
function updateVolumeMeter(level){
  volumeMeterBars.forEach((bar, i) => {
    bar.dataset.active = level >= VOLUME_METER_THRESHOLDS[i] ? "true" : "false";
  });
}

/* double-click the meter to teleport to a random OTHER garden — see
   .volumemeterhint in mood.css for the "double-click to teleport" text
   that hints at this. Picks from [1, count] (the Worker's /garden-count
   peek at the same D1 counter "new garden" allocates from — see
   upload-worker/worker.js), excluding whichever garden this already is,
   so it's never a no-op. Not every number in that range is guaranteed to
   still have anything planted in it — the counter only tracks how many
   have ever been created, not which ones stuck around. */
const volumeMeterHintEl = document.querySelector("#volumeMeter .volumemeterhint");
const volumeMeterHintLabel = volumeMeterHintEl?.textContent;
function flashVolumeMeterHint(message){
  if(!volumeMeterHintEl) return;
  volumeMeterHintEl.textContent = message;
  setTimeout(() => { volumeMeterHintEl.textContent = volumeMeterHintLabel; }, 2500);
}
volumeMeterEl.addEventListener("dblclick", async () => {
  const currentGarden = Number(new URLSearchParams(location.search).get("g"));
  let count;
  try {
    const res = await fetch(`${UPLOAD_ENDPOINT}/garden-count`);
    if(!res.ok) throw new Error(`garden-count failed: ${res.status}`);
    ({ count } = await res.json());
  } catch(err) {
    console.warn("couldn't check for other gardens:", err);
    flashVolumeMeterHint("couldn't reach the other gardens ~");
    return;
  }
  const candidates = Array.from({ length: count }, (_, i) => i + 1)
    .filter(id => id !== currentGarden);
  if(!candidates.length){
    flashVolumeMeterHint("no other gardens yet ~");
    return;
  }
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  location.href = `${location.pathname}?g=${chosen}`;
});

// creates a plant's Audio element once, starting silent — updateAmbientAudio
// snaps it straight to its target volume on the first frame (see justArrived
// below), so play() only ever happens here, never repeatedly on every little
// hover in and out
function ensurePlantAudio(p){
  if(activePlantAudio[p.id]) return;
  const ref = p.audioRef || localPlantAudioRefs[p.id];
  if(!ref) return;
  const audioEl = new Audio(ref);
  audioEl.loop = true;
  audioEl.volume = 0;
  audioEl.playbackRate = pitchForY(p.y);
  audioEl.play().catch(() => {});
  activePlantAudio[p.id] = { audioEl, currentVolume: 0, targetVolume: 0, leftRangeAt: null, justArrived: true };
}
function stopPlantAudio(id){
  const entry = activePlantAudio[id];
  if(!entry) return;
  entry.audioEl.pause();
  delete activePlantAudio[id];
}

/* the one continuous audio update — recomputes every plant's distance from
   the listener, decides who's audible (the closest MAX_VOICES within
   range, plus anything pinned), and glides each one's volume toward its
   target every frame instead of snapping. A plant you've wandered away
   from doesn't start fading immediately — it sticks at its last volume for
   STICK_MS, then eases down to silence over DECAY_MS (decayEase), holding
   onto more of its volume for longer instead of decaying at a flat rate —
   and only gets torn down once it's actually silent, instead of tearing
   down and re-fetching on every back-and-forth. */
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
    if(entry.leftRangeAt == null){
      entry.leftRangeAt = now;
      entry.volumeAtLeave = entry.currentVolume;   // snapshot — the curve trails off from here, not from 1
    }
    const sinceLeft = now - entry.leftRangeAt;
    if(sinceLeft < STICK_MS){
      entry.targetVolume = entry.volumeAtLeave;   // still within the stick window — hold
    } else {
      const t = Math.min(1, (sinceLeft - STICK_MS) / DECAY_MS);
      entry.targetVolume = entry.volumeAtLeave * (1 - decayEase(t));
    }
  }
  let loudest = 0;
  for(const id in activePlantAudio){
    const entry = activePlantAudio[id];
    // tabbed/clicked away — fade toward silence regardless of each plant's
    // own real target, without touching that target itself, so proximity
    // and the stick/decay curve just pick back up where they left off the
    // instant focus returns
    const effectiveTarget = windowFocused ? entry.targetVolume : 0;
    if(entry.justArrived){
      // no fade-in — a plant that just came into range (or got pinned)
      // snaps straight to its computed volume on this first frame instead
      // of creeping up via the lerp below, which still governs every
      // frame after this one (moving around in range, leaving, decaying)
      entry.currentVolume = effectiveTarget;
      entry.justArrived = false;
    } else {
      entry.currentVolume += (effectiveTarget - entry.currentVolume) * VOLUME_LERP;
    }
    entry.audioEl.volume = Math.max(0, Math.min(1, entry.currentVolume));
    loudest = Math.max(loudest, entry.currentVolume);
    const p = garden.plants[id];
    if(p) entry.audioEl.playbackRate = pitchForY(p.y);
    if(!desired.has(id) && entry.targetVolume === 0 && entry.currentVolume < 0.01){
      stopPlantAudio(id);
    }
  }
  updateVolumeMeter(loudest);
  updatePlayingClasses();

  // a footprint every so often you actually move, not on every frame
  if(Math.hypot(listener.x - lastTrailX, listener.y - lastTrailY) >= TRAIL_MIN_DIST){
    spawnTrailDot(listener.x, listener.y);
    lastTrailX = listener.x; lastTrailY = listener.y;
  }

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
  hideBuilder(); hideSeedModal(); hideSeedList(); hideGardenInfo();
  plantScrim.classList.add("open");
}

/* editing reuses the same modal — pre-filled with the plant's current
   name/drawing, position unchanged. A new audio file is optional; leaving
   it blank keeps what was already there (see pSaveBtn below). */
function openPlantEditModal(p){
  editingPlantId = p.id;
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
  hideBuilder(); hideSeedModal(); hideSeedList(); hideGardenInfo();
  plantScrim.classList.add("open");
}
function hidePlantModal(){ plantScrim?.classList.remove("open"); editingPlantId = null; }
pCancelBtn.addEventListener("click", hidePlantModal);

pDeleteBtn.addEventListener("click", () => {
  if(!editingPlantId) return;
  const id = editingPlantId;
  deleteR2File(garden.plants[id]?.audioRef);
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
    audioRef = await uploadSeedFile(plantDraftFile, `plants/${plantId}`).catch(err => {
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
    // preserved across edits — this is when the plant was first planted,
    // not last touched, so editing an existing plant doesn't bump the
    // garden info panel's "last planted" date
    plantedAt: existing?.plantedAt || Date.now(),
  };
  garden.plants[plantId] = plant;
  plantSlotsChannel?.setData(draft => { draft[plantId] = plant; });
  renderPlantSlots();
  hidePlantModal();
  pSaveBtn.disabled = false; pSaveBtn.textContent = "plant";
});

/* ==========================================================================
   INITIAL RENDER — first paint, must stay last: needs every DOM-query const above it already initialized
   ========================================================================== */

// connectChannels() runs async (after playhtml.init resolves) and re-renders
// on its own once the real synced data arrives — these are just the
// unsynced first paint using local defaults.
renderSeedSlots();
renderPlantSlots();
renderSeedList();
renderSampledFromBank();
