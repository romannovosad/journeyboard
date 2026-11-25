/* journeyboard viewer. Reads index.json (built by src/build-site.mjs) and renders it.
 * Routes (hash):
 *   #/                                    the board, as on the base branch
 *   #/board/<platform>[/<repo>/<slug>]    the board for a platform, with a branch marked on it
 *   #/flow/<platform>/<flow>              a flow's screens in order
 *   #/screen/<platform>/<flow>/<step>     one screen, full size, with its history
 *   #/branch/<repo>/<slug>                what a branch changes, and its mockups
 * No framework; every value from the data goes in through textContent or an attribute.
 */
(function () {
  'use strict';

  // Filled from index.json's `config` (journeyboard.config.json) once it loads.
  let PLATFORMS = [];
  let ORG = '';
  let BASE = 'main';
  const app = document.getElementById('app');
  const picker = document.getElementById('branch-picker');
  const updated = document.getElementById('updated');
  let index = null;

  /** Tiny element builder: h('a', { href }, 'text', child). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const present = (...children) => children.filter((c) => c !== null && c !== undefined && c !== false);
  const pretty = (name) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const date = (iso) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const platformInfo = (id) => {
    const p = PLATFORMS.find((x) => x.id === id) || { id, label: pretty(id) };
    return { ...p, repo: p.repo || (index && index.config && index.config.repo) || '' };
  };

  // A baseline run that covered several merges records them all, as an array.
  function prLink(pr, repo) {
    if (!pr) return null;
    if (Array.isArray(pr)) return pr.flatMap((n, i) => [i ? ', ' : '', prLink(n, repo)]);
    const full = repo.includes('/') ? repo : ORG ? `${ORG}/${repo}` : '';
    if (!full) return h('span', {}, `#${pr}`);
    return h('a', { href: `https://github.com/${full}/pull/${pr}`, target: '_blank', rel: 'noopener' }, `#${pr}`);
  }

  function prText(pr) {
    return (Array.isArray(pr) ? pr : [pr]).map((n) => `#${n}`).join(', ');
  }

  function img(src, alt, eager) {
    return h('a', { href: src, target: '_blank', rel: 'noopener', title: 'Open full size' },
      h('img', { src, alt, loading: eager ? 'eager' : 'lazy' }));
  }

  function badge(status) {
    if (!status || status === 'unchanged') return null;
    const text = { new: 'new', changed: 'changed', removed: 'removed' }[status] || status;
    return h('span', { class: `badge ${status}` }, text);
  }

  function crumbs(...parts) {
    const out = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
    parts.forEach((part, i) => {
      if (i) out.append(' / ');
      out.append(part);
    });
    return out;
  }

  // ---------- data lookups ----------

  function flowsOf(platform) {
    return (index.platforms[platform] && index.platforms[platform].flows) || [];
  }

  function findScreen(platform, flow, step) {
    const f = flowsOf(platform).find((x) => x.flow === flow);
    return f && f.steps.find((s) => s.step === step);
  }

  function findBranch(repo, slug) {
    return index.branches.find((b) => b.repo === repo && b.slug === slug);
  }

  // ---------- views ----------

  // ---------- the board ----------

  // Card sizes per shape, in board pixels at 100%. The config gives each platform its shape: phones portrait, the
  // rest landscape. A platform with pictures but missing from the config gets a landscape board.
  const SIZES = {
    landscape: { w: 260, thumb: 163 },
    portrait: { w: 150, thumb: 300 },
  };
  const BODY_H = 50;
  const GAP_X = 110;
  const GAP_Y = 36;
  const LANE_HEAD = 38;
  const LANE_GAP = 28;
  const PAD = 40;
  const SVG = 'http://www.w3.org/2000/svg';

  let board = null; // the live board: { el, layer, x, y, k, w, h, ... }

  function s(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
    return el;
  }

  function boardsFor(branch) {
    if (branch) return branch.boards || {};
    const out = {};
    for (const p of PLATFORMS) if (index.platforms[p.id] && index.platforms[p.id].board) out[p.id] = index.platforms[p.id].board;
    return out;
  }

  function boardHref(platform, branch) {
    return `#/board/${platform}${branch ? `/${encodeURIComponent(branch.repo)}/${encodeURIComponent(branch.slug)}` : ''}`;
  }

  /** Pixel geometry for a board: where each lane and grid cell sits. */
  function geometry(data, platform) {
    const size = SIZES[platformInfo(platform).shape] || SIZES.landscape;
    const cardH = size.thumb + BODY_H;
    const laneTop = new Map();
    let y = PAD;
    for (const lane of data.lanes) {
      laneTop.set(lane.row, y);
      y += LANE_HEAD + lane.rows * (cardH + GAP_Y) - GAP_Y + LANE_GAP;
    }
    const laneOf = (row) => data.lanes.find((l) => row >= l.row && row < l.row + l.rows);
    const at = (col, row) => {
      const lane = laneOf(row);
      return { x: PAD + col * (size.w + GAP_X), y: laneTop.get(lane.row) + LANE_HEAD + (row - lane.row) * (cardH + GAP_Y) };
    };
    const width = PAD * 2 + Math.max(1, data.cols) * (size.w + GAP_X) - GAP_X;
    return { size, cardH, laneTop, at, width, height: y - LANE_GAP + PAD };
  }

  /** A polyline with rounded corners. */
  function rounded(points, radius) {
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i += 1) {
      const [px, py] = points[i - 1];
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      const r1 = Math.min(radius, Math.hypot(x - px, y - py) / 2);
      const r2 = Math.min(radius, Math.hypot(nx - x, ny - y) / 2);
      const ax = x - Math.sign(x - px) * r1;
      const ay = y - Math.sign(y - py) * r1;
      const bx = x + Math.sign(nx - x) * r2;
      const by = y + Math.sign(ny - y) * r2;
      d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
    }
    const last = points[points.length - 1];
    return `${d} L ${last[0]} ${last[1]}`;
  }

  /**
   * Arrows never pass behind a card. Between neighbouring columns of one lane: a curve, which stays in the gap between
   * the two columns. Anything else runs in the gaps: out of the source's right edge, along the column gap after it,
   * along the row gap next to the target, and into the target's top (or bottom, when it lies above).
   */
  function arrowPath(a, b, g, neighbours) {
    const w = g.size.w;
    const h = g.cardH;
    if (neighbours) {
      const x1 = a.x + w;
      const y1 = a.y + h / 2;
      const x2 = b.x;
      const y2 = b.y + h / 2;
      const dx = (x2 - x1) / 2;
      return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 6} ${y2}`;
    }
    const gutter = a.x + w + GAP_X / 2;
    const fromAbove = b.y > a.y || (b.y === a.y && b.x > a.x);
    const channel = fromAbove ? b.y - GAP_Y / 2 + 4 : b.y + h + GAP_Y / 2 - 4;
    const end = fromAbove ? b.y - 6 : b.y + h + 6;
    const cx = b.x + w / 2;
    return rounded([[a.x + w, a.y + h / 2], [gutter, a.y + h / 2], [gutter, channel], [cx, channel], [cx, end]], 12);
  }

  /** A mockup hangs under its target: a straight line when nothing sits between, else round by the column gap. */
  function mockupPath(m, t, g, clear) {
    const w = g.size.w;
    const h = g.cardH;
    if (clear) return `M ${m.x + w / 2} ${m.y} L ${t.x + w / 2} ${t.y + h}`;
    const gutter = m.x + w + GAP_X / 3;
    return rounded([[m.x + w, m.y + h / 2], [gutter, m.y + h / 2], [gutter, t.y + h * 0.8], [t.x + w, t.y + h * 0.8]], 12);
  }

  function viewBoard(platform, repo, slug) {
    const branch = repo ? findBranch(repo, slug) : null;
    if (repo && !branch) return notFound('This branch has no screenshots or mockups, or its PR has closed.');
    const boards = boardsFor(branch);
    const available = PLATFORMS.filter((p) => boards[p.id]);
    if (!available.length) return [h('h1', {}, 'No screens yet'), h('p', { class: 'muted' }, `The board fills up as the tests run on ${BASE}.`)];
    if (!boards[platform]) platform = available[0].id;
    const data = boards[platform];
    const g = geometry(data, platform);
    const repoOfPlatform = platformInfo(platform).repo;

    // Toolbar: platforms, what is shown, zoom.
    const tabs = h('nav', { class: 'tabs', 'aria-label': 'Platform' },
      available.map((p) => h('a', { href: boardHref(p.id, branch), 'aria-current': p.id === platform ? 'page' : null }, p.label)));
    const info = h('div', { class: 'board-info' });
    if (branch) {
      const marked = (st) => data.cards.filter((c) => c.status === st).length;
      const run = branch.platforms && branch.platforms[platform];
      // A plain DOM append() would print a null as text; present() drops them.
      info.append(...present(
        h('strong', {}, branch.branch || branch.slug),
        branch.pr ? h('span', {}, 'PR ', prLink(branch.pr, branch.repo)) : null,
        run ? h('span', {}, h('span', { class: 'badge changed' }, `${marked('changed')} changed`), h('span', { class: 'badge new' }, `${marked('new')} new`),
          run.removed.length ? h('span', { class: 'badge removed' }, `${run.removed.length} no longer captured`) : null)
          : h('span', { class: 'muted' }, `No screenshots yet: mockups on the ${BASE} board`),
        data.mockups.length ? h('span', { class: 'badge mockup' }, `${data.mockups.length} mockup${data.mockups.length === 1 ? '' : 's'}`) : null,
        h('a', { href: `#/branch/${encodeURIComponent(branch.repo)}/${encodeURIComponent(branch.slug)}` }, 'Side by side')));
    } else {
      const p = index.platforms[platform] || {};
      info.append(h('span', { class: 'muted' }, `As on ${BASE}${p.updatedAt ? `, ${date(p.updatedAt)}` : ''}`, p.commit ? ' · ' : '', p.commit ? h('code', {}, p.commit.slice(0, 7)) : null));
      const removed = p.removed || [];
      if (removed.length) {
        info.append(h('details', { class: 'removed-list' }, h('summary', {}, `${removed.length} no longer captured`),
          h('div', {}, removed.map((r) => h('a', { href: `#/screen/${platform}/${r.flow}/${r.step}` }, `${r.flow}/${r.step}`)))));
      }
    }
    const zoomLabel = h('span', { class: 'zoom-label', 'aria-live': 'polite' }, '100%');
    const btn = (label, title, onClick) => {
      const b = h('button', { type: 'button', title, 'aria-label': title }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    const zoom = h('div', { class: 'zoom' },
      btn('−', 'Zoom out', () => zoomBy(1 / 1.25)), zoomLabel, btn('+', 'Zoom in', () => zoomBy(1.25)), btn('Fit', 'Fit all', fit));
    const bar = h('div', { class: 'board-bar' }, tabs, info, zoom);

    // The board itself.
    const layer = h('div', { class: 'layer' });
    layer.style.width = `${g.width}px`;
    layer.style.height = `${g.height}px`;

    for (const lane of data.lanes) {
      const top = g.laneTop.get(lane.row);
      const height = LANE_HEAD + lane.rows * (g.cardH + GAP_Y) - GAP_Y;
      const el = h('div', { class: `lane${lane.flow ? '' : ' lane-design'}` },
        h('span', { class: 'lane-label' }, lane.flow ? pretty(lane.flow) : 'Mockups for screens not built yet'));
      Object.assign(el.style, { top: `${top - 10}px`, height: `${height + 20}px`, width: `${g.width - PAD}px`, left: `${PAD / 2}px` });
      layer.append(el);
    }

    const svg = s('svg', { class: 'arrows', width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, 'aria-hidden': 'true' });
    const defs = s('defs');
    for (const kind of ['plain', 'new']) {
      const marker = s('marker', { id: `head-${kind}`, viewBox: '0 0 10 10', refX: 4, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' });
      marker.append(s('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `head ${kind}` }));
      defs.append(marker);
    }
    svg.append(defs);
    layer.append(svg);

    const pos = new Map(data.cards.map((c) => [c.key, g.at(c.col, c.row)]));
    const cardByKey = new Map(data.cards.map((c) => [c.key, c]));
    for (const a of data.arrows) {
      const from = pos.get(a.from);
      const to = pos.get(a.to);
      if (!from || !to) continue;
      const fresh = cardByKey.get(a.to).status === 'new';
      const cross = cardByKey.get(a.from).flow !== cardByKey.get(a.to).flow;
      const neighbours = !cross && cardByKey.get(a.to).col === cardByKey.get(a.from).col + 1;
      svg.append(s('path', { d: arrowPath(from, to, g, neighbours), class: `arrow${cross ? ' cross' : ''}${fresh ? ' new' : ''}`, 'marker-end': `url(#head-${fresh ? 'new' : 'plain'})` }));
    }

    const cardEls = new Map();
    const place = (el, p) => Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${g.size.w}px`, height: `${g.cardH}px` });
    for (const c of data.cards) {
      const marked = c.status === 'new' || c.status === 'changed';
      const href = marked ? c.image : `#/screen/${platform}/${c.flow}/${c.step}`;
      const el = h('a', { class: `bcard${marked ? ` ${c.status}` : ''}`, href, target: marked ? '_blank' : null, rel: marked ? 'noopener' : null, 'data-key': c.key,
        title: `${c.title || pretty(c.step)} (${c.key})${marked ? ': opens this branch’s picture' : ''}` },
        h('div', { class: 'thumb' }, h('img', { 'data-src': c.image, alt: c.title || c.step, draggable: 'false', decoding: 'async' })),
        h('div', { class: 'body' }, h('div', { class: 'title' }, c.title || pretty(c.step), marked ? badge(c.status) : null), h('code', {}, c.key)));
      el.querySelector('.thumb').style.height = `${g.size.thumb}px`;
      place(el, pos.get(c.key));
      layer.append(el);
      cardEls.set(c.key, el);
    }

    for (const m of data.mockups) {
      const p = g.at(m.col, m.row);
      const target = pos.get(m.target);
      if (target) {
        const t = cardByKey.get(m.target);
        const clear = !data.cards.some((c) => c.col === m.col && c.row > t.row && c.row < m.row) &&
          !data.mockups.some((o) => o !== m && o.col === m.col && o.row > t.row && o.row < m.row);
        svg.append(s('path', { class: 'mockup-line', d: mockupPath(p, target, g, clear) }));
      }
      const el = h('a', { class: 'bcard mockup', href: m.html || m.image, target: '_blank', rel: 'noopener', title: `Mockup for ${m.target}` },
        h('div', { class: 'thumb' }, h('img', { 'data-src': m.image, alt: `Mockup, option ${m.option}`, draggable: 'false', decoding: 'async' })),
        h('div', { class: 'body' }, h('div', { class: 'title' }, `Option ${String(m.option).toUpperCase()}`, m.title ? `: ${m.title}` : '', h('span', { class: 'badge mockup' }, 'mockup')),
          h('code', {}, target ? `for ${m.target}` : `${m.target}, not built yet`)));
      el.querySelector('.thumb').style.height = `${g.size.thumb}px`;
      place(el, p);
      layer.append(el);
    }

    const el = h('div', { class: 'board', tabindex: '0', role: 'application', 'aria-label': `${platformInfo(platform).label} journey board. Drag to move, scroll or pinch to zoom, 0 to fit.` }, layer);
    board = { el, layer, zoomLabel, g, cardEls, x: 0, y: 0, k: 1, platform, repo: repoOfPlatform, touched: false, frame: null };
    wireBoard(board);
    return [h('section', { class: 'board-view' }, bar, el)];
  }

  // ---------- pan and zoom ----------

  const MIN_K = 0.04;
  const MAX_K = 2.5;
  let loadTimer = 0;

  function apply() {
    const b = board;
    b.layer.style.transform = `translate(${b.x}px, ${b.y}px) scale(${b.k})`;
    const label = `${Math.round(b.k * 100)}%`;
    // The label is a live region: rewrite it only when the number changes, not on every pan.
    if (b.zoomLabel.textContent !== label) b.zoomLabel.textContent = label;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadVisible, 120);
  }

  /** Loads the pictures of cards on screen, once they are big enough to see. Off-screen ones wait. */
  function loadVisible() {
    const b = board;
    // Full screenshots are big: when a card's longer side is under 100 px on screen it shows its title only, so
    // fitting a board of a few hundred screens doesn't decode them all. A board of a few dozen fits above it.
    if (!b || !b.el.isConnected || Math.max(b.g.size.w, b.g.size.thumb) * b.k < 100) return;
    const view = b.el.getBoundingClientRect();
    const margin = 300;
    for (const img of b.layer.querySelectorAll('img[data-src]')) {
      const r = img.getBoundingClientRect();
      if (r.right > view.left - margin && r.left < view.right + margin && r.bottom > view.top - margin && r.top < view.bottom + margin) {
        img.src = img.getAttribute('data-src');
        img.removeAttribute('data-src');
      }
    }
  }

  function zoomAt(factor, cx, cy) {
    const b = board;
    b.touched = true;
    const k = Math.min(MAX_K, Math.max(MIN_K, b.k * factor));
    b.x = cx - ((cx - b.x) * k) / b.k;
    b.y = cy - ((cy - b.y) * k) / b.k;
    b.k = k;
    apply();
  }

  function zoomBy(factor) {
    const r = board.el.getBoundingClientRect();
    zoomAt(factor, r.width / 2, r.height / 2);
  }

  function fit() {
    const b = board;
    const r = b.el.getBoundingClientRect();
    b.k = Math.min(1, Math.max(MIN_K, Math.min(r.width / b.g.width, r.height / b.g.height)));
    b.x = (r.width - b.g.width * b.k) / 2;
    b.y = Math.max(0, (r.height - b.g.height * b.k) / 2);
    apply();
  }

  /** Centres one card at a readable size and marks it for a moment. */
  function focusCard(key) {
    const b = board;
    const el = b.cardEls.get(key);
    if (!el) return fit();
    const r = b.el.getBoundingClientRect();
    b.k = Math.min(1, Math.max(0.5, Math.min(r.width / (b.g.size.w * 3.2), r.height / (b.g.cardH * 2.2))));
    b.x = r.width / 2 - (el.offsetLeft + b.g.size.w / 2) * b.k;
    b.y = r.height / 2 - (el.offsetTop + b.g.cardH / 2) * b.k;
    apply();
    // Mark it once: the opening view is re-applied while the page settles.
    if (b.flashed) return;
    b.flashed = true;
    el.classList.add('focused');
    setTimeout(() => el.classList.remove('focused'), 2600);
  }

  function wireBoard(b) {
    const pointers = new Map();
    let moved = false;
    let start = null;
    let pinch = null;
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) b.el.classList.remove('dragging');
    };
    const local = (e) => {
      const r = b.el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    b.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, local(e));
      start = local(e);
      moved = false;
      if (pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        pinch = d > 1 ? { d, k: b.k } : null;
      }
    });
    b.el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      // A press released outside the board leaves its pointer behind; a mouse moving with no button down is not a
      // drag.
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        end(e);
        return;
      }
      const before = pointers.get(e.pointerId);
      const now = local(e);
      pointers.set(e.pointerId, now);
      if (pointers.size === 1) {
        // A few pixels of wobble during a click is not a drag.
        if (!moved && Math.hypot(now.x - start.x, now.y - start.y) < 5) {
          pointers.set(e.pointerId, before);
          return;
        }
        if (!moved) {
          moved = true;
          b.touched = true;
          // Capture only once it is a drag, so a plain click still reaches the card's link.
          try {
            b.el.setPointerCapture(e.pointerId);
          } catch {
            // The pointer already ended; the drag still works without capture.
          }
          b.el.classList.add('dragging');
        }
        b.x += now.x - before.x;
        b.y += now.y - before.y;
        apply();
      } else if (pointers.size === 2 && pinch) {
        moved = true;
        const [p, q] = [...pointers.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        zoomAt((pinch.k * d) / pinch.d / b.k, (p.x + q.x) / 2, (p.y + q.y) / 2);
      }
    });
    b.el.addEventListener('pointerup', end);
    b.el.addEventListener('pointercancel', end);
    // A drag that ends on a card is not a click on it.
    b.el.addEventListener('click', (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    }, true);
    b.el.addEventListener('dragstart', (e) => e.preventDefault());
    b.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const lines = e.deltaMode === 1 ? 16 : 1;
      // A trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
      zoomAt(Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    }, { passive: false });
    b.el.addEventListener('keydown', (e) => {
      const step = 80;
      const keys = {
        '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(1 / 1.25), '0': fit,
        ArrowLeft: () => { b.x += step; apply(); }, ArrowRight: () => { b.x -= step; apply(); },
        ArrowUp: () => { b.y += step; apply(); }, ArrowDown: () => { b.y -= step; apply(); },
      };
      if (keys[e.key] && e.target === b.el) {
        e.preventDefault();
        b.touched = true;
        keys[e.key]();
      }
    });
    // Tabbing to a card off screen brings it into view.
    b.el.addEventListener('focusin', (e) => {
      const card = e.target.closest && e.target.closest('.bcard');
      // Keyboard focus only: a mouse press focuses the link too, and moving the board under the pointer then would
      // turn the click into a miss.
      if (!card || !card.matches(':focus-visible')) return;
      b.el.scrollTop = 0;
      b.el.scrollLeft = 0;
      const r = card.getBoundingClientRect();
      const v = b.el.getBoundingClientRect();
      if (r.left < v.left || r.right > v.right || r.top < v.top || r.bottom > v.bottom) {
        b.x += v.left + v.width / 2 - (r.left + r.width / 2);
        b.y += v.top + v.height / 2 - (r.top + r.height / 2);
        apply();
      }
    });
    // Until the person moves the board, keep the opening view (fit all, or the focused card) as the page settles
    // and when the window resizes.
    b.observer = new ResizeObserver(() => {
      if (board !== b) return;
      if (!b.touched && b.frame) b.frame();
      else loadVisible();
    });
    b.observer.observe(b.el);
  }

  function stepCard(platform, s, opts) {
    const o = opts || {};
    const href = o.href || `#/screen/${platform}/${s.flow}/${s.step}`;
    return h('a', { class: 'card', href },
      h('div', { class: 'thumb' }, h('img', { src: s.image, alt: s.title || s.step, loading: 'lazy' })),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, s.title || pretty(s.step), badge(o.status)),
        h('code', {}, `${s.flow}/${s.step}`),
        s.updatedAt ? h('div', { class: 'muted' }, `Changed ${date(s.updatedAt)}`, s.updatedPr ? ' in ' : '',
          s.updatedPr ? prText(s.updatedPr) : '') : null,
        o.note ? h('div', { class: 'muted' }, o.note) : null));
  }

  function viewFlow(platform, flow) {
    const f = flowsOf(platform).find((x) => x.flow === flow);
    if (!f) return notFound();
    const grid = h('div', { class: 'grid' }, f.steps.map((s) => stepCard(platform, s)));
    return [
      crumbs(h('a', { href: `#/board/${platform}` }, 'Board'), platformInfo(platform).label),
      h('h1', {}, pretty(flow)),
      h('p', { class: 'muted' }, 'In the order the test walks through them.'),
      grid,
    ];
  }

  function viewScreen(platform, flow, step) {
    const repo = platformInfo(platform).repo;
    let s = findScreen(platform, flow, step);
    let removed = false;
    if (!s) {
      const r = ((index.platforms[platform] || {}).removed || []).find((x) => x.flow === flow && x.step === step);
      if (!r) return notFound();
      s = r;
      removed = true;
    }
    const out = [
      crumbs(h('a', { href: `#/board/${platform}` }, 'Board'), platformInfo(platform).label,
        h('a', { href: `#/flow/${platform}/${flow}` }, pretty(flow))),
      h('h1', {}, s.title || pretty(step), removed ? badge('removed') : null),
      h('p', { class: 'muted' }, h('code', {}, `${flow}/${step}`),
        s.testTitle ? ` · taken by “${s.testTitle}”` : '',
        s.test ? [' in ', h('code', {}, s.test)] : ''),
    ];
    if (!removed) {
      out.push(h('p', { class: 'summary' },
        h('span', {}, 'Added ', date(s.addedAt), s.addedPr ? [' in ', prLink(s.addedPr, repo)] : ''),
        s.updatedAt !== s.addedAt ? h('span', {}, 'Last changed ', date(s.updatedAt), s.updatedPr ? [' in ', prLink(s.updatedPr, repo)] : '') : null));
      out.push(h('div', { class: 'screen' }, img(s.image, s.title || step, true)));
    } else {
      out.push(h('p', { class: 'muted' }, `No longer captured since ${date(s.removedAt)}.`));
    }
    const history = s.history || [];
    out.push(h('h2', {}, history.length ? 'Earlier versions' : 'No earlier versions'));
    if (history.length) {
      out.push(h('div', { class: 'history' }, history.map((v) =>
        h('div', { class: 'card' },
          h('div', { class: 'thumb' }, img(v.image, `Version until ${date(v.endedAt)}`)),
          h('div', { class: 'body' },
            h('div', {}, v.currentFrom ? `${date(v.currentFrom)} – ` : 'Until ', date(v.endedAt)),
            h('div', { class: 'muted' }, v.kind === 'removed' ? 'Removed' : 'Replaced',
              v.endedByPr ? [' in ', prLink(v.endedByPr, repo)] : ''))))));
    }
    return out;
  }

  function viewBranch(repo, slug) {
    const b = findBranch(repo, slug);
    if (!b) return notFound('This branch has no screenshots, or its PR has closed.');
    const out = [
      crumbs(h('a', { href: '#/' }, 'Board'), h('a', { href: boardHref(Object.keys(b.boards || {})[0] || 'web', b) }, 'This branch on the board'), 'Side by side'),
      h('h1', {}, b.branch || slug),
      h('p', { class: 'summary' },
        h('span', {}, repo),
        b.pr ? h('span', {}, 'PR ', prLink(b.pr, repo)) : null,
        b.publishedAt ? h('span', {}, `Taken ${date(b.publishedAt)}`) : null,
        b.commit ? h('code', {}, b.commit.slice(0, 7)) : null),
    ];

    if (b.design) {
      out.push(h('h2', {}, 'Design'));
      const grid = h('div', { class: 'grid' });
      for (const o of b.design.options || []) {
        const targets = (b.design.targets || []).filter((t) => t.option === o.id);
        const first = targets[0];
        grid.append(h('div', { class: 'card' },
          first ? h('div', { class: 'thumb' }, img(first.image, o.title || o.id)) : null,
          h('div', { class: 'body' },
            h('div', { class: 'title' }, `Option ${o.id.toUpperCase()}: `, o.title || ''),
            o.inspiredBy ? h('div', { class: 'muted' }, `Inspired by ${o.inspiredBy}`) : null,
            o.note ? h('div', { class: 'muted' }, o.note) : null,
            o.html ? h('a', { href: o.html, target: '_blank', rel: 'noopener' }, 'Open mockup') : null,
            targets.length ? h('div', { class: 'muted' }, 'Target: ', targets.flatMap((t, i) => [i ? ', ' : '', h('code', {}, `${t.flow}/${t.step}`)])) : null)));
      }
      out.push(grid);
    }

    const platforms = Object.entries(b.platforms || {});
    if (!platforms.length) out.push(h('p', { class: 'muted' }, 'No screenshots from this branch yet.'));

    for (const [platform, p] of platforms) {
      const label = platformInfo(platform).label;
      const changed = p.screens.filter((s) => s.status === 'changed');
      const added = p.screens.filter((s) => s.status === 'new');
      out.push(h('h2', {}, `${label}: ${changed.length} changed, ${added.length} new, ${p.removed.length} no longer captured`));

      const targets = ((b.design && b.design.targets) || []).filter((t) => t.platform === platform);
      for (const t of targets) {
        const built = p.screens.find((s) => s.flow === t.flow && s.step === t.step);
        out.push(h('h3', {}, `Design vs built · ${t.flow}/${t.step}`));
        out.push(h('div', { class: 'pair' },
          h('figure', {}, h('figcaption', {}, `Design, option ${t.option.toUpperCase()}`), img(t.image, 'Design')),
          h('figure', {}, h('figcaption', {}, 'Built'), built ? img(built.image, 'Built') : h('div', { class: 'empty' }, 'Not captured by any test yet.'))));
      }

      for (const s of changed) {
        const dev = findScreen(platform, s.flow, s.step);
        out.push(h('h3', {}, `${s.title || s.step} · ${s.flow}/${s.step}`));
        out.push(h('div', { class: 'pair' },
          h('figure', {}, h('figcaption', {}, BASE), dev ? img(dev.image, BASE) : h('div', { class: 'empty' }, `Not on ${BASE}`)),
          h('figure', {}, h('figcaption', {}, 'This branch'), img(s.image, 'This branch'))));
      }

      // The branch's flows in order, marked.
      const byFlow = new Map();
      for (const s of p.screens) {
        if (!byFlow.has(s.flow)) byFlow.set(s.flow, []);
        byFlow.get(s.flow).push(s);
      }
      for (const [flow, screens] of byFlow) {
        const touched = screens.some((s) => s.status !== 'unchanged') || p.removed.some((r) => r.flow === flow);
        if (!touched) continue;
        out.push(h('h3', {}, `Flow · ${pretty(flow)}`));
        const grid = h('div', { class: 'grid' }, screens.map((s) => stepCard(platform, s, { status: s.status, href: s.image })));
        for (const r of p.removed.filter((x) => x.flow === flow)) {
          const dev = findScreen(platform, r.flow, r.step);
          if (dev) grid.append(stepCard(platform, dev, { status: 'removed', note: 'Not captured on this branch' }));
        }
        out.push(grid);
      }
      const untouched = [...byFlow.keys()].filter((flow) => !byFlow.get(flow).some((s) => s.status !== 'unchanged') && !p.removed.some((r) => r.flow === flow));
      if (untouched.length) {
        out.push(h('p', { class: 'muted' }, 'Unchanged flows: ', untouched.flatMap((flow, i) => [i ? ', ' : '', h('a', { href: `#/flow/${platform}/${flow}` }, pretty(flow))])));
      }
    }
    return out;
  }

  function notFound(message) {
    return [h('h1', {}, 'Not found'), h('p', { class: 'muted' }, message || 'Nothing here.'), h('a', { href: '#/' }, 'Back to the board')];
  }

  // ---------- routing ----------

  let lastPlatform = 'web';
  let pendingFocus = null;

  function render() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const focus = pendingFocus;
    let view;
    pendingFocus = null;
    if (board && board.observer) board.observer.disconnect();
    board = null;
    if (parts[0] === 'board' && (parts.length === 2 || parts.length === 4)) view = viewBoard(parts[1], parts[2], parts[3]);
    else if (!parts.length) view = viewBoard(lastPlatform);
    else if (parts[0] === 'flow' && parts.length === 3) view = viewFlow(parts[1], parts[2]);
    else if (parts[0] === 'screen' && parts.length === 4) view = viewScreen(parts[1], parts[2], parts[3]);
    else if (parts[0] === 'branch' && parts.length === 3) view = viewBranch(parts[1], parts[2]);
    else view = notFound();

    document.body.classList.toggle('board-mode', Boolean(board));
    app.replaceChildren(...[view].flat());
    const branchKey = (parts[0] === 'board' && parts.length === 4) || parts[0] === 'branch' ? `${parts.at(-2)}/${parts.at(-1)}` : '';
    picker.value = branchKey;
    window.scrollTo(0, 0);
    if (board) {
      lastPlatform = board.platform;
      board.frame = focus ? () => focusCard(focus) : fit;
      board.frame();
    }
  }

  /**
   * Links from outside (the PR comment) carry where to land in the query string: `?branch=<repo>/<slug>&focus=
   * <flow>/<step>`, optionally `&platform=`. A #fragment would be lost on a first visit, when GitHub's sign-in
   * redirects through its login page. Turned into a board route here, then dropped from the address bar.
   */
  function takeQuery() {
    const q = new URLSearchParams(location.search);
    const wanted = q.get('branch');
    const focus = q.get('focus');
    if (!wanted && !focus) return;
    const cut = (wanted || '').indexOf('/');
    const branch = cut > 0 ? findBranch(wanted.slice(0, cut), wanted.slice(cut + 1)) : null;
    const boards = wanted ? (branch ? branch.boards || {} : {}) : boardsFor(null);
    const platforms = Object.keys(boards);
    // Prefer the platform the link names, then one where the focused screen is marked, then any that has it.
    const has = (p, marked) => boards[p].cards.some((c) => c.key === focus && (!marked || c.status !== 'unchanged'));
    const named = q.get('platform');
    const platform = (named && boards[named] ? named : null) || platforms.find((p) => has(p, true)) || platforms.find((p) => has(p, false)) || platforms[0] || 'web';
    const route = wanted
      ? `#/board/${platform}/${wanted.split('/').map(encodeURIComponent).join('/')}`
      : `#/board/${platform}`;
    pendingFocus = focus;
    history.replaceState(null, '', `${location.pathname}${route}`);
  }

  function fillPicker() {
    picker.append(h('option', { value: '' }, BASE));
    for (const b of index.branches) {
      const counts = Object.values(b.platforms || {}).reduce((n, p) => n + p.screens.filter((s) => s.status !== 'unchanged').length + p.removed.length, 0);
      picker.append(h('option', { value: `${b.repo}/${b.slug}` },
        `${b.branch || b.slug}${b.pr ? ` · #${b.pr}` : ''}${counts ? ` · ${counts} differ from ${BASE}` : ''}${b.design ? ' · design' : ''}`));
    }
    picker.addEventListener('change', () => {
      const [repo, ...rest] = picker.value.split('/');
      const branch = picker.value ? findBranch(repo, rest.join('/')) : null;
      const boards = boardsFor(branch);
      const platform = boards[lastPlatform] ? lastPlatform : Object.keys(boards)[0] || lastPlatform;
      location.hash = boardHref(platform, branch);
    });
  }

  // index.json over HTTP; opened from a folder (file://), fetch is blocked, so the same data comes from index.js.
  function loadIndex() {
    if (location.protocol === 'file:') {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'index.js';
        script.onload = () => (window.JOURNEYBOARD_INDEX ? resolve(window.JOURNEYBOARD_INDEX) : reject(new Error('index.js has no data')));
        script.onerror = () => reject(new Error('index.js is missing'));
        document.head.append(script);
      });
    }
    return fetch('index.json', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`index.json: ${r.status}`);
      return r.json();
    });
  }

  loadIndex()
    .then((data) => {
      index = data;
      const config = index.config || {};
      ORG = config.owner || '';
      BASE = config.baseBranch || 'main';
      PLATFORMS = (config.platforms || []).map((p) => ({ label: pretty(p.id), ...p }));
      // Platforms that have data but aren't in the config still show, after the configured ones.
      const seen = new Set(PLATFORMS.map((p) => p.id));
      const extra = new Set(Object.keys(index.platforms || {}));
      for (const b of index.branches || []) for (const id of Object.keys(b.boards || {})) extra.add(id);
      for (const id of [...extra].sort()) if (!seen.has(id)) PLATFORMS.push({ id, label: pretty(id) });
      if (config.title) {
        document.title = config.title;
        document.querySelector('.brand').textContent = config.title;
      }
      updated.textContent = `Updated ${date(index.generatedAt)}`;
      fillPicker();
      takeQuery();
      window.addEventListener('hashchange', render);
      render();
    })
    .catch((error) => {
      app.replaceChildren(h('h1', {}, 'Could not load the board'), h('p', { class: 'muted' }, error.message));
    });
})();
