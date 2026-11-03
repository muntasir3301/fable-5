/*
 * HTML -> Figma-ready SVG exporter for the MRI Simulator pages.
 *
 * Opens each page in headless Chrome, reads the *real* computed layout
 * (boxes, borders, radii, per-line text positions, image placement) and writes
 * a layered SVG. Dropping the SVG into Figma gives editable rectangles, text
 * layers and images, named after the HTML classes.
 *
 *   npm i puppeteer-core pngjs pixelmatch@5
 *   node figma/export.js            # export all pages (desktop + mobile)
 *   node figma/export.js --verify   # also pixel-diff every SVG against the live page
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGES = [
  ['index', 'Home'],
  ['courses', 'Courses'],
  ['quiz', 'Quiz'],
  ['reference', 'Reference'],
];
const VIEWPORTS = [
  ['Desktop', 1440, 900],
  ['Mobile', 390, 844],
];

/* ------------------------------------------------------------------ */
/* In-page extraction (runs inside Chrome)                             */
/* ------------------------------------------------------------------ */
function extract() {
  const used = {};
  const uniq = (base) => {
    base = String(base).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
    used[base] = (used[base] || 0) + 1;
    return used[base] === 1 ? base : base + '-' + used[base];
  };
  const num = (v) => parseFloat(v) || 0;
  const ctx = document.createElement('canvas').getContext('2d');
  const alpha = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 1;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  };

  function fontMetrics(cs) {
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = ctx.measureText('Hg');
    return { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent };
  }

  function radii(cs, w, h) {
    const keys = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
    return keys.map((k) => {
      const v = cs[k].split(' ')[0];
      return v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(w, h) : num(v);
    });
  }

  function nameFor(el) {
    const cls = (el.getAttribute('class') || '').trim().replace(/\s+/g, '-');
    let base = cls || el.tagName.toLowerCase();
    if (el.tagName === 'A' || el.tagName === 'BUTTON') {
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (t) base += ' ' + t;
    }
    if (el.tagName === 'IMG') base = (cls || 'img') + ' ' + (el.getAttribute('alt') || '').slice(0, 30);
    return uniq(base);
  }

  function boxOp(el, cs, r) {
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) =>
      cs['border' + s + 'Style'] === 'none' || cs['border' + s + 'Style'] === 'hidden' || alpha(cs['border' + s + 'Color']) === 0
        ? 0 : num(cs['border' + s + 'Width'])
    );
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs['border' + s + 'Color']);
    const fill = alpha(cs.backgroundColor) > 0 ? cs.backgroundColor : null;
    if (!fill && !bw.some((v) => v > 0)) return null;
    // Chrome pixel-snaps box backgrounds and borders; do the same so edges stay crisp
    const sx = Math.round(r.left), sy = Math.round(r.top);
    const box = { t: 'box', x: sx, y: sy, w: Math.round(r.right) - sx, h: Math.round(r.bottom) - sy, rad: radii(cs, r.width, r.height), fill, bw, bc };
    const table = cs.display === 'table-cell' ? el.closest('table') : null;
    if (table && getComputedStyle(table).borderCollapse === 'collapse') {
      // collapsed borders sit centred on the shared grid line, which is the cell edge
      const [bt, br, bb, bl] = bw;
      const x0 = Math.round(r.left - bl / 2), y0 = Math.round(r.top - bt / 2);
      const x1 = Math.round(r.right + br / 2), y1 = Math.round(r.bottom + bb / 2);
      const lines = [];
      if (bt) lines.push({ side: 'top', x: x0, y: y0, w: x1 - x0, h: bt, c: bc[0] });
      if (bb) lines.push({ side: 'bottom', x: x0, y: Math.round(r.bottom - bb / 2), w: x1 - x0, h: bb, c: bc[2] });
      if (bl) lines.push({ side: 'left', x: x0, y: y0, w: bl, h: y1 - y0, c: bc[3] });
      if (br) lines.push({ side: 'right', x: Math.round(r.right - br / 2), y: y0, w: br, h: y1 - y0, c: bc[1] });
      box.bw = [0, 0, 0, 0];
      box.lines = lines;
    }
    return box;
  }

  function textOps(node, out) {
    const s = node.data;
    if (!/\S/.test(s)) return;
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const { asc } = fontMetrics(cs);
    const size = num(cs.fontSize);
    const range = document.createRange();
    const chars = [];
    for (let i = 0; i < s.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rs = range.getClientRects();
      if (!rs.length) continue;
      const rr = rs[0];
      if (rr.width === 0 && /\s/.test(s[i])) continue;
      chars.push({ c: s[i], l: rr.left, t: rr.top, r: rr.right });
    }
    if (!chars.length) return;

    // underline inherited from this or an enclosing inline element
    let underline = false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (ecs.textDecorationLine.includes('underline')) { underline = true; break; }
      if (ecs.display !== 'inline') break;
    }

    const lines = [];
    let cur = null;
    for (const ch of chars) {
      if (!cur || ch.t > cur.t + size * 0.5) {
        cur = { t: ch.t, l: null, r: ch.r, s: '' };
        lines.push(cur);
      }
      if (cur.l === null && /\S/.test(ch.c)) cur.l = ch.l;
      if (cur.l !== null || /\S/.test(ch.c)) cur.s += ch.c;
      cur.r = Math.max(cur.r, ch.r);
    }
    for (const ln of lines) {
      const str = ln.s.replace(/\s+$/, '');
      if (!str || ln.l === null) continue;
      const op = {
        t: 'text', x: ln.l, y: Math.round(ln.t + asc), s: str,
        size, weight: cs.fontWeight, style: cs.fontStyle, fill: cs.color,
        family: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      };
      out.push(op);
      if (underline) {
        out.push({ t: 'rule', x: ln.l, y: Math.round(ln.t + asc) + Math.max(1, Math.round(size * 0.08)), w: ln.r - ln.l, h: Math.max(1, Math.round(size / 14)), fill: cs.textDecorationColor || cs.color });
      }
    }
  }

  function firstTextRect(el) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (!/\S/.test(n.data)) continue;
      const idx = n.data.search(/\S/);
      const range = document.createRange();
      range.setStart(n, idx);
      range.setEnd(n, idx + 1);
      const rr = range.getClientRects()[0];
      if (rr) return { rect: rr, cs: getComputedStyle(n.parentElement) };
    }
    return null;
  }

  function walk(el, out) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT'].includes(el.tagName)) return;
    const r = el.getBoundingClientRect();
    const g = { t: 'g', name: nameFor(el), kids: [] };

    const box = boxOp(el, cs, r);
    if (box) g.kids.push(box);

    if (el.tagName === 'IMG') {
      const bl = num(cs.borderLeftWidth), bt = num(cs.borderTopWidth);
      const rx0 = Math.round(r.left + bl + num(cs.paddingLeft)), ry0 = Math.round(r.top + bt + num(cs.paddingTop));
      const rx1 = Math.round(r.right - num(cs.borderRightWidth) - num(cs.paddingRight));
      const ry1 = Math.round(r.bottom - num(cs.borderBottomWidth) - num(cs.paddingBottom));
      const cx = rx0, cy = ry0, cw = rx1 - rx0, ch = ry1 - ry0;
      const nw = el.naturalWidth || cw, nh = el.naturalHeight || ch;
      let w = cw, h = ch;
      if (cs.objectFit === 'cover' || cs.objectFit === 'contain') {
        const sc = cs.objectFit === 'cover' ? Math.max(cw / nw, ch / nh) : Math.min(cw / nw, ch / nh);
        w = nw * sc; h = nh * sc;
      }
      const rad = radii(cs, r.width, r.height).map((v, i) => Math.max(0, v - Math.max(bl, bt)));
      g.kids.push({ t: 'img', src: el.currentSrc || el.src, x: cx + (cw - w) / 2, y: cy + (ch - h) / 2, w, h, clip: { x: cx, y: cy, w: cw, h: ch, rad } });
    } else if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
      g.kids.push({ t: 'radio', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), checked: el.checked, kind: el.type });
    } else if (el.tagName === 'INPUT') {
      const txt = el.value || el.placeholder;
      if (txt) {
        const tcs = el.value ? cs : getComputedStyle(el, '::placeholder');
        const { asc, desc } = fontMetrics(cs);
        const padL = num(cs.paddingLeft), padT = num(cs.paddingTop);
        const innerTop = r.top + num(cs.borderTopWidth) + padT;
        const innerH = r.height - num(cs.borderTopWidth) - num(cs.borderBottomWidth) - padT - num(cs.paddingBottom);
        const lineH = Math.round(asc) + Math.round(desc);
        g.kids.push({
          t: 'text', x: r.left + num(cs.borderLeftWidth) + padL, y: innerTop + (innerH - lineH) / 2 + Math.round(asc), s: txt,
          size: num(cs.fontSize), weight: cs.fontWeight, style: cs.fontStyle, fill: tcs.color,
          family: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
        });
      }
    } else {
      if (cs.display === 'list-item' && cs.listStyleType !== 'none') {
        const ft = firstTextRect(el);
        if (ft) {
          const size = num(ft.cs.fontSize);
          const { asc } = fontMetrics(ft.cs);
          g.kids.push({ t: 'bullet', type: cs.listStyleType, x: r.left, baseline: ft.rect.top + asc, size, fill: cs.color });
        }
      }
      for (const n of el.childNodes) {
        if (n.nodeType === 1) walk(n, g.kids);
        else if (n.nodeType === 3) textOps(n, g.kids);
      }
    }

    if (!g.kids.length) return;
    // inline wrappers without a box of their own add no useful layer
    if (cs.display === 'inline' && !box) out.push(...g.kids);
    else out.push(g);
  }

  const body = document.body;
  const W = Math.max(document.documentElement.clientWidth, document.documentElement.scrollWidth);
  const H = Math.max(document.documentElement.scrollHeight, body.scrollHeight);
  const root = [];
  walk(body, root);
  const canvasBg = alpha(getComputedStyle(body).backgroundColor) > 0 ? getComputedStyle(body).backgroundColor : getComputedStyle(document.documentElement).backgroundColor;
  return { W, H, bg: canvasBg, tree: root };
}

