"use strict";

/*
  SOUND GARDEN · seeds & plants + provenance roots + editing + mix shots
  -------------------------------------------------------------------------
  SEED = a source sound. PLANT = a composition sampled from 1+ seeds.
  Roots (SVG) link each seed to the plants that sampled it.
  View cycles: plants → seeds → no roots → all  (roots show only in "all").
  Edit a sound (double-click or E): change name / planted-by / glyph /
    (for a plant) which seeds it sampled, and its mix screenshot. The audio,
    the kind and the id never change.
  A plant can carry a "mix shot" — a screenshot of how its seeds were
    assembled. Hidden by default: a small badge marks plants that have one,
    a thumbnail peeks on hover/focus, and V (or a click) opens it full size.

  Glyphs use single decorative characters (family B) with an emoji fallback
  (family D) auto-substituted when a character doesn't render on this device.
*/

/* ============================ CONFIG ============================ */
const FIELD_W=2400, FIELD_H=1600;
const N_BEDS=13, BED_MARGIN=140;
const AUDIBLE_RADIUS=360, MAX_VOICES=8, RELEASE_MS=1200;
const PITCH_SPAN=22, PITCH_SHIFT=-6, PENTATONIC=[0,2,4,7,9];
const PIN_GAIN=0.8, VISIT_GAIN=0.95;
const MAX_REC_SEC=6, DRY_RATE=0.018, TICK_MS=1500, FRESH_FLOOR=0.08, STEP=95;
const WATER_SECONDS=10, WATER_TICK_MS=100;
const DECAY_SECONDS=2.5, DECAY_TICK_MS=80;
const SHOT_MAX_W=1000, SHOT_QUALITY=0.8;   // mix screenshots are resized on import

/* glyphs: family B (decorative) with family D (emoji) fallbacks, index-matched */
const PLANT_B=["❧","⚘","✤","❀","☘","⟡","✦","❦"];
const PLANT_D=["🌿","🍄","🌸","🦋","🐸","🪷","🌾","🐌"];
const SEED_B =["⟐","◦","⊙","✧","·","๛","⫯","◌"];
const SEED_D =["🌰","🫘","🥚","🪵","🍂","🌱","🪺","🍃"];
/* =============================================================== */

/* ---- does this device's font actually draw a glyph? (else it's a tofu box) ---- */
const _supCache=new Map();
function supportsGlyph(ch){
  if(_supCache.has(ch)) return _supCache.get(ch);
  let ok=true;
  try{
    const c=document.createElement("canvas").getContext("2d");
    c.font="32px sans-serif";
    const missing=c.measureText("\uE0FF").width;   // a private-use char → almost always tofu
    const w=c.measureText(ch).width;
    ok = w>0 && Math.abs(w-missing)>0.5;
  }catch(e){ ok=true; }
  _supCache.set(ch,ok); return ok;
}
const GLYPH_FALLBACK={};
function resolveSet(B,D){ return B.map((b,i)=>{ const g=supportsGlyph(b)?b:D[i]; GLYPH_FALLBACK[b]=g; return g; }); }
const PLANT_GLYPHS=resolveSet(PLANT_B,PLANT_D);
const SEED_GLYPHS =resolveSet(SEED_B, SEED_D);
const showGlyph = g => GLYPH_FALLBACK[g] || g;

/* ---- audio context (lazy) ---- */
let ctx=null;
function audio(){
  if(!ctx) ctx = new (window.AudioContext||window.webkitAudioContext)();
  if(ctx.state==="suspended") ctx.resume();
  return ctx;
}
const decodeBytes = ab => audio().decodeAudioData(ab.slice(0));
function newSid(){ return crypto.randomUUID ? crypto.randomUUID() : "s"+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }

/* ---- resize an imported image to a light JPEG data-URL ---- */
function resizeImage(file, maxW=SHOT_MAX_W, quality=SHOT_QUALITY){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      URL.revokeObjectURL(url);
      const scale=Math.min(1, maxW/img.width);
      const w=Math.max(1,Math.round(img.width*scale)), h=Math.max(1,Math.round(img.height*scale));
      const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
      cv.getContext("2d").drawImage(img,0,0,w,h);
      try{ resolve(cv.toDataURL("image/jpeg", quality)); }catch(e){ reject(e); }
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src=url;
  });
}

/* ---- elements ---- */
const viewport=document.getElementById("viewport");
const field=document.getElementById("field");
const rootsEl=document.getElementById("roots");
const listenerEl=document.getElementById("listener");
const statusEl=document.getElementById("status");
const titleEl=document.getElementById("title");
const shotPeek=document.getElementById("shotPeek");
const shotPeekImg=shotPeek.querySelector("img");
const shotBox=document.getElementById("shotBox");
const shotBoxImg=shotBox.querySelector("img");
field.style.width=FIELD_W+"px"; field.style.height=FIELD_H+"px";
rootsEl.setAttribute("viewBox", `0 0 ${FIELD_W} ${FIELD_H}`);
rootsEl.setAttribute("preserveAspectRatio","none");

/* ---- state ---- */
let plots=[];
let listener={x:FIELD_W/2, y:FIELD_H/2};
let weatherOn=false, scheduled=false;
let plotDrag=null;
let view="plants", showRoots=false;     // start on the compositions

