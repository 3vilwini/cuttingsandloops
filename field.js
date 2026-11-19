/* ୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.
   FIELD — how a garden's pattern is drawn, shared by water.js (the real field)
   and index.html (the hover preview) so the preview is the same drawing
   ୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚.୨ৎ ˖᯽ ݁˖ જ ˚ ༘♡ ⋆｡˚ ੈ✩‧₊˚⋆˚❀ ༉ ‧₊˚. */

export const FIELD_W = 2400, FIELD_H = 1600;

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// hex "#rrggbb" -> "r,g,b" so seed color can be used at low opacity for field pattern
function hexToRgb(hex){
  const m = hex.replace("#","").match(/.{2}/g).map(h => parseInt(h,16));
  return m.join(",");
}

// fills an <svg> with the field's pattern in the seed color — "lattice" (grid),
// "array" (dots in a spiral) or "furrow" (horizontal lines). drawn across the
// whole FIELD_W x FIELD_H field; the caller picks which part of it shows via
// the svg's own viewBox
export function drawFieldPattern(svg, { pattern, scale = 1, seed }){
  svg.innerHTML = "";
  const rgb = hexToRgb(seed);
  const CX = FIELD_W/2, CY = FIELD_H/2;
  const LATTICE_BASE = 104;
  const FURROW_BASE = 26;

  if(pattern === "array"){
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
    const spacing = (pattern === "lattice" ? LATTICE_BASE : FURROW_BASE) * scale;
    const defs = svgEl("defs", {});
    const tile = svgEl("pattern", { id:"fieldPattern", width:spacing, height:spacing, patternUnits:"userSpaceOnUse" });
    const stroke = `rgba(${rgb},.4)`;
    tile.appendChild(svgEl("line", { x1:0, y1:spacing/2, x2:spacing, y2:spacing/2, stroke, "stroke-width":0.6 }));
    if(pattern === "lattice"){
      tile.appendChild(svgEl("line", { x1:spacing/2, y1:0, x2:spacing/2, y2:spacing, stroke, "stroke-width":0.6 }));
    }
    defs.appendChild(tile);
    svg.appendChild(defs);
    // explicit size, not 100% — percentages follow the svg's viewBox, which a caller may crop
    svg.appendChild(svgEl("rect", { width:FIELD_W, height:FIELD_H, fill:"url(#fieldPattern)" }));
  }
}