/* ------------------------------------------------------------------ */
/* SVG serialisation                                                   */
/* ------------------------------------------------------------------ */
const f = (n) => +Number(n).toFixed(2);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function col(c) {
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  if (!m) return { hex: c, op: 1 };
  const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
  const hex = '#' + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { hex, op: p.length > 3 ? p[3] : 1 };
}
function paint(attr, c) {
  const { hex, op } = col(c);
  return `${attr}="${hex}"` + (op < 1 ? ` ${attr}-opacity="${f(op)}"` : '');
}

function roundedPath(x, y, w, h, r) {
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  return `M${f(x + tl)} ${f(y)}H${f(x + w - tr)}${tr ? `A${f(tr)} ${f(tr)} 0 0 1 ${f(x + w)} ${f(y + tr)}` : ''}` +
    `V${f(y + h - br)}${br ? `A${f(br)} ${f(br)} 0 0 1 ${f(x + w - br)} ${f(y + h)}` : ''}` +
    `H${f(x + bl)}${bl ? `A${f(bl)} ${f(bl)} 0 0 1 ${f(x)} ${f(y + h - bl)}` : ''}` +
    `V${f(y + tl)}${tl ? `A${f(tl)} ${f(tl)} 0 0 1 ${f(x + tl)} ${f(y)}` : ''}Z`;
}