/* pitch from height, quantised to pentatonic */
function rateAt(y){
  const norm=1-Math.max(0,Math.min(1,y/FIELD_H));
  const semisFloat=norm*PITCH_SPAN+PITCH_SHIFT;
  const oct=Math.floor(semisFloat/12);
  const within=semisFloat-oct*12;
  let best=PENTATONIC[0], bestD=Infinity;
  for(const s of PENTATONIC.concat([12])){ const d=Math.abs(within-s); if(d<bestD){bestD=d;best=s;} }
  const semis=oct*12+(best===12?12:best);
  return Math.pow(2,semis/12);
}

/* ---- make a plot ---- */
let uid=0;
function makePlot(x,y,opts={}){
  const p={
    id:++uid, sid:null, x, y,
    planted:false, ephemeral:!!opts.ephemeral, kind:null, sampledFrom:[],
    buffer:null, rawBytes:null, rawType:"", source:null, gainNode:null, panNode:null,
    rate:rateAt(y), pinned:false, fresh:1, glyph:PLANT_GLYPHS[0], meta:{}, shot:null,
    dying:false, decay:1,
    rot:(Math.random()*16-8), size:60+Math.round(Math.random()*40),
    _d:Infinity, _lastAudible:0
  };
  const el=document.createElement("button");
  el.className="plot empty";
  el.style.left=x+"px"; el.style.top=y+"px";
  el.style.width=p.size+"px"; el.style.height=p.size+"px";
  el.style.fontSize=Math.round(p.size*0.46)+"px";
  const r=()=>40+Math.round(Math.random()*22);
  el.style.borderRadius=`${r()}% ${r()}% ${r()}% ${r()}% / ${r()}% ${r()}% ${r()}% ${r()}%`;
  el.innerHTML='<span class="glyph"></span>';
  p.el=el; wirePlot(p); field.appendChild(el); plots.push(p); renderPlot(p);
  return p;
}
function scatterBeds(){
  let tries=0;
  while(plots.filter(p=>!p.planted).length < N_BEDS && tries < N_BEDS*40){
    tries++;
    const x=BED_MARGIN+Math.random()*(FIELD_W-BED_MARGIN*2);
    const y=BED_MARGIN+Math.random()*(FIELD_H-BED_MARGIN*2);
    if(plots.every(q=>Math.hypot(q.x-x,q.y-y)>200)) makePlot(x,y);
  }
}
function clearField(){
  for(const p of plots) stopSource(p);
  field.querySelectorAll(".plot").forEach(el=>el.remove());
  plots=[]; renderRoots();
}

/* ---- audio plumbing ---- */
function ensureSource(p){
  if(p.source) return;
  const c=audio();
  const src=c.createBufferSource(); src.buffer=p.buffer; src.loop=true; src.playbackRate.value=p.rate;
  const g=c.createGain(); g.gain.value=0;
  const pan=c.createStereoPanner?c.createStereoPanner():null;
  src.connect(g); if(pan){ g.connect(pan); pan.connect(c.destination);} else g.connect(c.destination);
  src.start(); p.source=src; p.gainNode=g; p.panNode=pan;
}
function stopSource(p){
  if(!p.source) return;
  try{p.source.stop();}catch(e){}
  try{p.source.disconnect(); p.gainNode.disconnect(); if(p.panNode)p.panNode.disconnect();}catch(e){}
  p.source=p.gainNode=p.panNode=null;
}
const smooth=t=>t*t*(3-2*t);
const visible=p=>p.el.style.display!=="none";
function applyAudio(p){
  const within=p._d<AUDIBLE_RADIUS;
  let g=0;
  if(within) g=smooth(1-p._d/AUDIBLE_RADIUS)*VISIT_GAIN;
  if(p.pinned) g=Math.max(g, within?PIN_GAIN:PIN_GAIN*0.5);
  g*=FRESH_FLOOR+(1-FRESH_FLOOR)*p.fresh;
  p.gainNode.gain.setTargetAtTime(g, ctx.currentTime, 0.08);
  if(p.panNode){
    let pan=(p.x-listener.x)/AUDIBLE_RADIUS; pan=Math.max(-1,Math.min(1,pan));
    p.panNode.pan.setTargetAtTime(pan, ctx.currentTime, 0.08);
  }
}

/* ---- the one update pass ---- */
function requestUpdate(){ if(!scheduled){ scheduled=true; requestAnimationFrame(update);} }
function update(){
  scheduled=false;
  listenerEl.style.left=listener.x+"px"; listenerEl.style.top=listener.y+"px";
  for(const p of plots) p._d=Math.hypot(p.x-listener.x, p.y-listener.y);
  if(ctx){
    const now=performance.now();
    let desired=plots.filter(p=>p.planted&&!p.dying&&visible(p)&&(p.pinned||p._d<AUDIBLE_RADIUS));
    desired.sort((a,b)=>(b.pinned-a.pinned)||(a._d-b._d));
    desired=desired.slice(0,MAX_VOICES);
    const keep=new Set(desired);
    for(const p of desired){ ensureSource(p); applyAudio(p); p._lastAudible=now; }
    for(const p of plots){
      if(p.dying && p.source){
        p.gainNode.gain.setTargetAtTime(0, ctx.currentTime, DECAY_SECONDS*0.4);
      }else if(p.source && !keep.has(p)){
        if(now-p._lastAudible>RELEASE_MS) stopSource(p);
        else p.gainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
      }
    }
  }
  for(const p of plots) paintProximity(p);
}
function paintProximity(p){
  const near=Math.max(0,Math.min(1,1-p._d/(AUDIBLE_RADIUS*1.15)));
  const fade=p.dying?p.decay:1;
  const scale=(1+0.45*near)*(p.dying?(0.5+0.5*p.decay):1);
  p.el.style.transform=`translate(-50%,-50%) rotate(${p.rot}deg) scale(${scale.toFixed(3)})`;
  if(p.planted){
    p.el.style.opacity=((0.4+0.6*near)*(0.55+0.45*p.fresh))*fade;
    p.el.classList.toggle("near", near>0.45 && !p.dying);
    const bar=p.el.querySelector(".fresh i"); if(bar) bar.style.width=Math.round(p.fresh*100)+"%";
  }else{
    p.el.style.opacity=0.16+0.5*near;
    p.el.classList.toggle("near", near>0.5);
  }
}

