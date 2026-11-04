// Moving pieces on the map (task A-10), the game page only. E.Motion decides
// what moves and pulses; this plays it. The map is still redrawn whole, but
// each token keeps its element across drawings (matched by id) and walks from
// where it stood, by transform, with the Web Animations API. Settings ›
// Appearance › Map motion: on, reduced (quick fades, no pop-up) or off.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $ } = U;

  const PACE = 140; // map units a second (CELL is 30: a room or two a second)
  const PAUSE = 160; // ms at each door
  const LONGEST = 2000;
  let last = null; // E.Motion.snapshot of the last drawing, with its geometry

  const deviceReduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
  const mode = () => E.Motion.mode(E.settings.appearance, deviceReduced());
  const tokensIn = (root) => new Map([...root.querySelectorAll('.map-token[data-id]')].map((el) => [el.dataset.id, el]));
  const centre = (el) => {
    const c = el.querySelector('circle');
    return c ? { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) } : null;
  };
  // The "You are here" pin on a region map: the middle of its box.
  const pinAt = () => {
    const pin = document.querySelector('#mapPane .you-here');
    try { const b = pin && pin.getBBox(); return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; } catch (e) { return null; }
  };

  function beforeMap() {
    const old = tokensIn($('mapPane'));
    return { old, at: new Map([...old].map(([id, el]) => [id, centre(el)])), prev: last, pin: pinAt() };
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
      const ms = play(el, pts, end || start, m);
      if (!end) setTimeout(() => el.remove(), ms + 50);
      longest = Math.max(longest, ms);
    });
    longest = Math.max(longest, glidePin(b, now, m));
    pulse(E.Motion.pulses(b.prev, now));
    if (longest && m === 'on') popUp(longest);
  }

  // Keyframes along the points, by transform from where the element is drawn
  // (anchor), timed by distance with a pause at each door. → ms
  function play(el, pts, anchor, m) {
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

  // Phones: a beat with a visible move shows the map over the story while it
  // plays, then puts it away; a tap puts it away sooner.
  let popTimer = null;
  const popClose = () => { clearTimeout(popTimer); $('story').classList.remove('map-pop'); };
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
