// The local map and the zooming map.
(function () {
  const E = window.Ensemble;
  const U = E.UI;
  const { $, esc, store } = U;

  // ---------- local map (task 3-3) ----------
  // E.Layouts.plan places the rooms; E.SiteDraw draws them as floor plans
  // (task 3-7) from what the player knows, built here: rooms in view, rooms
  // remembered, doors as last seen. "Map detail: simple" draws plain boxes
  // with theme colours: walls, a mark for each kind of link, labels,
  // features. Tokens go where the player last saw everyone (faded when out of
  // sight). Clicking fills in the action box and never acts. A start's
  // "localMap" draws its floor-plan image with room hotspots instead.
  const CELL = E.SiteDraw.CELL;
  let planCache = { key: null, plan: null };
  function mapPlan() {
    const sc = U.state.scenario;
    // Rooms placed from the authored ones (the map never moves); links drawn
    // from the live rooms, so an inferred window shows (task 3-6).
    // Only the place the player is in (task 4-4): the start's rooms, or a
    // generated site's. Routes to other places are listed under the map.
    const site = E.Sites.playerSite(U.state);
    const key = `${sc.worldId}|${sc.startId}|${site}|${Object.values(U.state.locations).map((l) => l.id + ':' + (l.connects || []).join('+')).join(',')}`;
    const home = site === E.Sites.HOME;
    // An authored place (task 7-2) is drawn on its own, with its own layout style.
    const authored = home ? (sc.locations && sc.locations.length ? sc.locations : Object.values(U.state.locations)).filter((l) => !l.site) : E.Sites.rooms(U.state, site);
    if (planCache.key !== key) planCache = { key, plan: E.Layouts.plan(authored, { type: home ? (sc.site ? sc.site.type : null) : ((U.state.sites || {})[site] || {}).layout, seed: `${sc.worldId}:${home ? sc.startId : site}`, linkLocs: U.state.locations }) };
    return planCache.plan;
  }
  // Tokens by room, as the player knows them.
  function mapTokens() {
    const byRoom = {};
    const add = (loc, t) => { if (loc && U.state.seenRooms.includes(loc)) (byRoom[loc] = byRoom[loc] || []).push(t); };
    const pc = U.state.characters[U.state.player];
    add(pc.status.location, { kind: 'character', id: U.state.player, label: pc.name, player: true, now: true });
    // While the scene is read beat by beat, someone who moves in a beat not
    // shown yet is still where they were (up to the step-in point, if one is
    // chosen), so the map follows the scene instead of jumping to its end.
    const live = U.liveScene();
    const read = live ? U.uiCut || U.uiShown : Infinity;
    const later = {};
    if (live) E.Engine.sceneMoves(U.state).forEach((m) => { if (m.beat >= read) later[m.id] = m.from; });
    const where = (id) => (later[id] ? { loc: later[id], now: true, turn: U.state.turn } : E.Engine.knownWhere(U.state, id));
    E.Engine.cast(U.state, { alive: true, includePlayer: false }).forEach((id) => {
      const kw = where(id);
      if (kw) add(kw.loc, { kind: 'character', id, label: U.state.characters[id].name, now: kw.now, turn: kw.turn });
    });
    Object.values(U.state.extras || {}).forEach((x) => {
      const kw = where(x.id);
      if (kw) add(kw.loc, { kind: 'extra', id: x.id, label: x.name, now: kw.now, turn: kw.turn });
    });
    Object.values(U.state.standees || {}).forEach((g) => {
      const kw = where(g.id);
      if (kw) add(kw.loc, { kind: 'standee', id: g.id, label: g.label, count: g.count, state: g.state, now: kw.now, turn: kw.turn });
    });
    return byRoom;
  }
  function tokenSvg(t, cx, cy, r) {
    const tip = t.player ? `${t.label} (you)` : `${t.label}${t.kind === 'standee' ? `: ${t.count}, ${t.state}` : ''}${t.now ? '' : ` (last seen turn ${t.turn})`}`;
    const attrs = `class="map-token${t.now ? '' : ' stale'}" tabindex="0" role="button" data-kind="${t.kind}" data-id="${esc(t.id)}" aria-label="${esc(tip)}"`;
    let body;
    if (t.kind === 'standee') {
      body = `<circle class="tok badge badge-${esc(t.state)}" cx="${cx}" cy="${cy}" r="${r}"/><text class="count" x="${cx}" y="${cy + 3.5}" text-anchor="middle">${t.count}</text>`;
    } else {
      const m = E.Engine.monogram(U.state, t.id);
      const p = t.kind === 'character' ? E.Engine.portrait(U.state, t.id) : {};
      const url = p.path && U.portraitUrl(p.path);
      const clip = `clip-${t.id.replace(/[^a-z0-9_-]/gi, '')}`;
      body = url && !U.failedUrls.has(url)
        ? `<clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><circle class="tok" cx="${cx}" cy="${cy}" r="${r}" style="fill:hsl(${m.hue} 38% 32%)"/><image href="${esc(url)}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`
        : `<circle class="tok" cx="${cx}" cy="${cy}" r="${t.kind === 'extra' ? r - 2 : r}" style="fill:hsl(${m.hue} 38% 32%)"/><text x="${cx}" y="${cy + 3}" text-anchor="middle">${esc(m.monogram)}</text>`;
      if (t.player) body += `<circle class="ring" cx="${cx}" cy="${cy}" r="${r + 2.5}"/>`;
    }
    return `<g ${attrs}><title>${esc(tip)}</title>${body}</g>`;
  }
  // Tokens spread around a room's box, each keeping its spot (the same
  // placement as the detailed map); the rest as "+N".
  function roomTokens(list, x, y, w, h, id) {
    return E.SiteDraw.tokensIn(list, { x, y, w, h }, [], id || '', tokenSvg);
  }
  function linkMark(k) {
    const len = 0.9 * CELL, x = k.x * CELL, y = k.y * CELL;
    const v = k.orient === 'v';
    const gap = v ? `<rect class="map-gap" x="${x - 2}" y="${y - len / 2}" width="4" height="${len}"/>` : `<rect class="map-gap" x="${x - len / 2}" y="${y - 2}" width="${len}" height="4"/>`;
    const leaf = v ? `<line class="map-door" x1="${x}" y1="${y - len / 2}" x2="${x + len * 0.6}" y2="${y - len / 2 + 4}"/>` : `<line class="map-door" x1="${x - len / 2}" y1="${y}" x2="${x - len / 2 + 4}" y2="${y + len * 0.6}"/>`;
    switch (k.kind) {
      case 'door': return gap + leaf;
      case 'locked door': return gap + leaf + `<rect class="map-lock" x="${x - 3}" y="${y - 3}" width="6" height="6"/>`;
      case 'vent': case 'hatch': return v ? `<rect class="map-vent" x="${x - 3}" y="${y - 6}" width="6" height="12"/>` : `<rect class="map-vent" x="${x - 6}" y="${y - 3}" width="12" height="6"/>`;
      case 'window': return gap + (v ? `<line class="map-window" x1="${x - 2}" y1="${y - len / 2}" x2="${x - 2}" y2="${y + len / 2}"/><line class="map-window" x1="${x + 2}" y1="${y - len / 2}" x2="${x + 2}" y2="${y + len / 2}"/>`
        : `<line class="map-window" x1="${x - len / 2}" y1="${y - 2}" x2="${x + len / 2}" y2="${y - 2}"/><line class="map-window" x1="${x - len / 2}" y1="${y + 2}" x2="${x + len / 2}" y2="${y + 2}"/>`);
      case 'stairs': return gap + [-4, 0, 4].map((d) => (v ? `<line class="map-door" x1="${x - 4}" y1="${y + d}" x2="${x + 4}" y2="${y + d}"/>` : `<line class="map-door" x1="${x + d}" y1="${y - 4}" x2="${x + d}" y2="${y + 4}"/>`)).join('');
      default: return gap;
    }
  }
  // The detailed map's inputs (task 3-7), so what the player knows is decided
  // here: rooms in view (full detail, feature state), remembered rooms (no
  // state), the rest unknown. A door out of sight is drawn as a plain door,
  // since it may have changed since.
  function detailedMapSvg(here, tokens) {
    const plan = mapPlan();
    const inView = E.Engine.visibleRooms(U.state).filter((id) => plan.rooms[id]);
    const remembered = Object.keys(plan.rooms).filter((id) => !inView.includes(id) && U.state.seenRooms.includes(id));
    const rooms = {};
    Object.keys(plan.rooms).forEach((id) => {
      const l = U.state.locations[id];
      const feats = E.Engine.features(U.state, id);
      rooms[id] = { name: l.name, outside: !!l.outside, features: inView.includes(id) ? feats : feats.map((f) => ({ name: f.name, state: null, inferred: f.inferred })) };
    });
    const links = {};
    plan.links.forEach((k) => {
      const live = inView.includes(k.a) || inView.includes(k.b);
      links[[k.a, k.b].sort().join('|')] = live ? E.Engine.linkShown(U.state, k.a, k.b) || k.kind : k.kind === 'locked door' ? 'door' : k.kind;
    });
    const sc = U.state.scenario;
    const site = E.Sites.playerSite(U.state);
    return E.SiteDraw.render(plan, rooms, { inView, remembered, here, seed: `${sc.worldId}:${site === E.Sites.HOME ? sc.startId : site}`, links, tokens, tokenSvg, fit: true });
  }
  // A place built from a site map drawn on an image (task 6-3): what the
  // player knows is decided here, as for the detailed map; doors out of
  // sight as last seen (a locked one just a door).
  function imageMapSvg(site, m, here, tokens) {
    const ids = E.Sites.rooms(U.state, site).map((l) => l.id);
    const inView = E.Engine.visibleRooms(U.state).filter((id) => ids.includes(id));
    const remembered = ids.filter((id) => !inView.includes(id) && U.state.seenRooms.includes(id));
    const rooms = {};
    ids.forEach((id) => { const l = U.state.locations[id]; if (l.shape) rooms[id] = { name: l.name, shape: l.shape, outside: !!l.outside }; });
    const links = [];
    const seen = new Set();
    ids.forEach((a) => {
      const l = U.state.locations[a];
      const ways = (l.links || []).filter((k) => k.kind !== 'trip').map((k) => ({ to: k.to, kind: k.kind, at: k.at })).concat((l.connects || []).map((to) => ({ to, kind: 'open' })));
      ways.forEach((k) => {
        const key = [a, k.to].sort().join('|');
        if (!ids.includes(k.to) || seen.has(key)) return;
        seen.add(key);
        const live = inView.includes(a) || inView.includes(k.to);
        links.push({ a, b: k.to, at: k.at, kind: live ? E.Engine.linkShown(U.state, a, k.to) || k.kind : k.kind === 'locked door' ? 'door' : k.kind });
      });
    });
    return E.SiteDraw.renderImage({ url: U.siteMapUrl(m), width: m.width, height: m.height }, rooms, { inView, remembered, here, links, tokens, tokenSvg, seed: site });
  }
  // Decoration drops out when the map is drawn small (task 3-7).
  function sizeDetailedMap() {
    const svg = document.querySelector('#mapPane svg.sd');
    if (!svg) return;
    const vb = svg.viewBox.baseVal;
    const w = svg.getBoundingClientRect().width;
    svg.classList.toggle('sd-small', !!(vb && vb.width && w && w / vb.width < 0.85));
  }
  try { new ResizeObserver(sizeDetailedMap).observe($('mapPane')); } catch (e) {}
  const KIND_WORD = { open: 'way', door: 'door', 'locked door': 'locked door', vent: 'vent', hatch: 'hatch', window: 'window', stairs: 'stairs' };
  // Region routes as travel buttons (R-3): an icon and the words the engine
  // reads as setting out ("I drive to Ridge.").
  const TRAVEL = {
    border: ['🚶', 'I go to'], checkpoint: ['🛂', 'I go to'], road: ['🚗', 'I drive to'], rail: ['🚆', 'I take the train to'],
    sea: ['⛵', 'I sail to'], air: ['✈️', 'I fly to'], hyperlane: ['🚀', 'I travel to'], portal: ['🌀', 'I travel to'],
  };
  // The routes out of the player's region that can lead somewhere: the world
  // builds places, or the story already has a room or place there.
  function travelRoutes() {
    const from = E.Engine.playerRegion(U.state);
    if (!from) return [];
    const sc = U.state.scenario;
    const somewhere = (id) => E.Sites.enabled(sc) || Object.values(U.state.locations).some((l) => l.region && E.Engine.regionChain(U.state, l.region).includes(id))
      || Object.values(U.state.sites || {}).some((s) => s.region && E.Engine.regionChain(U.state, s.region).includes(id));
    return E.Engine.routesFrom(U.state, from).filter((r) => somewhere(r.to)).map((r) => {
      const [icon, verb] = TRAVEL[r.kind] || ['🧭', 'I travel to'];
      const name = regionName(r.to);
      const time = E.Scenario.sayHours(r.hours);
      return { to: r.to, name, icon, time, closed: r.closed, risky: r.risky, say: `${verb} ${name}.`,
        title: `${r.kind}${time ? `, ${time}` : ''}${r.closed ? `; closed: ${r.closed}${r.risky ? ' (you could risk it)' : ''}` : r.risky ? '; risky' : ''}` };
    });
  }
  // Waiting on the road (R-2): where the journey stopped, and the way on or back.
  function travelCardHtml(here) {
    const l = U.state.locations[here];
    const [on, back] = l.connects || [];
    const btn = (to, say, icon) => (U.state.locations[to] ? `<button type="button" class="small map-route" data-say="${esc(say)}">${icon} ${esc(say.replace(/^I go /, '').replace(/\.$/, ''))}</button>` : '');
    return `<div class="travel-card"><p><b>${esc(l.name)}</b>${l.region ? `, in ${esc(regionName(l.region))}` : ''}.</p><p>${esc(l.desc || '')}</p><div class="map-routes">` +
      btn(on, `I go on to ${U.state.locations[on] ? U.state.locations[on].name : ''}.`, '↗') + ' ' + btn(back, `I go back to ${U.state.locations[back] ? U.state.locations[back].name : ''}.`, '↩') +
      `</div></div><ul class="sr-only" id="mapList"><li>${esc(l.name)} (you are here)</li></ul>`;
  }
  // Ways to other places: trips to places made during the story (task
  // 4-4), then the routes out of this region (R-3) with kind and time.
  // Clicking one fills in the action box; the engine decides the rest.
  function waysHtml(site) {
    const routes = E.Sites.trips(U.state, site);
    const regionRoutes = travelRoutes();
    if (!routes.length && !regionRoutes.length) return '';
    return `<div class="map-routes">Ways to other places: ${routes.map((r) => `<button type="button" class="small map-route" data-name="${esc(r.name)}" title="From ${esc(U.state.locations[r.from].name)}">↗ ${esc(r.name)}</button>`).join(' ')}` +
      regionRoutes.map((r) => `<button type="button" class="small map-route" data-say="${esc(r.say)}"${r.closed && !r.risky ? ' disabled' : ''} title="${esc(r.title)}">${r.icon} ${esc(r.name)}${r.time ? ` · ${esc(r.time)}` : ''}${r.closed ? (r.risky ? ' ⚠' : ' (closed)') : ''}</button>`).join(' ') + '</div>';
  }
  // The places the player knows on a region level (R-8): pins with the
  // time to get there; clicking one fills in the action box.
  function placePinsHtml(levelId) {
    const pins = E.Sites.regularPlaces(U.state, levelId);
    if (!pins.length) return '';
    return `<div class="map-routes map-places">Places: ${pins.map((p) => {
      const time = p.here ? 'you are here' : p.hours ? E.Scenario.sayHours(p.hours) : p.hours === 0 ? 'nearby' : '';
      return `<button type="button" class="small map-route" data-say="${esc(`I go to ${p.name}.`)}"${p.here ? ' disabled' : ''} title="${esc(`${p.name}, in ${regionName(p.region)}${p.visited ? '' : ' (not visited yet)'}`)}">📌 ${esc(p.name)}${time ? ` · ${esc(time)}` : ''}</button>`;
    }).join(' ')}</div>`;
  }
  // A flavour place (R-8): a scene card, the room you're in, the others by
  // name, who is here, and the floor plan a toggle away.
  const floorPlans = new Set(); // sites whose floor plan was asked for
  function sceneCardHtml(site, here, tokens) {
    const l = U.state.locations[here];
    const s = (U.state.sites || {})[site];
    const others = E.Sites.rooms(U.state, site).filter((r) => r.id !== here && U.state.seenRooms.includes(r.id));
    const who = (tokens[here] || []).filter((t) => !t.player && t.now).map((t) => (t.kind === 'standee' ? `${t.count} ${t.label}` : t.label));
    const feats = E.Engine.features(U.state, here).map((f) => f.name + (f.state ? ` (${f.state})` : ''));
    return `<div class="travel-card scene-card"><p><b>${esc(s && s.name !== l.name ? `${s.name}: ${l.name}` : l.name)}</b>${l.region ? `, in ${esc(regionName(l.region))}` : ''}.</p><p>${esc(l.desc || '')}</p>` +
      (feats.length ? `<p class="muted">${esc(feats.join(' · '))}</p>` : '') +
      `<p class="muted">${who.length ? `Here: ${esc(who.join(', '))}.` : 'No one else you know of here.'}</p>` +
      (others.length ? `<div class="map-routes">${others.map((r) => `<button type="button" class="small map-route" data-say="${esc(`I go to the ${r.name}.`)}">↗ ${esc(r.name)}</button>`).join(' ')}</div>` : '') +
      `<button type="button" class="small" data-floorplan="${esc(site)}">Show the floor plan</button></div>` + waysHtml(site) +
      `<ul class="sr-only" id="mapList"><li>${esc(l.name)} (you are here): ${esc(who.join(', ') || 'no one you know of')}</li></ul>`;
  }
  function localMapHtml() {
    const here = U.state.characters[U.state.player].status.location;
    const tokens = mapTokens();
    const seen = (id) => U.state.seenRooms.includes(id);
    const roomName = (id) => (seen(id) ? U.state.locations[id].name : 'unknown room');
    const site = E.Sites.playerSite(U.state);
    const lm = site === E.Sites.HOME ? U.state.scenario.localMap : null;
    const im = site !== E.Sites.HOME ? E.Sites.imageMap(U.state, site) : null;
    let svg;
    // Stopped on a journey (R-2): no floor plan, just the way on and back.
    if (U.state.locations[here].transit) return travelCardHtml(here);
    // A flavour place (R-8) is a scene card until the player asks for the plan.
    if (!im && !lm && !E.Sites.tactical(U.state, site) && !floorPlans.has(site)) return sceneCardHtml(site, here, tokens);
    if (im) svg = imageMapSvg(site, im, here, tokens);
    else if (lm) {
      const url = U.portraitUrl(lm.image);
      const rooms = Object.entries(lm.rooms).map(([id, r]) => `<g class="map-room${id === here ? ' here' : ''}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}"><rect class="floor" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" style="fill-opacity:0.15"/>${roomTokens(tokens[id] || [], r.x, r.y, r.w, r.h, id)}</g>`).join('');
      svg = `<svg class="map-svg" viewBox="0 0 ${lm.width} ${lm.height}" role="img" aria-label="Map">${url ? `<image href="${esc(url)}" x="0" y="0" width="${lm.width}" height="${lm.height}"/>` : ''}${rooms}</svg>`;
    } else if ((U.mapDetailPreview || E.settings.appearance.mapDetail) !== 'simple') {
      svg = detailedMapSvg(here, tokens);
    } else {
      const plan = mapPlan();
      const W = plan.width * CELL, H = plan.height * CELL;
      const levels = plan.levels.length > 1 ? plan.levels.map((b) => `<text class="map-level" x="${b.x * CELL}" y="${b.y * CELL - 9}">${b.level === 0 ? 'ground floor' : b.level > 0 ? `level ${b.level}` : `below ${-b.level}`}</text>`).join('') : '';
      const rooms = Object.entries(plan.rooms).map(([id, r]) => {
        const l = U.state.locations[id];
        const x = r.x * CELL, y = r.y * CELL, w = r.w * CELL, h = r.h * CELL;
        const cls = `map-room${l.outside ? ' outside' : ''}${id === here ? ' here' : ''}${seen(id) ? '' : ' unseen'}`;
        const label = seen(id) ? `<text class="map-label" x="${x + 5}" y="${y + 13}">${esc(E.shorten(l.name, Math.floor((w - 8) / 6.5)))}</text>` : `<text class="map-feat" x="${x + w / 2}" y="${y + h / 2 + 3}" text-anchor="middle">?</text>`;
        const fl = E.Engine.features(U.state, id).map((f) => f.name + (f.state ? ` (${f.state})` : ''));
        const feats = seen(id) && fl.length ? `<text class="map-feat" x="${x + 5}" y="${y + h - 5}">${esc(E.shorten(fl.join(' · '), Math.floor(w / 5)))}</text>` : '';
        // Ways to another level: a note in the room.
        const up = plan.links.filter((k) => k.remote && (k.a === id || k.b === id) && plan.rooms[k.a].level !== plan.rooms[k.b].level)
          .map((k) => { const o = k.a === id ? k.b : k.a; return `${KIND_WORD[k.kind]} to ${roomName(o)}`; });
        const upText = up.length ? `<text class="map-feat" x="${x + 5}" y="${y + h - (feats ? 16 : 5)}">↕ ${esc(E.shorten(up.join(', '), Math.floor((w - 8) / 5)))}</text>` : '';
        const toks = roomTokens(tokens[id] || [], x, y + 18, w, h - (up.length ? 42 : 30), id);
        return `<g class="${cls}" tabindex="0" role="button" data-room="${esc(id)}" aria-label="${esc(roomName(id))}">${(r.extra || []).map((e) => `<rect class="floor" x="${e.x * CELL}" y="${e.y * CELL}" width="${e.w * CELL}" height="${e.h * CELL}" rx="2"/>`).join('')}<rect class="floor" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>${label}${upText}${feats}</g><g class="map-tokens">${toks}</g>`;
      }).join('');
      const remote = plan.links.filter((k) => k.remote && plan.rooms[k.a].level === plan.rooms[k.b].level).map((k) => {
        const a = plan.rooms[k.a], b = plan.rooms[k.b];
        return `<line class="map-remote" x1="${(a.x + a.w / 2) * CELL}" y1="${(a.y + a.h / 2) * CELL}" x2="${(b.x + b.w / 2) * CELL}" y2="${(b.y + b.h / 2) * CELL}"/>`;
      }).join('');
      // Doors as they are now: unlocked, open or shut (task 3-6).
      const marks = plan.links.filter((k) => !k.remote).map((k) => linkMark(Object.assign({}, k, { kind: E.Engine.linkShown(U.state, k.a, k.b) || k.kind }))).join('');
      // Never smaller than about three quarters of full size (the pane scrolls).
      svg = `<svg class="map-svg" viewBox="-4 -4 ${W + 8} ${H + 8}" style="min-width:${Math.round(W * 0.75)}px" role="img" aria-label="Map">${remote}${rooms}${marks}${levels}</svg>`;
    }
    // Zoom and pan on the floor plan (task 7-2: the school is 28 rooms): it
    // fits the pane, and its view is kept per place until reset.
    const key = `site:${site}`;
    const full = (/viewBox="([^"]*)"/.exec(svg) || [])[1] || '';
    svg = svg.replace('<svg ', `<svg id="siteSvg" data-view="${esc(key)}" data-full="${esc(full)}" `);
    if (viewBoxes[key]) svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${viewBoxes[key].map((n) => Math.round(n)).join(' ')}"`);
    if (floorPlans.has(site) && !im && !lm && !E.Sites.tactical(U.state, site)) svg += `<button type="button" class="small" data-scenecard="${esc(site)}">Show the scene card</button>`;
    svg += waysHtml(site);
    // The same in words, for screen readers.
    const list = Object.keys(U.state.locations).filter((id) => seen(id) && E.Sites.siteOf(U.state, id) === site).map((id) => {
      const who = (tokens[id] || []).map((t) => (t.player ? 'you' : t.kind === 'standee' ? `${t.count} ${t.label}` : t.label) + (t.now ? '' : ' (last seen)'));
      return `<li>${esc(U.state.locations[id].name)}${id === here ? ' (you are here)' : ''}: ${esc(who.join(', ') || 'no one you know of')}</li>`;
    }).join('');
    return svg + `<ul class="sr-only" id="mapList">${list}</ul>`;
  }

  // ---------- the zooming map (task 3-4; one map through the tree, R-3) ----------
  // A breadcrumb from the world down to the player's room: each level is a
  // region (MapDraw.level: its picture, zoomed, or a node map of its
  // children), and the bottom is the local map. Regions are coloured by who
  // holds them (theme colours --f1…--f8), with tag badges, your region and
  // your branch marked, and an info strip for the region you pick. Public
  // state only: controller, tags, status and the lore summary. Clicking a
  // region with regions inside it zooms in; any other picks it. Drag to pan;
  // wheel, pinch or the buttons to zoom.
  const MAPVIEW_KEY = 'ensemble.mapview';
  let mapSel = null; // the region picked for the info strip
  let curLevel = null; // the level drawn last (MapDraw.level)
  const viewBoxes = {}; // per level: the panned/zoomed viewBox, until reset or a new game
  const pulsed = new Set(); // "id@turn": a change pulses once
  function mapViewAll() { try { return JSON.parse(store.get(MAPVIEW_KEY)) || {}; } catch (e) { return {}; } }
  const hasRegions = () => !!(U.state && (U.state.scenario.regions || []).length);
  // The level shown: "local", "root" (the world) or a region id. Saved
  // before R-3: "world" is the root, "region" the player's region.
  function mapView() {
    if (!hasRegions()) return 'local';
    const v = mapViewAll()[U.state.scenario.worldId];
    if (v === 'world') return 'root';
    if (v === 'region') return E.Engine.playerRegion(U.state) || 'root';
    if (v === 'root' || v === 'local' || (v && E.Engine.regionDef(U.state, v) && E.Engine.regionKnown(U.state, v))) return v;
    // Nothing picked yet: a region-focused world (R-8) opens at the player's
    // region, unless they are in a tactical place (task 7-4: a town's drawn
    // plan), which opens on its floor plan.
    const region = E.Sites.mapFocus(U.state.scenario) === 'region' && E.Engine.playerRegion(U.state);
    return region && !E.Sites.tactical(U.state, E.Sites.playerSite(U.state)) ? region : 'local';
  }
  function setMapView(v) {
    const all = mapViewAll();
    all[U.state.scenario.worldId] = v;
    store.set(MAPVIEW_KEY, JSON.stringify(all));
    mapSel = null;
    renderMap();
  }
  const factionClass = (fid) => E.MapDraw.factionClass(U.state.factions, fid);
  const regionName = (id) => (id && E.Engine.regionDef(U.state, id) ? E.Engine.regionDef(U.state, id).name : id);
  // Connections on a node map that are closed now: every route behind one
  // (between the regions shown, or regions inside them) needs something
  // that doesn't hold. As "a|b" keys.
  function closedEdges(lv) {
    const tally = new Map();
    (U.state.scenario.regions || []).forEach((r) => E.Engine.routesFrom(U.state, r.id).forEach((x) => {
      const a = lv.liftTo(r.id), b = lv.liftTo(x.to);
      if (!a || !b || a === b) return;
      const key = [a, b].sort().join('|');
      const t = tally.get(key) || { open: 0, closed: 0 };
      t[x.closed ? 'closed' : 'open']++;
      tally.set(key, t);
    }));
    return new Set([...tally].filter(([, t]) => t.closed && !t.open).map(([k]) => k));
  }
  function levelHtml(levelId) {
    const sc = U.state.scenario;
    // Regions the player doesn't know of are left out (R-5); contested ones marked.
    const hidden = E.Engine.hiddenRegions(U.state);
    const lv = curLevel = E.MapDraw.level(sc, levelId, { hidden });
    const contested = lv.regions.map((r) => r.id).filter((id) => E.Engine.presenceIn(U.state, id).contested);
    const mine = E.Engine.playerRegion(U.state);
    const branch = mine ? E.Engine.regionChain(U.state, mine) : [];
    // A region changed this turn pulses once.
    const pulse = (sc.regions || []).filter((r) => {
      const ch = (U.state.regionChanged || {})[r.id];
      const key = `${r.id}@${U.state.turn}`;
      if (!ch || ch.turn !== U.state.turn || pulsed.has(key)) return false;
      pulsed.add(key);
      return true;
    }).map((r) => r.id);
    // Rooms placed on the picture, at a leaf (as the regional view had them).
    const rooms = lv.leaf ? lv.rooms.filter((p) => U.state.locations[p.id] && U.state.seenRooms.includes(p.id)).map((p) => ({ x: p.x, y: p.y, name: U.state.locations[p.id].name })) : [];
    const key = levelId == null ? 'root' : levelId;
    // The pin stands on the player's room when the picture places it.
    const where = U.state.characters[U.state.player].status.location;
    const placed = lv.rooms.find((p) => p.id === where);
    return E.MapDraw.worldSvg({
      g: lv.g, regions: lv.regions, now: U.state.regions, factions: U.state.factions, mine, branch, selected: mapSel, pulse, rooms, contested,
      here: placed ? { x: placed.x, y: placed.y } : null,
      places: lv.picture ? E.MapDraw.placesOf(lv.picture) : [], dim: lv.dim, closed: lv.picture ? null : closedEdges(lv),

      zoomable: lv.children.filter((id) => E.MapDraw.hasLevel(sc, id, hidden)),
      imageUrl: lv.picture && U.portraitUrl(lv.picture.image), viewBox: viewBoxes[key] || lv.viewBox, id: 'worldSvg', view: key,
      label: levelId == null ? 'World map' : `Map of ${regionName(levelId)}`,
    }) + regionInfoHtml(lv) + (E.Sites.mapFocus(sc) === 'region' ? regionMoveHtml(levelId) : '');
  }
  // A region-focused world (R-8) moves at the region level: the places you
  // know as pins, and, on your own branch, the ways out.
  function regionMoveHtml(levelId) {
    const mine = E.Engine.playerRegion(U.state);
    const onBranch = mine && (levelId == null || E.Engine.regionChain(U.state, mine).includes(levelId));
    return placePinsHtml(levelId) + (onBranch ? waysHtml(E.Sites.playerSite(U.state)) : '');
  }
  function regionInfoHtml(lv) {
    const id = mapSel || (lv.id != null ? lv.id : E.Engine.playerRegion(U.state));
    const r = id && E.Engine.regionDef(U.state, id);
    if (!r) return '<div class="region-info muted">Pick a region to see who holds it.</div>';
    const now = U.state.regions[id];
    const ch = (U.state.regionChanged || {})[id];
    const fc = factionClass(now.controller);
    // Where it sits in the tree (R-1): the regions it is inside, each a level to go to.
    const up = E.Engine.regionChain(U.state, id).slice(1);
    const label = E.Scenario.regionLabel(U.state.scenario, id);
    const inWords = up.length ? ` in ${up.map((x) => `<button type="button" class="linkish" data-maplevel="${esc(x)}">${esc(regionName(x))}</button>`).join(' › ')}` : '';
    const zoom = id !== lv.id ? ` <button type="button" class="small" data-maplevel="${esc(id)}">Zoom in ›</button>` : '';
    const bits = [`<b>${esc(r.name)}</b>${label ? `, ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${esc(label)}` : ''}${inWords}${id === E.Engine.playerRegion(U.state) ? ' (you are here)' : ''}${zoom}`,
      `<span class="swatch ${fc}"></span>held by ${esc(E.Engine.regionHolder(U.state, id).text)}`];
    if (now.status) bits.push(esc(now.status));
    if (now.tags.length) bits.push(`tags: ${esc(now.tags.join(', '))}`);
    // Who else is there (R-5).
    const present = E.Engine.presenceText(U.state, id);
    if (present) bits.push(`present: ${esc(present)}`);
    let html = `<div class="region-info" id="regionInfo">${bits.join(' · ')}`;
    if (ch && ch.turn === U.state.turn) html += `<div class="changed">This turn: ${esc(ch.what.join(', '))}.</div>`;
    if (r.lore) html += `<div class="muted">${esc(r.lore)}</div>`;
    if (lv.leaf && id === E.Engine.playerRegion(U.state)) {
      const placed = new Set(lv.rooms.map((p) => p.id));
      const rest = Object.values(U.state.locations).filter((l) => l.region === id && !l.site && !placed.has(l.id) && U.state.seenRooms.includes(l.id)).map((l) => l.name);
      if (rest.length) html += `<div class="muted">Rooms here: ${esc(rest.join(', '))}</div>`;
    }
    // Places made during the story (task 4-4), in this region.
    const places = Object.values(U.state.sites || {}).filter((s) => s.region === id);
    if (places.length) html += `<div class="muted">Places: ${places.map((s) => esc(s.name) + (s.stub ? (s.visits ? ' (been there)' : ' (not visited yet)') : '')).join(', ')}</div>`;
    return html + '</div>';
  }
  // The breadcrumb: the world, the regions down to the level shown, and (at
  // the bottom) the room the player is in. "Where I am" and "Whole world" jump.
  function mapBarHtml(view) {
    const sc = U.state.scenario;
    const here = U.state.characters[U.state.player].status.location;
    const levelId = view === 'local' ? E.Engine.playerRegion(U.state) : view === 'root' ? null : view;
    const path = E.MapDraw.levelPath(sc, levelId).map((id) => ({ key: id == null ? 'root' : id, name: id == null ? (sc.worldTitle || sc.title) : regionName(id) }));
    if (view === 'local') path.push({ key: 'local', name: U.state.locations[here] ? U.state.locations[here].name : 'Here' });
    const crumbs = path.map((c, i) => `${i ? '<span class="sep" aria-hidden="true">›</span>' : ''}<button type="button" data-maplevel="${esc(c.key)}"${i === path.length - 1 ? ' aria-current="true"' : ''}>${esc(c.name)}</button>`).join('');
    const zoom = `<span class="zoom"><button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Reset the view" title="Reset the view">⟲</button></span>`;
    return `<div class="map-bar"><nav class="map-crumbs" aria-label="Map levels">${crumbs}</nav>${zoom}<span class="jumps"><button type="button" data-maplevel="local" title="Where I am">📍 Where I am</button><button type="button" data-maplevel="root" title="The whole world">🌍 Whole world</button></span></div>`;
  }
  function renderMap() {
    const pane = $('mapPane');
    if (!U.state) { pane.innerHTML = ''; return; }
    const view = mapView();
    pane.innerHTML = (hasRegions() ? mapBarHtml(view) : '') + (view === 'local' ? localMapHtml() : levelHtml(view === 'root' ? null : view));
    sizeDetailedMap();
  }
  // Zoom the map's viewBox around a point (in map units), within limits: the
  // world map, or a place's floor plan (task 7-2).
  const mapSvg = () => $('worldSvg') || $('siteSvg');
  function zoomWorld(factor, cx, cy) {
    const svg = mapSvg();
    if (!svg) return;
    const view = svg.dataset.view;
    const site = svg.id === 'siteSvg';
    const [x, y, w, h] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const full = site ? svg.dataset.full.split(/\s+/).map(Number) : curLevel ? curLevel.g.full : [0, 0, 800, 560];
    const nw = Math.min(full[2] * (site ? 1 : 2), Math.max(full[2] / 8, w * factor)), nh = h * (nw / w);
    const px = cx == null ? x + w / 2 : cx, py = cy == null ? y + h / 2 : cy;
    viewBoxes[view] = [px - (px - x) * (nw / w), py - (py - y) * (nh / h), nw, nh];
    svg.setAttribute('viewBox', viewBoxes[view].map((n) => Math.round(n)).join(' '));
    if (site) return sizeDetailedMap();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(redrawZoomed, 150);
  }
  // Once a zoom settles, the map is drawn again for the new view: the detail
  // that fits it (MapDraw.detailShown) and labels sized for it. The picture
  // stays as it is, so it doesn't flicker.
  let zoomTimer = null;
  function redrawZoomed() {
    const svg = $('worldSvg');
    if (!svg || !U.state) return;
    if (drag) { zoomTimer = setTimeout(redrawZoomed, 150); return; }
    const view = svg.dataset.view;
    const t = document.createElement('template');
    t.innerHTML = levelHtml(view === 'root' ? null : view);
    const fresh = t.content.querySelector('#worldSvg');
    if (!fresh) return;
    const keep = (c) => c.tagName.toLowerCase() === 'image';
    [...svg.children].forEach((c) => { if (!keep(c)) c.remove(); });
    [...fresh.children].forEach((c) => { if (!keep(c)) svg.appendChild(c); });
  }
  const toMap = (svg, ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
  };
  const pointers = new Map();
  let drag = null;
  let draggedAt = 0; // a pan never counts as a click on a room
  $('mapPane').addEventListener('pointerdown', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg, #siteSvg');
    if (!svg) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    drag = { svg, moved: false, start: { x: ev.clientX, y: ev.clientY }, vb: svg.getAttribute('viewBox').split(/\s+/).map(Number), dist: null };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; drag.dist = Math.hypot(a.x - b.x, a.y - b.y); }
  });
  $('mapPane').addEventListener('pointermove', (ev) => {
    const svg = drag && drag.svg;
    if (!svg || !drag || !pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const rect = svg.getBoundingClientRect();
    if (pointers.size === 2 && drag.dist) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(d - drag.dist) > 4) { zoomWorld(drag.dist / d); drag.dist = d; drag.moved = true; }
      return;
    }
    const dx = ev.clientX - drag.start.x, dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; try { svg.setPointerCapture(ev.pointerId); } catch (e) {} }
    svg.classList.add('panning');
    const [x, y, w, h] = drag.vb;
    viewBoxes[svg.dataset.view] = [x - dx * (w / rect.width), y - dy * (h / rect.height), w, h];
    svg.setAttribute('viewBox', viewBoxes[svg.dataset.view].map((n) => Math.round(n)).join(' '));
  });
  const endDrag = (ev) => {
    pointers.delete(ev.pointerId);
    const svg = drag && drag.svg;
    if (svg) svg.classList.remove('panning');
    const wasDrag = drag && drag.moved;
    if (wasDrag) draggedAt = Date.now();
    if (!pointers.size) drag = null;
    if (ev.type === 'pointerup' && !wasDrag && ev.target.closest) {
      const g = ev.target.closest('.region-g');
      if (g) pickRegion(g.dataset.region, !!g.dataset.zoomable);
    }
  };
  // A region on the map: one with regions inside it zooms in (R-3); any
  // other is picked for the info strip.
  function pickRegion(id, zoomable) {
    if (zoomable) return setMapView(id);
    mapSel = id;
    renderMap();
  }

  $('mapPane').addEventListener('pointerup', endDrag);
  $('mapPane').addEventListener('pointercancel', endDrag);
  $('mapPane').addEventListener('wheel', (ev) => {
    const svg = ev.target.closest && ev.target.closest('#worldSvg, #siteSvg');
    if (!svg) return;
    ev.preventDefault();
    const p = toMap(svg, ev);
    zoomWorld(ev.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }, { passive: false });
  $('mapPane').addEventListener('click', (ev) => {
    const lvl = ev.target.closest('[data-maplevel]');
    if (lvl && U.state) return setMapView(lvl.dataset.maplevel);
    const z = ev.target.closest('[data-zoom]');
    if (z) {
      if (z.dataset.zoom === 'reset') { const s = mapSvg(); delete viewBoxes[s && s.id === 'siteSvg' ? s.dataset.view : mapView()]; return renderMap(); }
      zoomWorld(z.dataset.zoom === 'in' ? 1 / 1.4 : 1.4);
    }
  });
  // Clicking fills in the action box (never acts).
  function fillAction(text) {
    const box = $('actionInput');
    box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text;
    box.focus();
  }
  function mapActivate(el) {
    if (!U.state || !el) return;
    const tok = el.closest('.map-token');
    if (tok) {
      const id = tok.dataset.id;
      if (id === U.state.player) return;
      if (tok.dataset.kind === 'standee') return fillAction(`Watch the ${U.state.standees[id] ? U.state.standees[id].label : id}.`);
      const who = tok.dataset.kind === 'extra' ? U.state.extras[id] : U.state.characters[id];
      return fillAction(`Talk to ${who ? (tok.dataset.kind === 'extra' ? who.name : E.Engine.shortName(who)) : id}.`);
    }
    const plan = el.closest('[data-floorplan],[data-scenecard]');
    if (plan) {
      if (plan.dataset.floorplan != null) floorPlans.add(plan.dataset.floorplan); else floorPlans.delete(plan.dataset.scenecard);
      return renderMap();
    }
    const route = el.closest('.map-route');
    if (route) return route.disabled ? null : fillAction(route.dataset.say || `Go to ${route.dataset.name}.`);
    // A gameplay piece on the detailed map (task 3-7); decoration has no data.
    const feat = el.closest('.map-feature');
    if (feat) return fillAction(`Look at ${/^(the|a|an|my|your|his|her|their|\w+'s)\b/i.test(feat.dataset.feature) ? '' : 'the '}${feat.dataset.feature}.`);
    const room = el.closest('.map-room');
    if (!room) return;
    const id = room.dataset.room;
    if (id === U.state.characters[U.state.player].status.location) return;
    fillAction(U.state.seenRooms.includes(id) ? `Go to the ${U.state.locations[id].name}.` : 'Find out what is through there.');
  }
  $('mapPane').addEventListener('click', (ev) => { if (Date.now() - draggedAt > 300) mapActivate(ev.target); });
  $('mapPane').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const reg = ev.target.closest && ev.target.closest('.region-g');
    if (reg) {
      ev.preventDefault();
      pickRegion(reg.dataset.region, !!reg.dataset.zoomable);
      const el = document.querySelector(`.region-g[data-region="${reg.dataset.region}"]`) || document.querySelector('.region-g');
      if (el) el.focus();
      return;
    }
    if (!ev.target.closest('.map-token, .map-room, .map-feature')) return;
    ev.preventDefault();
    mapActivate(ev.target);
  });
  // Text, split or map: per world on desktop; the phone button switches text and map.
  const VIEW_KEY = 'ensemble.view';
  function viewAll() { try { return JSON.parse(store.get(VIEW_KEY)) || {}; } catch (e) { return {}; } }
  function setView(mode, remember) {
    const story = $('story');
    story.classList.remove('view-text', 'view-split', 'view-map');
    story.classList.add('view-' + mode);
    document.querySelectorAll('.view-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === mode)));
    $('btnMapPhone').setAttribute('aria-pressed', String(mode === 'map'));
    if (remember && U.state) { const all = viewAll(); all[U.state.scenario.worldId] = mode; store.set(VIEW_KEY, JSON.stringify(all)); }
  }
  function restoreView() {
    setView((U.state && viewAll()[U.state.scenario.worldId]) || 'split', false);
    Object.keys(viewBoxes).forEach((k) => delete viewBoxes[k]);
    mapSel = null;
  }
  document.querySelectorAll('.view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view, true)));
  $('btnMapPhone').addEventListener('click', () => setView($('story').classList.contains('view-map') ? 'text' : 'map', false));
  setView('split', false);

  // A cast card is composed from one function per section, in renderCast. Each
  // section returns its markup, or '' to leave it out.
  // You, then the people with you, then other local characters; secondary
  // characters (task 2-1) in a collapsed "Elsewhere" list below.
  function renderCast() {
    $('castTitle').textContent = U.state.scenario.castLabel || 'People';
    const here = U.state.characters[U.state.player].status.location;
    const ids = E.Engine.cast(U.state);
    const card = (id) => {
      const c = U.state.characters[id];
      const isPlayer = id === U.state.player;
      const dead = c.status.health === 'dead';
      const min = U.isMinimized(id);
      const sections = min ? [U.cardMini(id, c, isPlayer)] : [U.cardHeader(id, c, isPlayer), U.cardStatus(c, isPlayer), U.cardDetails(id, c, dead)].filter(Boolean);
      return `<div class="card ${!isPlayer && c.status.location === here ? 'here' : ''} ${dead ? 'dead' : ''} ${min ? 'min' : ''}" data-id="${esc(id)}">${sections.join('')}</div>`;
    };
    const others = ids.filter((id) => id !== U.state.player);
    const withYou = others.filter((id) => U.state.characters[id].status.location === here);
    const local = others.filter((id) => !withYou.includes(id) && E.Engine.tier(U.state, id) === 'local');
    const away = others.filter((id) => !withYou.includes(id) && !local.includes(id));
    $('cast').innerHTML = [U.state.player].concat(withYou, local).map(card).join('') + (away.length
      ? `<details class="elsewhere"${elsewhereOpen() ? ' open' : ''}><summary>Elsewhere (${away.length})</summary>${away.map(card).join('')}</details>`
      : '');
    $('btnCollapseAll').textContent = ids.every(U.isMinimized) ? 'Expand all' : 'Collapse all';
  }
  // Whether the Elsewhere list is open, remembered per world.
  const ELSEWHERE_KEY = 'ensemble.cards.elsewhere';
  function elsewhereAll() {
    try { return JSON.parse(store.get(ELSEWHERE_KEY)) || {}; } catch (e) { return {}; }
  }
  const elsewhereOpen = () => !!elsewhereAll()[U.state.scenario.worldId];
  $('cast').addEventListener('toggle', (ev) => {
    if (!ev.target.matches || !ev.target.matches('details.elsewhere')) return;
    const all = elsewhereAll();
    all[U.state.scenario.worldId] = ev.target.open;
    store.set(ELSEWHERE_KEY, JSON.stringify(all));
  }, true);
  Object.assign(U, { localMapHtml, renderMap, restoreView, renderCast });
})();