/* ---- roots ---- */
function renderRoots(){
  if(!rootsEl) return;
  if(!showRoots){ rootsEl.innerHTML=""; return; }
  const bySid={};
  for(const p of plots){ if(p.planted && p.sid && !p.dying && visible(p)) bySid[p.sid]=p; }
  const segs=[];
  for(const p of plots){
    if(p.planted && p.kind==="plant" && !p.dying && visible(p)){
      for(const sid of (p.sampledFrom||[])){
        const s=bySid[sid];
        if(s){
          const dx=p.x-s.x, dy=p.y-s.y;
          const mx=(s.x+p.x)/2 - dy*0.12, my=(s.y+p.y)/2 + dx*0.12;
          segs.push(`<path d="M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}"/>`);
        }
      }
    }
  }
  rootsEl.innerHTML = segs.join("");
}

/* ---- mix-shot affordances live only outside the default "plants" view ---- */
const shotsActive = () => view!=="plants";
function updateShotBadge(p){ p.el.classList.toggle("has-shot", !!(p.planted && p.shot && shotsActive())); }

/* ---- show / hide layers; beds always visible; roots only in "all" ---- */
function applyVisibility(){
  showRoots = (view==="all");
  for(const p of plots){
    let vis=true;
    if(p.planted){
      if(view==="plants" && p.kind==="seed") vis=false;
      if(view==="seeds"  && p.kind==="plant") vis=false;
    }
    p.el.style.display = vis ? "" : "none";
    updateShotBadge(p);
  }
  renderRoots();
  requestUpdate();
}
function setView(v){
  view=v;
  const btn=document.getElementById("viewBtn"); if(btn) btn.textContent=VIEWLABEL[v];
  hidePeek();
  applyVisibility();
}

/* ---- render identity ---- */
function renderPlot(p){
  const el=p.el, g=el.querySelector(".glyph");
  if(!p.planted){ el.className="plot empty"; g.textContent=""; el.setAttribute("aria-label","Empty bed. Press enter to plant a sound here."); return; }
  el.className="plot planted"+(p.kind==="seed"?" seed":"")+(p.pinned?" pinned":"");
  updateShotBadge(p);
  g.textContent=showGlyph(p.glyph);
  if(!el.querySelector(".fresh")){ const f=document.createElement("span"); f.className="fresh"; f.innerHTML="<i></i>"; el.appendChild(f); }
  const m=p.meta;
  const role=p.kind==="seed"?"seed":"plant";
  const src=(p.kind==="plant"&&p.sampledFrom&&p.sampledFrom.length)?` Sampled from ${p.sampledFrom.length} seed(s).`:"";
  const shot=p.shot?" Has a mix screenshot — press V to view.":"";
  el.title=`${role}: ${m.name||"untitled"} 𓂃 sowed by ${m.by||"anon"}`;
  el.setAttribute("aria-label",
    `${role}: ${m.name||"untitled"}, by ${m.by||"anon"}.${src}${shot} `+
    `${p.pinned?"Pinned, playing.":"Not pinned."} Freshness ${Math.round(p.fresh*100)} percent. `+
    `Enter to ${p.pinned?"unpin":"pin"}, E to edit, W to water, D to download, Shift+arrows to move, Delete to remove.`);
}

/* ---- moving a plant ---- */
function moveplotTo(p,x,y){
  p.x=Math.max(0,Math.min(FIELD_W,x));
  p.y=Math.max(0,Math.min(FIELD_H,y));
  p.el.style.left=p.x+"px"; p.el.style.top=p.y+"px";
  p.rate=rateAt(p.y);
  if(p.source) p.source.playbackRate.setTargetAtTime(p.rate, ctx.currentTime, 0.05);
  listener.x=p.x; listener.y=p.y;
  renderRoots(); requestUpdate();
}
function moveplotBy(p,dx,dy){ moveplotTo(p,p.x+dx,p.y+dy); }

