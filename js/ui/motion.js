// Moving pieces on the map (tasks A-10, A-11), the game page only. E.Motion
// decides what moves and pulses; this plays it. The map is still redrawn
// whole, but each token keeps its element across drawings (matched by id)
// and walks from where it stood, by transform, with the Web Animations API.
// A beat plays the world first, then the people: region changes on the
// region's level (a short detour when the floor plan is up), then the local
// moves. Settings › Appearance › Map motion: on, reduced (quick fades, no
// pop-up or detour) or off.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $ } = U;

  const PACE = 140; // map units a second (CELL is 30: a room or two a second)
  const PAUSE = 160; // ms at each door
  const LONGEST = 2000;
  const SWEEP = 1000; // ms for a new holder's colour to cross a region
  const HOLD = 450; // ms the region level stays up after it has shifted
  let last = null; // E.Motion.snapshot of the last drawing, with its geometry
  let detour = null; // { restore() } while the region level is shown first

  const deviceReduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const mode = () => E.Motion.mode(E.settings.appearance, deviceReduced());
  const tokensIn = (root) => new Map([...root.querySelectorAll('.map-token[data-id]')].map((el) => [el.dataset.id, el]));
  const centre = (el) => {
    const c = el.querySelector('circle');
    return c ? { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) } : null;
  };
  const boxMid = (el) => { try { const b = el.getBBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; } catch (e) { return null; } };
  // The "You are here" pin on a region map: the middle of its box.
  const pinAt = (root) => { const pin = (root || $('mapPane')).querySelector('.you-here'); return pin ? boxMid(pin) : null; };
  // A region map's regions as drawn: id → { shape (a copy), outline, badges: {tag: copy} }.
  function regionsIn(root) {
    const out = new Map();
    root.querySelectorAll('.region-g[data-region]').forEach((g) => {
      const shape = g.querySelector('.region-shape');
      const badges = {};
      g.querySelectorAll('.region-badge[data-tag]').forEach((b) => { badges[b.dataset.tag] = b.cloneNode(true); });
      out.set(g.dataset.region, { shape: shape && shape.cloneNode(true), outline: shape && (shape.getAttribute('points') || shape.getAttribute('d')), badges });
    });
    return out;
  }

  function beforeMap() {
    // A detour still up (Next pressed again): put the floor plan back first.
    if (detour) detour.restore();
    const pane = $('mapPane');
    const old = tokensIn(pane);
    return { old, at: new Map([...old].map(([id, el]) => [id, centre(el)])), prev: last, pin: pinAt(), regions: regionsIn(pane) };
  }

  function afterMap(b) {
    const d = U.mapDrawn && U.mapDrawn();
    const now = d && U.state ? Object.assign(E.Motion.snapshot(U.state, { key: d.key, tokens: d.tokens, inView: d.inView, shown: U.uiShown, cut: U.uiCut }), { geom: d.geom }) : null;
    last = now;
    if (!b || !now) return;
    const fresh = tokensIn($('mapPane'));
    // The same place: each token keeps its element, with what it shows now.
    if (b.prev && b.prev.key === now.key) {
      fresh.forEach((el, id) => {
        const o = b.old.get(id);
        if (!o) return;
        [...o.attributes].forEach((a) => { if (!el.hasAttribute(a.name)) o.removeAttribute(a.name); });
        [...el.attributes].forEach((a) => o.setAttribute(a.name, a.value));
        o.innerHTML = el.innerHTML;
        el.replaceWith(o);
        fresh.set(id, o);
      });
    }
    const m = mode();
    if (m === 'off') return;
    const people = () => {
      let longest = 0;
      E.Motion.moves(U.state, b.prev, now).forEach((mv) => {
        let el = fresh.get(mv.id);
        const start = b.at.get(mv.id) || null;
        const end = el ? centre(el) : null;
        // Walked out of view: the old token walks to the door and fades there.
        if (!el) {
          const o = b.old.get(mv.id);
          const layer = document.querySelector('#mapPane svg .map-tokens') || document.querySelector('#mapPane svg');
          if (!o || !start || !layer) return;
          layer.appendChild(o);
          el = o;
        }
        const pts = E.Motion.points(now.geom, mv, start, end);
        if (!pts.length) return;
        const ms = walk(el, pts, end || start, m);
        if (!end) setTimeout(() => el.remove(), ms + 50);
        longest = Math.max(longest, ms);
      });
      longest = Math.max(longest, glidePin(b, now, m));
      pulse(E.Motion.pulses(b.prev, now));
      return longest;
    };
    const changes = E.Motion.regionChanges(U.state, b.prev, now);
    // The world first: on the region level drawn now, in place.
    if (changes.length && $('worldSvg') && b.prev && b.prev.key === now.key) {
      const ms = shift(b.regions, changes, m, $('mapPane'));
      setTimeout(() => { const t = people(); if (t && m === 'on') popUp(t); }, m === 'on' ? ms : 0);
      if (ms && m === 'on') popUp(ms + 200);
      return;
    }
    // The floor plan is up: the region's level for a moment, then back to
    // the people (a zoom-in, not literally).
    if (changes.length && m === 'on') {
      const pane = $('mapPane');
      const kept = [...pane.childNodes];
      const box = document.createElement('div');
      box.className = 'map-detour';
      const levelId = E.Motion.level(U.state, changes.map((c) => c.region));
      const from = now.turn === b.prev.turn ? b.prev.shown - 1 : -1;
      box.innerHTML = U.levelMapHtml(levelId, from);
      pane.replaceChildren(box);
      const before = regionsIn(box);
      box.innerHTML = U.levelMapHtml(levelId, now.shown - 1);
      const ms = shift(before, changes, m, box);
      let timer = null;
      const restore = () => {
        clearTimeout(timer);
        if (detour !== mine) return;
        detour = null;
        if (box.parentNode === pane) pane.replaceChildren(...kept);
      };
      const mine = { restore };
      detour = mine;
      popUp(ms + HOLD);
      timer = setTimeout(() => { restore(); const t = people(); if (t) popUp(t); }, ms + HOLD);
      return;
    }
    const t = people();
    if (t && m === 'on') popUp(t);
  }

  // Keyframes along the points, by transform from where the element is drawn
  // (anchor), timed by distance with a pause at each door. → ms
  function walk(el, pts, anchor, m) {
    el.getAnimations().forEach((a) => a.cancel());
    const at = (p) => `translate(${(p.x - anchor.x).toFixed(1)}px, ${(p.y - anchor.y).toFixed(1)}px)`;
    if (m === 'reduced') {
      // A quick fade where it was, and in where it is.
      const a = pts.find((p) => p.o) || pts[0], z = [...pts].reverse().find((p) => p.o) || pts[pts.length - 1];
      el.animate([{ transform: at(a), opacity: 1 }, { transform: at(a), opacity: 0, offset: 0.45 }, { transform: at(z), opacity: 0, offset: 0.55 }, { transform: at(z), opacity: 1 }], { duration: 360 });
      return 360;
    }
    const times = [0];
    for (let i = 1; i < pts.length; i++) {
      const dist = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      times.push(times[i - 1] + Math.max(pts[i].o !== pts[i - 1].o ? 160 : 0, (dist / PACE) * 1000) + (pts[i - 1].pause ? PAUSE : 0));
    }
    const total = times[times.length - 1] || 1;
    const scale = total > LONGEST ? LONGEST / total : 1;
    el.animate(pts.map((p, i) => ({ transform: at(p), opacity: p.o, offset: times[i] / total })), { duration: total * scale, easing: 'linear' });
    return total * scale;
  }

  // ---------- territory (task A-11) ----------
  // Each change on the region level in root, from what was drawn before
  // (regionsIn): a new holder's colour sweeping in from a neighbour it holds
  // (else a crossfade), an outline morphing, tags fading in and out, and a
  // pulse for presence, contested and status. → ms
  function shift(before, changes, m, root) {
    const svg = root.querySelector('svg.world-svg');
    if (!svg) return 0;
    const at = (E.Engine.sceneRegions(U.state, (U.uiCut || U.uiShown) - 1) || {}).regions;
    let longest = 0;
    changes.forEach((c) => {
      const g = svg.querySelector(`.region-g[data-region="${CSS.escape(c.region)}"]`);
      const was = before.get(c.region);
      if (!g || !was) return;
      const shape = g.querySelector('.region-shape');
      if (c.controller && shape && was.shape) {
        const old = was.shape.cloneNode(true);
        old.classList.add('region-was');
        old.classList.remove('selected', 'here', 'branch');
        shape.after(old);
        const front = m === 'on' && E.Motion.front(U.state, c.region, c.controller[1], at);
        const fg = front && svg.querySelector(`.region-g[data-region="${CSS.escape(front)}"] .region-shape`);
        longest = Math.max(longest, fg ? sweep(svg, old, fg) : fade(old, m === 'on' ? 700 : 300, true));
      }
      // An outline that moved (task A-11A will give events a way to move one).
      const outline = shape && (shape.getAttribute('points') || shape.getAttribute('d'));
      if (m === 'on' && shape && was.outline && outline !== was.outline && shape.tagName === 'polygon' && /^[\d.\s,-]+$/.test(was.outline)) longest = Math.max(longest, morph(shape, was.outline, outline));
      c.tagsAdded.forEach((t) => {
        const badge = g.querySelector(`.region-badge[data-tag="${CSS.escape(t)}"]`);
        if (badge) { badge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500 }); badge.classList.add('map-pulse'); setTimeout(() => badge.classList.remove('map-pulse'), 1500); }
      });
      c.tagsGone.forEach((t) => {
        const badge = was.badges[t];
        if (!badge || g.querySelector(`.region-badge[data-tag="${CSS.escape(t)}"]`)) return;
        g.appendChild(badge);
        longest = Math.max(longest, fade(badge, 600, true));
      });
      if (c.presence || c.status || c.contested[0] !== c.contested[1] || c.tagsAdded.length) {
        g.classList.add('changed');
        setTimeout(() => g.classList.remove('changed'), 1300);
      }
    });
    return longest;
  }
  // Fades an element out (and away). → ms
  function fade(el, ms, remove) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
    if (remove) setTimeout(() => el.remove(), ms + 30);
    return ms;
  }
  // The old holder's colour, laid over the region, wiped away from the side
  // facing the front: a half-plane that slides across, so the new colour
  // comes in from there. → ms
  let sweeps = 0;
  function sweep(svg, old, frontShape) {
    const a = boxMid(old), f = boxMid(frontShape);
    if (!a || !f) return fade(old, 700, true);
    let ux = a.x - f.x, uy = a.y - f.y;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len; uy /= len;
    const corners = [[a.b.x, a.b.y], [a.b.x + a.b.width, a.b.y], [a.b.x, a.b.y + a.b.height], [a.b.x + a.b.width, a.b.y + a.b.height]];
    const proj = corners.map(([x, y]) => x * ux + y * uy);
    const lo = Math.min(...proj), hi = Math.max(...proj);
    const big = (a.b.width + a.b.height) * 2;
    const id = `sweep-${++sweeps}`;
    const NS = 'http://www.w3.org/2000/svg';
    const clip = document.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', id);
    const poly = document.createElementNS(NS, 'polygon');
    clip.appendChild(poly);
    svg.appendChild(clip);
    old.setAttribute('clip-path', `url(#${id})`);
    const place = (s) => {
      // The line across the region at s (0: the front edge, 1: the far edge);
      // what is beyond it keeps the old colour.
      const t = lo + (hi - lo) * s, pc = a.x * ux + a.y * uy;
      const lx = a.x + (t - pc) * ux, ly = a.y + (t - pc) * uy;
      const vx = -uy * big, vy = ux * big, wx = ux * big, wy = uy * big;
      poly.setAttribute('points', [[lx + vx, ly + vy], [lx - vx, ly - vy], [lx - vx + wx, ly - vy + wy], [lx + vx + wx, ly + vy + wy]].map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '));
    };
    place(0);
    old.dataset.sweep = '1';
    const t0 = performance.now();
    const step = (now) => {
      const s = Math.min(1, (now - t0) / SWEEP);
      place(s * s * (3 - 2 * s));
      if (s < 1 && old.isConnected) requestAnimationFrame(step);
      else { old.remove(); clip.remove(); }
    };
    requestAnimationFrame(step);
    return SWEEP;
  }
  // An outline moving from where it was drawn to where it is now (E.Geo.morph). → ms
  function morph(shape, from, to) {
    const ring = (s) => s.trim().split(/\s+/).map((p) => p.split(',').map(Number));
    const f = E.Geo.morph(ring(from), ring(to));
    const t0 = performance.now(), ms = 1200;
    const step = (now) => {
      const s = Math.min(1, (now - t0) / ms);
      shape.setAttribute('points', s < 1 ? f(s * s * (3 - 2 * s)).map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ') : to);
      if (s < 1 && shape.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return ms;
  }

  // On a region map, the pin glides from the region it stood in to the one
  // the beat puts the player in (a trip read beat by beat).
  function glidePin(b, now, m) {
    if (!b.pin || !E.Motion.forward(b.prev, now)) return 0;
    const pin = document.querySelector('#mapPane .you-here');
    const at = pinAt();
    if (!pin || !at || (Math.abs(at.x - b.pin.x) < 1 && Math.abs(at.y - b.pin.y) < 1)) return 0;
    const ms = m === 'on' ? 900 : 360;
    const from = `translate(${(b.pin.x - at.x).toFixed(1)}px, ${(b.pin.y - at.y).toFixed(1)}px)`;
    pin.animate(m === 'on' ? [{ transform: from }, { transform: 'translate(0px, 0px)' }] : [{ transform: from, opacity: 1 }, { transform: from, opacity: 0, offset: 0.45 }, { transform: 'none', opacity: 0, offset: 0.55 }, { transform: 'none', opacity: 1 }], { duration: ms, easing: 'ease-in-out' });
    return ms;
  }

  // A ring of light, once, on what changed (the CSS animation stops itself
  // under Reduce motion).
  function pulse(p) {
    const pane = $('mapPane');
    const q = (sel) => { try { return pane.querySelector(sel); } catch (e) { return null; } };
    const els = [].concat(
      p.links.map((k) => q(`[data-link="${CSS.escape(k)}"]`)),
      p.features.map((k) => { const [room, ...name] = k.split('|'); return q(`.map-feature[data-room="${CSS.escape(room)}"][data-feature="${CSS.escape(name.join('|'))}"]`); }),
      p.groups.map((id) => q(`.map-token[data-id="${CSS.escape(id)}"]`)),
    ).filter(Boolean);
    els.forEach((el) => {
      el.classList.add('map-pulse');
      setTimeout(() => el.classList.remove('map-pulse'), 1500);
    });
  }

  // Phones: a beat with a visible move or shift shows the map over the story
  // while it plays, then puts it away; a tap puts it away sooner.
  let popTimer = null;
  const popClose = () => { clearTimeout(popTimer); $('story').classList.remove('map-pop'); if (detour) detour.restore(); };
  function popUp(ms) {
    let phone = false;
    try { phone = window.matchMedia('(max-width: 860px)').matches; } catch (e) { /* desktop */ }
    if (!phone || $('story').classList.contains('view-map')) return;
    $('story').classList.add('map-pop');
    clearTimeout(popTimer);
    popTimer = setTimeout(popClose, ms + 500);
  }
  $('mapPane').addEventListener('click', (ev) => {
    if (!$('story').classList.contains('map-pop')) return;
    ev.stopPropagation();
    ev.preventDefault();
    popClose();
  }, true);

  Object.assign(U, { beforeMap, afterMap });
})();