function shape(x, y, w, h, rad, attrs, id) {
  const idAttr = id ? ` id="${id}"` : '';
  if (rad.every((v) => v === rad[0])) {
    const r = Math.min(rad[0], w / 2, h / 2);
    return `<rect${idAttr} x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${r ? ` rx="${f(r)}"` : ''} ${attrs}/>`;
  }
  return `<path${idAttr} d="${roundedPath(x, y, w, h, rad)}" ${attrs}/>`;
}

function build(data, dataUri) {
  let clipN = 0;
  const defs = [];
  const boxN = {};
  const nm = (base) => { boxN[base] = (boxN[base] || 0) + 1; return boxN[base] === 1 ? base : base + '-' + boxN[base]; };

  function ser(op, ind, parent) {
    const pad = ' '.repeat(ind);
    switch (op.t) {
      case 'g': {
        const inner = op.kids.map((k) => ser(k, ind + 2, op)).filter(Boolean).join('\n');
        if (!inner) return '';
        return `${pad}<g id="${op.name}">\n${inner}\n${pad}</g>`;
      }
      case 'box': {
        const uniform = op.bw[0] > 0 && op.bw.every((v) => v === op.bw[0]) && op.bc.every((c) => c === op.bc[0]);
        const label = nm(parent && parent.name ? parent.name + '-bg' : 'box');
        if (op.lines) {
          const parts = [];
          if (op.fill) parts.push(shape(op.x, op.y, op.w, op.h, op.rad, paint('fill', op.fill), label));
          for (const l of op.lines) parts.push(`<rect id="${nm(label + '-border-' + l.side)}" x="${f(l.x)}" y="${f(l.y)}" width="${f(l.w)}" height="${f(l.h)}" ${paint('fill', l.c)}/>`);
          return parts.map((p) => pad + p).join('\n');
        }
        if (uniform) {
          const bw = op.bw[0], i = bw / 2;
          const rad = op.rad.map((v) => Math.max(0, v - i));
          const attrs = (op.fill ? paint('fill', op.fill) : 'fill="none"') + ' ' + paint('stroke', op.bc[0]) + ` stroke-width="${f(bw)}"`;
          return pad + shape(op.x + i, op.y + i, op.w - bw, op.h - bw, rad, attrs, label);
        }
        const parts = [];
        if (op.fill) parts.push(shape(op.x, op.y, op.w, op.h, op.rad, paint('fill', op.fill), label));
        const strips = [];
        const [bt, br, bb, bl] = op.bw;
        if (bt) strips.push([op.x, op.y, op.w, bt, op.bc[0], 'top']);
        if (bb) strips.push([op.x, op.y + op.h - bb, op.w, bb, op.bc[2], 'bottom']);
        if (bl) strips.push([op.x, op.y, bl, op.h, op.bc[3], 'left']);
        if (br) strips.push([op.x + op.w - br, op.y, br, op.h, op.bc[1], 'right']);
        const stripSvg = strips.map(([x, y, w, h, c, side]) => `<rect id="${nm(label + '-border-' + side)}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${paint('fill', c)}/>`);
        if (op.rad.some((v) => v > 0)) {
          const cid = 'clip-' + ++clipN;
          defs.push(`<clipPath id="${cid}">${shape(op.x, op.y, op.w, op.h, op.rad, '')}</clipPath>`);
          parts.push(`<g clip-path="url(#${cid})">${stripSvg.join('')}</g>`);
        } else parts.push(...stripSvg);
        return parts.map((p) => pad + p).join('\n');
      }
      case 'rule':
        return `${pad}<rect x="${f(op.x)}" y="${f(op.y)}" width="${f(op.w)}" height="${f(op.h)}" ${paint('fill', op.fill)}/>`;
      case 'text': {
        const w = /^(bold|[6-9]00)$/.test(op.weight) ? 700 : 400;
        return `${pad}<text x="${f(op.x)}" y="${f(op.y)}" font-family="${esc(op.family)}" font-size="${f(op.size)}" font-weight="${w}"` +
          `${op.style === 'italic' ? ' font-style="italic"' : ''} ${paint('fill', op.fill)} xml:space="preserve">${esc(op.s)}</text>`;
      }
      case 'img': {
        const c = op.clip;
        const needClip = c.rad.some((v) => v > 0) || Math.abs(op.w - c.w) > 0.01 || Math.abs(op.h - c.h) > 0.01;
        const file = decodeURIComponent(new URL(op.src).pathname.replace(/^\//, ''));
        if (file.toLowerCase().endsWith('.svg')) {
          const src = fs.readFileSync(file, 'utf8');
          const vb = (src.match(/viewBox="([^"]+)"/) || [])[1].split(/\s+/).map(Number);
          const sc = Math.min(op.w / vb[2], op.h / vb[3]);
          const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
            .replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n').trim();
          return `${pad}<g transform="translate(${f(op.x)} ${f(op.y)}) scale(${f(sc)})" fill="none">\n${inner}\n${pad}</g>`;
        }
        const image = `<image x="${f(op.x)}" y="${f(op.y)}" width="${f(op.w)}" height="${f(op.h)}" preserveAspectRatio="none" xlink:href="${dataUri(file)}"/>`;
        if (!needClip) return pad + image;
        const cid = 'clip-' + ++clipN;
        defs.push(`<clipPath id="${cid}">${shape(c.x, c.y, c.w, c.h, c.rad, '')}</clipPath>`);
        return `${pad}<g clip-path="url(#${cid})">${image}</g>`;
      }
      case 'radio': {
        const cx = op.x + op.w / 2, cy = op.y + op.h / 2, r = op.w / 2;
        if (op.kind === 'radio') {
          const blue = '#0075ff';
          const ring = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r - 0.5)}" fill="#ffffff" stroke="${op.checked ? blue : '#767676'}" stroke-width="1"/>`;
          const dot = op.checked ? `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r - 3)}" fill="${blue}"/>` : '';
          return `${pad}<g id="${nm('radio' + (op.checked ? '-checked' : ''))}">${ring}${dot}</g>`;
        }
        return '';
      }
      case 'bullet': {
        if (op.type !== 'disc') return '';
        const d = Math.round(op.size * 0.3);
        return `${pad}<circle id="${nm('bullet')}" cx="${f(Math.round(op.x - op.size * 0.93))}" cy="${f(Math.round(op.baseline) - Math.round(op.size * 0.286))}" r="${f(d / 2)}" ${paint('fill', op.fill)}/>`;
      }
    }
    return '';
  }

  const body = data.tree.map((t) => ser(t, 4, null)).filter(Boolean).join('\n');
  const mime = (file) => (file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
  return { body, defs: defs.join('\n  '), mime };
}

function svgFor(title, data) {
  const cache = {};
  const dataUri = (file) => {
    if (!cache[file]) {
      const mime = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      cache[file] = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
    return cache[file];
  };
  const { body, defs } = build(data, dataUri);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${data.W}" height="${data.H}" viewBox="0 0 ${data.W} ${data.H}">
  <title>${esc(title)}</title>
  <defs>
  ${defs}
  </defs>
  <g id="${esc(title)}">
    <rect id="page-background" width="${data.W}" height="${data.H}" ${paint('fill', data.bg)}/>
${body}
  </g>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */
async function main() {
  const verify = process.argv.includes('--verify');
  const only = process.argv.find((a) => a.startsWith('--only='));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
  const report = [];
  try {
    for (const [vpName, width, height] of VIEWPORTS) {
      for (const [file, label] of PAGES) {
        const title = `${label}-${vpName}`;
        if (only && !title.toLowerCase().includes(only.slice(7).toLowerCase())) continue;
        const page = await browser.newPage();
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.goto(pathToFileURL(path.join(ROOT, file + '.html')).href, { waitUntil: 'load' });
        await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
        const data = await page.evaluate(extract);
        const svgPath = path.join(OUT, `${title}.svg`);
        fs.writeFileSync(svgPath, svgFor(title, data));
        console.log(`wrote ${path.relative(ROOT, svgPath)}  ${data.W}x${data.H}  ${(fs.statSync(svgPath).size / 1024).toFixed(0)} KB`);

        if (verify) {
          const { PNG } = require('pngjs');
          const pixelmatch = require('pixelmatch');
          const a = PNG.sync.read(await page.screenshot({ fullPage: true }));
          const p2 = await browser.newPage();
          await p2.setViewport({ width, height, deviceScaleFactor: 1 });
          await p2.goto(pathToFileURL(svgPath).href, { waitUntil: 'load' });
          const b = PNG.sync.read(await p2.screenshot({ clip: { x: 0, y: 0, width: data.W, height: data.H } }));
          await p2.close();
          const diff = new PNG({ width: a.width, height: a.height });
          const h = Math.min(a.height, b.height);
          const n = pixelmatch(a.data, b.data.length === a.data.length ? b.data : Buffer.alloc(a.data.length), diff.data, a.width, h, { threshold: 0.1 });
          const dir = path.join(process.env.VERIFY_DIR || OUT, '_verify');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${title}-html.png`), PNG.sync.write(a));
          fs.writeFileSync(path.join(dir, `${title}-svg.png`), PNG.sync.write(b));
          fs.writeFileSync(path.join(dir, `${title}-diff.png`), PNG.sync.write(diff));
          report.push(`${title}: ${n} px differ of ${a.width * a.height} (${((n / (a.width * a.height)) * 100).toFixed(3)}%)  html ${a.width}x${a.height} svg ${b.width}x${b.height}`);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (report.length) console.log('\n' + report.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