/* ---- download / delete ---- */
function extFor(type){
  if(/mp3|mpeg/.test(type)) return "mp3";
  if(/wav/.test(type)) return "wav";
  if(/ogg/.test(type)) return "ogg";
  if(/mp4|m4a|aac/.test(type)) return "m4a";
  return "webm";
}
function downloadSound(p){
  if(!p.planted || !p.rawBytes){ say("nothing to download here"); return; }
  const blob=new Blob([p.rawBytes], {type:p.rawType||"application/octet-stream"});
  const name=(p.meta.name||p.kind||"sound").trim().replace(/[^\w-]+/g,"_") || "sound";
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`${name}.${extFor(p.rawType)}`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  say(`downloaded ${p.meta.name||"sound"}`);
}
function removeSound(p){
  if(!p.planted || p.dying) return;
  p.dying=true; p.decay=1; hidePeek(); renderRoots(); requestUpdate();
  say(`removing ${p.meta.name||"the sound"}… (water it to keep it)`);
}
function finalizeRemoval(p){
  stopSource(p);
  if(p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
  plots=plots.filter(q=>q!==p);
  if(plotDrag && plotDrag.p===p) plotDrag=null;
  renderRoots(); autosave();
}

/* ---- listener movement ---- */
function moveListenerTo(x,y,scroll){
  listener.x=Math.max(0,Math.min(FIELD_W,x));
  listener.y=Math.max(0,Math.min(FIELD_H,y));
  if(scroll) viewport.scrollTo({left:listener.x-viewport.clientWidth/2, top:listener.y-viewport.clientHeight/2, behavior:"smooth"});
  requestUpdate();
}
function nearest(){
  let best=null,bd=Infinity;
  for(const p of plots){ if(p.planted&&!p.dying&&visible(p)){ const d=Math.hypot(p.x-listener.x,p.y-listener.y); if(d<bd){bd=d;best=p;} } }
  return best;
}
function say(t){ statusEl.textContent=t; }
function announceNearest(){
  const p=nearest();
  if(p && Math.hypot(p.x-listener.x,p.y-listener.y)<AUDIBLE_RADIUS){
    const m=p.meta;
    say(`${p.kind}: ${m.name||"untitled"} · by ${m.by||"anon"} · ${Math.round(p.fresh*100)}% fresh`);
  } else say("…open field. wander, or sow.");
}

/* ============================ mix-shot peek + lightbox ============================ */
let peekTimer=null, peekSrc=null;
function showPeek(p){
  if(!p.shot || !shotsActive() || plotDrag || shotBox.classList.contains("open")) return;
  clearTimeout(peekTimer);
  peekSrc=p.shot; shotPeekImg.src=p.shot;
  const r=p.el.getBoundingClientRect();
  const pw=252, ph=190;
  let x=r.right+12, y=r.top;
  if(x+pw>window.innerWidth) x=r.left-pw-12;
  if(x<8) x=8;
  if(y+ph>window.innerHeight) y=window.innerHeight-ph-8;
  if(y<8) y=8;
  shotPeek.style.left=x+"px"; shotPeek.style.top=y+"px";
  shotPeek.classList.add("open");
}
function hidePeek(){ clearTimeout(peekTimer); shotPeek.classList.remove("open"); }
function hidePeekSoon(){ clearTimeout(peekTimer); peekTimer=setTimeout(()=>shotPeek.classList.remove("open"),170); }
shotPeek.addEventListener("mouseenter", ()=>clearTimeout(peekTimer));
shotPeek.addEventListener("mouseleave", hidePeekSoon);
shotPeek.addEventListener("click", ()=>{ if(peekSrc) openShot(peekSrc); });

function openShot(src){ if(!src) return; hidePeek(); shotBoxImg.src=src; shotBox.classList.add("open"); shotBox.setAttribute("aria-hidden","false"); }
function closeShot(){ shotBox.classList.remove("open"); shotBox.setAttribute("aria-hidden","true"); }
shotBox.addEventListener("click", closeShot);
document.addEventListener("keydown", e=>{ if(e.key==="Escape" && shotBox.classList.contains("open")){ e.preventDefault(); closeShot(); } });

/* ---- mouse / drag the field ---- */
viewport.addEventListener("pointermove", e=>{
  if(dragging||plotDrag) return;
  const r=viewport.getBoundingClientRect();
  listener.x=viewport.scrollLeft+(e.clientX-r.left);
  listener.y=viewport.scrollTop+(e.clientY-r.top);
  requestUpdate();
});
viewport.addEventListener("scroll", ()=>requestUpdate(), {passive:true});
let dragging=false, downX=0, downY=0, moved=false;
viewport.addEventListener("pointerdown", e=>{
  if(e.target.closest(".plot")) return;
  audio(); dragging=true; moved=false; downX=e.clientX; downY=e.clientY;
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener("pointermove", e=>{
  if(!dragging) return;
  const dx=e.clientX-downX, dy=e.clientY-downY;
  if(Math.abs(dx)+Math.abs(dy)>6){ moved=true; viewport.scrollBy(-dx,-dy); downX=e.clientX; downY=e.clientY; requestUpdate(); }
});
viewport.addEventListener("pointerup", e=>{
  if(!dragging) return; dragging=false;
  if(!moved && !e.target.closest(".plot")){
    const r=viewport.getBoundingClientRect();
    const x=viewport.scrollLeft+(e.clientX-r.left);
    const y=viewport.scrollTop+(e.clientY-r.top);
    openPlant(makePlot(x,y,{ephemeral:true}));
  }
});

/* ---- keyboard (field-level) ---- */
document.addEventListener("keydown", e=>{
  const typing=/input|textarea/i.test(e.target.tagName)||e.target.isContentEditable;
  if(typing||scrim.classList.contains("open")||shotBox.classList.contains("open")) return;
  const move={ArrowLeft:[-STEP,0],ArrowRight:[STEP,0],ArrowUp:[0,-STEP],ArrowDown:[0,STEP]}[e.key];
  if(move){ e.preventDefault(); audio(); moveListenerTo(listener.x+move[0],listener.y+move[1],true); announceNearest(); }
  else if(e.key==="p"||e.key==="P"){ e.preventDefault(); openPlant(makePlot(listener.x,listener.y,{ephemeral:true})); }
  else if(e.key==="e"||e.key==="E"){ e.preventDefault(); const p=nearest(); if(p) openEdit(p); }
  else if(e.key==="v"||e.key==="V"){ e.preventDefault(); const p=nearest(); if(p&&p.shot&&shotsActive()) openShot(p.shot); }
  else if(e.key==="w"||e.key==="W"){ e.preventDefault(); const p=nearest(); if(p) startWatering(p); }
  else if(e.key==="d"||e.key==="D"){ e.preventDefault(); const p=nearest(); if(p) downloadSound(p); }
});

/* ---- a plant's own interactions ---- */
function wirePlot(p){
  const el=p.el;
  el.addEventListener("focus", ()=>{ moveListenerTo(p.x,p.y,true); announceNearest(); showPeek(p); });
  el.addEventListener("blur", hidePeekSoon);
  el.addEventListener("mouseenter", ()=>{ if(!plotDrag){ listener.x=p.x; listener.y=p.y; requestUpdate(); showPeek(p); } });
  el.addEventListener("mouseleave", hidePeekSoon);
  el.addEventListener("dblclick", e=>{ e.preventDefault(); e.stopPropagation(); if(p.planted) openEdit(p); });
  el.addEventListener("pointerdown", e=>{
    e.stopPropagation(); audio();
    plotDrag={ p, sx:e.clientX, sy:e.clientY, moved:false };
    try{ el.setPointerCapture(e.pointerId); }catch(_){}
  });
  el.addEventListener("pointermove", e=>{
    if(!plotDrag || plotDrag.p!==p) return;
    if(!plotDrag.moved && Math.abs(e.clientX-plotDrag.sx)+Math.abs(e.clientY-plotDrag.sy)<5) return;
    if(!p.planted) return;
    plotDrag.moved=true; hidePeek();
    const r=viewport.getBoundingClientRect();
    moveplotTo(p, viewport.scrollLeft+(e.clientX-r.left), viewport.scrollTop+(e.clientY-r.top));
  });
  el.addEventListener("pointerup", e=>{
    if(!plotDrag || plotDrag.p!==p){ plotDrag=null; return; }
    const wasMoved=plotDrag.moved; plotDrag=null;
    if(wasMoved){ autosave(); say(`moved ${p.meta.name||"sound"} — higher = higher pitch`); }
    else if(e.altKey && p.planted){ removeSound(p); }
    else if(e.shiftKey && p.planted){ downloadSound(p); }
    else { p.planted?togglePin(p):openPlant(p); }
  });
  el.addEventListener("keydown", e=>{
    const mv={ArrowLeft:[-STEP,0],ArrowRight:[STEP,0],ArrowUp:[0,-STEP],ArrowDown:[0,STEP]}[e.key];
    if(e.shiftKey && mv && p.planted){ e.preventDefault(); e.stopPropagation(); moveplotBy(p,mv[0],mv[1]); autosave(); return; }
    if(e.key===" "){ e.preventDefault(); p.planted?togglePin(p):openPlant(p); }
    else if(e.key==="e"||e.key==="E"){ e.preventDefault(); if(p.planted) openEdit(p); }
    else if(e.key==="v"||e.key==="V"){ e.preventDefault(); if(p.shot&&shotsActive()) openShot(p.shot); }
    else if(e.key==="w"||e.key==="W"){ e.preventDefault(); startWatering(p); }
    else if(e.key==="d"||e.key==="D"){ e.preventDefault(); downloadSound(p); }
    else if(e.key==="Backspace"||e.key==="Delete"){ e.preventDefault(); removeSound(p); }
  });
}
function togglePin(p){
  if(!p.planted) return;
  p.pinned=!p.pinned; renderPlot(p); requestUpdate(); autosave();
  say(p.pinned?`pinned ${p.meta.name||"sound"} — it follows you`:`unpinned ${p.meta.name||"sound"}`);
}

/* ============================ dialog (plant + edit) ============================ */
const scrim=document.getElementById("scrim");
const capStatus=document.getElementById("capStatus");
const plantBtn=document.getElementById("plantBtn");
const captureRow=document.getElementById("captureRow");
const shotRow=document.getElementById("shotRow");
const shotInput=document.getElementById("shotInput");
const shotPreview=document.getElementById("shotPreview");
const shotClear=document.getElementById("shotClear");
const dlgTitleEl=document.getElementById("dlgTitle");
const kindBtns=document.querySelectorAll("#kindPick button");
let targetPlot=null, dialogMode="plant", capturedBuffer=null, capturedRaw=null, capturedType="";
let capturedShot=null;
let chosenGlyph=PLANT_GLYPHS[0], chosenKind="plant", chosenSeeds=new Set();

function buildGlyphPicker(set){
  const wrap=document.getElementById("glyphPicker"); wrap.innerHTML="";
  chosenGlyph=set[0];
  set.forEach((gl,i)=>{
    const b=document.createElement("button");
    b.type="button"; b.textContent=gl; b.setAttribute("aria-pressed", i===0?"true":"false");
    b.addEventListener("click", ()=>{ chosenGlyph=gl; wrap.querySelectorAll("button").forEach(x=>x.setAttribute("aria-pressed","false")); b.setAttribute("aria-pressed","true"); });
    wrap.appendChild(b);
  });
}
function preselectGlyph(g){
  chosenGlyph=g;
  document.querySelectorAll("#glyphPicker button").forEach(b=> b.setAttribute("aria-pressed", b.textContent===showGlyph(g) ? "true":"false"));
}
function buildSeedList(){
  const wrap=document.getElementById("seedList"); wrap.innerHTML="";
  const seeds=plots.filter(p=>p.planted && p.kind==="seed" && !p.dying);
  if(!seeds.length){ wrap.innerHTML='<span class="muted">no seeds yet — plant a seed first to attribute it.</span>'; return; }
  for(const s of seeds){
    const b=document.createElement("button"); b.type="button"; b.className="seedchip";
    b.setAttribute("aria-pressed", chosenSeeds.has(s.sid)?"true":"false");
    b.textContent=`${showGlyph(s.glyph)} ${s.meta.name||"untitled"}`;
    b.addEventListener("click", ()=>{
      if(chosenSeeds.has(s.sid)) chosenSeeds.delete(s.sid); else chosenSeeds.add(s.sid);
      b.setAttribute("aria-pressed", chosenSeeds.has(s.sid)?"true":"false");
    });
    wrap.appendChild(b);
  }
}
function showShot(dataUrl){
  capturedShot=dataUrl||null;
  if(capturedShot){ shotPreview.src=capturedShot; shotPreview.hidden=false; shotClear.hidden=false; }
  else { shotPreview.removeAttribute("src"); shotPreview.hidden=true; shotClear.hidden=true; }
}
function setKind(kind){
  chosenKind=kind;
  kindBtns.forEach(b=>b.setAttribute("aria-pressed", b.dataset.kind===kind?"true":"false"));
  const isPlant = kind==="plant";
  document.getElementById("seedsRow").style.display = isPlant ? "" : "none";
  shotRow.style.display = isPlant ? "" : "none";
  buildGlyphPicker(kind==="seed"?SEED_GLYPHS:PLANT_GLYPHS);
  if(kind==="seed"){ chosenSeeds.clear(); showShot(null); }
}
kindBtns.forEach(b=> b.addEventListener("click", ()=>{ if(dialogMode==="plant") setKind(b.dataset.kind); }));

shotInput.addEventListener("change", async e=>{
  const f=e.target.files[0]; if(!f) return;
  try{ showShot(await resizeImage(f)); }
  catch(err){ say("couldn't read that image"); }
  e.target.value="";
});
shotClear.addEventListener("click", ()=>showShot(null));
document.getElementById("shotLabel").addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); shotInput.click(); } });

function openPlant(p){
  targetPlot=p; dialogMode="plant"; capturedBuffer=null; capturedRaw=null; capturedType=""; chosenSeeds=new Set();
  dlgTitleEl.textContent="plant a sound";
  document.getElementById("fName").value=""; document.getElementById("fBy").value="";
  kindBtns.forEach(b=>b.disabled=false);
  setKind("plant"); buildSeedList(); showShot(null);
  captureRow.style.display="";
  capStatus.textContent="no sound captured yet.";
  plantBtn.textContent="plant"; plantBtn.disabled=true;
  scrim.classList.add("open"); document.getElementById("fName").focus();
}
function openEdit(p){
  if(!p.planted) return;
  hidePeek();
  targetPlot=p; dialogMode="edit";
  chosenSeeds = new Set(p.kind==="plant" ? (p.sampledFrom||[]) : []);
  dlgTitleEl.textContent="edit — info & glyph only";
  document.getElementById("fName").value=p.meta.name||"";
  document.getElementById("fBy").value=p.meta.by||"";
  setKind(p.kind);
  kindBtns.forEach(b=>b.disabled=true);          // type can't change when editing
  preselectGlyph(p.glyph);
  buildSeedList();
  showShot(p.kind==="plant" ? (p.shot||null) : null);
  captureRow.style.display="none";               // the sound itself isn't editable
  plantBtn.textContent="save"; plantBtn.disabled=false;
  scrim.classList.add("open"); document.getElementById("fName").focus();
}
function closeDialog(){
  scrim.classList.remove("open");
  if(dialogMode==="plant" && targetPlot && targetPlot.ephemeral && !targetPlot.planted){ field.removeChild(targetPlot.el); plots=plots.filter(q=>q!==targetPlot); }
  requestUpdate();
}
document.getElementById("cancelBtn").addEventListener("click", closeDialog);
scrim.addEventListener("keydown", e=>{ if(e.key==="Escape") closeDialog(); });

document.getElementById("plantBtn").addEventListener("click", ()=>{
  if(!targetPlot) return;
  const p=targetPlot;
  if(dialogMode==="edit"){
    p.meta.name=document.getElementById("fName").value.trim();
    p.meta.by=document.getElementById("fBy").value.trim();
    p.glyph=chosenGlyph;
    if(p.kind==="plant"){
      p.sampledFrom=[...chosenSeeds].filter(sid=>plots.some(q=>q.sid===sid && q.kind==="seed"));
      p.shot=capturedShot||null;
    }
    renderPlot(p); applyVisibility(); autosave();
    say(`updated ${p.meta.name||"the sound"}`);
    scrim.classList.remove("open"); return;
  }
  if(!capturedBuffer) return;
  p.sid=newSid(); p.kind=chosenKind;
  p.sampledFrom = chosenKind==="plant" ? [...chosenSeeds].filter(sid=>plots.some(q=>q.sid===sid && q.kind==="seed")) : [];
  p.shot = chosenKind==="plant" ? (capturedShot||null) : null;
  p.buffer=capturedBuffer; p.rawBytes=capturedRaw; p.rawType=capturedType;
  p.meta={ name:document.getElementById("fName").value.trim(), by:document.getElementById("fBy").value.trim(), customGlyph:true };
  p.glyph=chosenGlyph; p.fresh=1; p.planted=true; p.ephemeral=false;
  renderPlot(p); applyVisibility(); autosave();
  const tag = p.kind==="seed" ? "seed" : (p.sampledFrom.length?`plant (from ${p.sampledFrom.length} seed${p.sampledFrom.length>1?"s":""})`:"plant");
  say(`planted ${p.meta.name||"a sound"} — ${tag}`);
  scrim.classList.remove("open");
  if(!visible(p)) setView("all");   // never plant something into an invisible layer
});

/* capture by file */
document.getElementById("fileInput").addEventListener("change", async e=>{
  const f=e.target.files[0]; if(!f) return;
  capStatus.textContent="decoding…";
  try{
    capturedRaw=await f.arrayBuffer(); capturedType=f.type||"audio/*";
    capturedBuffer=await decodeBytes(capturedRaw);
    capStatus.textContent=`captured ✓ ${capturedBuffer.duration.toFixed(1)}s from file`; plantBtn.disabled=false;
  }catch(err){ capStatus.textContent="couldn't read that file — try a .wav or .mp3"; }
});
document.querySelector("#captureRow .filelabel").addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); document.getElementById("fileInput").click(); } });

/* capture by mic */
let recorder=null, chunks=[], recTimer=null, recCount=0;
const recBtn=document.getElementById("recBtn");
recBtn.addEventListener("click", async ()=>{
  if(recorder&&recorder.state==="recording"){ stopRec(); return; }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    recorder=new MediaRecorder(stream); chunks=[];
    recorder.ondataavailable=ev=>chunks.push(ev.data);
    recorder.onstop=async ()=>{
      stream.getTracks().forEach(t=>t.stop());
      capStatus.textContent="decoding…";
      try{
        const blob=new Blob(chunks,{type:recorder.mimeType||"audio/webm"});
        capturedRaw=await blob.arrayBuffer(); capturedType=blob.type||"audio/webm";
        capturedBuffer=await decodeBytes(capturedRaw);
        capStatus.textContent=`captured ✓ ${capturedBuffer.duration.toFixed(1)}s from mic`; plantBtn.disabled=false;
      }catch(err){ capStatus.textContent="couldn't decode the recording — try loading a file instead"; }
    };
    recorder.start();
    recCount=0; recBtn.classList.add("recording"); recBtn.textContent="■ stop (0s)";
    recTimer=setInterval(()=>{ recCount++; recBtn.textContent=`■ stop (${recCount}s)`; if(recCount>=MAX_REC_SEC) stopRec(); },1000);
  }catch(err){ capStatus.textContent="mic unavailable here (blocked in preview / needs permission). Use “load file…” instead."; }
});
function stopRec(){ if(recTimer){clearInterval(recTimer);recTimer=null;} recBtn.classList.remove("recording"); recBtn.textContent="● record"; if(recorder&&recorder.state==="recording") recorder.stop(); }

/* ============================ persistence ============================ */
function idbOpen(){ return new Promise((res,rej)=>{ const r=indexedDB.open("sound-garden",1); r.onupgradeneeded=()=>r.result.createObjectStore("kv"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ try{ const db=await idbOpen(); await new Promise((res,rej)=>{ const tx=db.transaction("kv","readwrite"); tx.objectStore("kv").put(v,k); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); }); }catch(e){} }
async function idbGet(k){ try{ const db=await idbOpen(); return await new Promise((res,rej)=>{ const tx=db.transaction("kv","readonly"); const rq=tx.objectStore("kv").get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error); }); }catch(e){ return null; } }

function plantedRecords(toBase64){
  return plots.filter(p=>p.planted&&!p.dying).map(p=>({
    sid:p.sid, kind:p.kind, sampledFrom:p.sampledFrom||[],
    x:p.x, y:p.y, glyph:p.glyph, pinned:p.pinned, fresh:p.fresh, meta:p.meta,
    shot:p.shot||null,
    audioType:p.rawType,
    audio: toBase64 ? ab2b64(p.rawBytes) : p.rawBytes
  }));
}
let saveTimer=null;
function autosave(){ clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ idbSet("current", { title:titleEl.textContent, plots:plantedRecords(false) }); }, 500); }

async function restoreFromIDB(){
  const snap=await idbGet("current");
  if(!snap||!snap.plots||!snap.plots.length){ scatterBeds(); return false; }
  if(snap.title) titleEl.textContent=snap.title;
  scatterBeds();
  await hydrate(snap.plots, false);
  applyVisibility();
  say("welcome back — your field is as you left it.");
  return true;
}
async function hydrate(records, fromBase64){
  for(const s of records){
    try{
      const bytes = fromBase64 ? b642ab(s.audio) : s.audio;
      const buf = await decodeBytes(bytes);
      const p = makePlot(s.x, s.y, {});
      p.sid = s.sid || newSid();
      p.kind = s.kind || "plant";
      p.sampledFrom = Array.isArray(s.sampledFrom) ? s.sampledFrom : [];
      p.shot = s.shot || null;
      p.buffer=buf; p.rawBytes=bytes; p.rawType=s.audioType||"audio/*";
      p.meta=s.meta||{}; p.glyph=s.glyph||(p.kind==="seed"?SEED_GLYPHS[0]:PLANT_GLYPHS[0]); p.pinned=!!s.pinned; p.fresh=(s.fresh==null?1:s.fresh);
      p.rate=rateAt(s.y); p.planted=true; p.ephemeral=false;
      renderPlot(p);
    }catch(e){ /* skip a sound that won't decode */ }
  }
}

function ab2b64(buf){ let bin=""; const b=new Uint8Array(buf), C=0x8000; for(let i=0;i<b.length;i+=C) bin+=String.fromCharCode.apply(null,b.subarray(i,i+C)); return btoa(bin); }
function b642ab(b64){ const bin=atob(b64), b=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i); return b.buffer; }

document.getElementById("exportBtn").addEventListener("click", ()=>{
  const snap={ title:titleEl.textContent, savedAt:new Date().toISOString(), plots:plantedRecords(true) };
  const blob=new Blob([JSON.stringify(snap)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="garden.json"; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  say(`exported ${snap.plots.length} sound${snap.plots.length===1?"":"s"} → garden.json`);
});
document.getElementById("importInput").addEventListener("change", async e=>{
  const f=e.target.files[0]; if(!f) return;
  say("opening field…");
  try{
    const snap=JSON.parse(await f.text());
    clearField();
    if(snap.title) titleEl.textContent=snap.title;
    scatterBeds();
    await hydrate(snap.plots||[], true);
    applyVisibility(); autosave();
    say(`opened ${(snap.plots||[]).length} sounds from ${f.name}`);
  }catch(err){ say("that file didn't open — is it a garden.json?"); }
  e.target.value="";
});
document.getElementById("openLabel").addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); document.getElementById("importInput").click(); } });
document.getElementById("clearBtn").addEventListener("click", ()=>{
  if(!confirm("Empty the field and forget the saved one? This can't be undone.")) return;
  clearField(); idbSet("current", null); scatterBeds(); applyVisibility(); requestUpdate(); say("cleared. a fresh field.");
});

/* ============================ other controls ============================ */
document.getElementById("weatherBtn").addEventListener("click", e=>{
  weatherOn=!weatherOn; e.currentTarget.setAttribute("aria-pressed",String(weatherOn));
  say(weatherOn?"weather on — sounds dry out where you're not looking. water them.":"weather off — the field holds still.");
});
document.getElementById("sowBtn").addEventListener("click", ()=>{ audio(); openPlant(makePlot(listener.x,listener.y,{ephemeral:true})); });
document.getElementById("stopBtn").addEventListener("click", ()=>{ plots.forEach(p=>{p.pinned=false; renderPlot(p);}); requestUpdate(); autosave(); say("hushed. the field is quiet again."); });

const VIEWS=["plants","seeds","noroots","all"];
const VIEWLABEL={ plants:"᭄᭡ plants", seeds:"᭄᭡ seeds", noroots:"᭄᭡ no roots", all:"᭄᭡ all" };
document.getElementById("viewBtn").addEventListener("click", ()=>{
  setView(VIEWS[(VIEWS.indexOf(view)+1)%VIEWS.length]);
  say(view==="all"?"showing everything, with roots":view==="noroots"?"everything, roots hidden":`showing only ${view}`);
});

/* gradual watering (+ rescue a dying sound) */
function startWatering(p){
  if(!p.planted) return;
  if(p.dying){ p.dying=false; p.decay=1; renderRoots(); }
  p.watering=true;
  say(`watering ${p.meta.name||"the sound"}…`);
}
setInterval(()=>{
  const stepUp=(WATER_TICK_MS/1000)/WATER_SECONDS;
  let changed=false;
  for(const p of plots){ if(p.watering){ p.fresh=Math.min(1, p.fresh+stepUp); changed=true; if(p.fresh>=1){ p.watering=false; autosave(); } } }
  if(changed) requestUpdate();
}, WATER_TICK_MS);

setInterval(()=>{
  if(!plots.some(p=>p.dying)) return;
  const stepDown=(DECAY_TICK_MS/1000)/DECAY_SECONDS;
  const gone=[];
  for(const p of plots){ if(p.dying){ p.decay=Math.max(0,p.decay-stepDown); if(p.decay<=0) gone.push(p); } }
  for(const p of gone) finalizeRemoval(p);
  requestUpdate();
}, DECAY_TICK_MS);

setInterval(()=>{
  if(!weatherOn) return;
  let changed=false;
  for(const p of plots){ if(p.planted&&!p.watering&&!p.dying&&p.fresh>FRESH_FLOOR){ p.fresh=Math.max(FRESH_FLOOR,p.fresh-DRY_RATE); renderPlot(p); changed=true; } }
  if(changed){ requestUpdate(); autosave(); }
}, TICK_MS);

document.addEventListener("visibilitychange", ()=>{ if(!ctx) return; if(document.hidden) ctx.suspend(); else ctx.resume(); });
titleEl.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); e.target.blur(); } });
titleEl.addEventListener("blur", autosave);

/* ---- grow the field ---- */
(async function init(){
  const restored = await restoreFromIDB().catch(()=>false);
  if(!restored){ say("a field, bigger than the screen. plant seeds, then plants."); }
  applyVisibility();
  viewport.scrollTo({ left:FIELD_W/2-viewport.clientWidth/2, top:FIELD_H/2-viewport.clientHeight/2 });
  requestUpdate();
})();
