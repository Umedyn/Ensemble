// The character form (task 4-1, shared since task 6-2): the game uses it to
// make the player's character from a start's playerSlot, the creator (author
// mode) to edit the world's people. E.CharMaker decides what is allowed and
// builds the character; this only draws the form and keeps its values. A DOM
// file, loaded by index.html and creator.html.
//
// const cf = CharForm.create(bodyEl, errorsEl);
// cf.open({ sc, form, author, assetUrl(path), onChange(form), images: [paths], onPortraitFile(file) → Promise<path> })
// cf.state: { sc, form, offers, pending, note, errors, opts } while open, else null
(function (root) {
  const E = root.Ensemble;
  const CF = (E.CharForm = {});
  const esc = E.esc;

  CF.create = function (body, errorsEl) {
    const CM = E.CharMaker;
    const cf = { state: null };
    const changed = () => { if (cf.state && cf.state.opts.onChange) cf.state.opts.onChange(cf.state.form); };
    cf.open = function (opts) {
      cf.state = { sc: opts.sc, form: opts.form, offers: {}, pending: null, note: '', errors: [], opts };
      cf.render();
    };
    cf.close = () => { cf.state = null; body.innerHTML = ''; if (errorsEl) errorsEl.innerHTML = ''; };
    cf.setErrors = (list) => { if (!cf.state) return; cf.state.errors = list || []; renderErrors(); };
    const renderErrors = () => { if (errorsEl && cf.state) errorsEl.innerHTML = cf.state.errors.map((e) => `<li>${esc(e)}</li>`).join(''); };

    cf.render = function () {
      const m = cf.state;
      if (!m) return;
      const { sc, form, offers } = m;
      const author = !!m.opts.author;
      const slot = sc.playerSlot;
      const L = CM.LIMITS;
      const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
      const val = (k) => esc(form[k] == null ? '' : String(form[k]));
      const suggestBtn = (field) => `<button type="button" class="small mk-suggest" data-suggest="${field}" data-fk="sg-${field}"${m.pending ? ' disabled' : ''} title="Ask the model for an idea; nothing changes until you pick it">${m.pending === field ? 'Thinking…' : '💡 Suggest'}</button>`;
      const offerBox = (field) => (offers[field] ? `<div class="mk-offer"><span class="muted">Suggestion:</span> ${esc(offers[field])} <button type="button" class="small" data-offer-use="${field}" data-fk="use-${field}">Use</button> <button type="button" class="small ghost" data-offer-dismiss="${field}">Dismiss</button></div>` : '');
      const text = (k, label, max, rows) => `<label>${label}${rows ? `<textarea data-f="${k}" data-fk="f-${k}" maxlength="${max}" rows="${rows}">${val(k)}</textarea>` : `<input type="text" data-f="${k}" data-fk="f-${k}" maxlength="${max}" value="${val(k)}">`}</label>`;
      const choices = (key, list, title, freeText) => {
        if (author) return text(freeText, key === 'role' ? 'Role' : 'People or origin (optional)', key === 'role' ? L.role : L.people);
        if (!(list || []).length && !slot.freeform) return '';
        const listed = (list || []).some((r) => r.id === form[key]);
        const own = slot.freeform ? `<label class="mk-option"><input type="radio" name="mk-${key}" value="" data-choice="${key}"${listed ? '' : ' checked'}> <span><b>Something else</b> <input type="text" data-f="${freeText}" maxlength="60" value="${val(freeText)}" placeholder="Write your own" aria-label="Your own ${title.toLowerCase()}"></span></label>` : '';
        return `<fieldset class="mk-choices"><legend>${title}</legend>${(list || []).map((r) => `<label class="mk-option"><input type="radio" name="mk-${key}" value="${esc(r.id)}" data-choice="${key}"${form[key] === r.id ? ' checked' : ''}> <span><b>${esc(r.label)}</b>${r.desc ? ` <span class="muted">${esc(r.desc)}</span>` : ''}</span></label>`).join('')}${own}</fieldset>`;
      };
      const traitIdeas = [...new Set(CM.suggestedTraits(sc, form).concat(offers.traits || []))].filter((t) => !form.traits.some((x) => x.toLowerCase() === t.toLowerCase()));
      const left = CM.pointsLeft(sc, form.skills);
      const skills = sc.skills.map((k) => {
        const v = form.skills[k] || 0;
        return `<div class="mk-skill"><span>${esc(k)}</span><button type="button" class="small" data-skill="${esc(k)}" data-step="-1" data-fk="sk-${esc(k)}-" aria-label="Less ${esc(k)}"${v <= 0 ? ' disabled' : ''}>−</button><b>${v}</b><button type="button" class="small" data-skill="${esc(k)}" data-step="1" data-fk="sk-${esc(k)}+" aria-label="More ${esc(k)}"${v >= slot.maxSkill || (!author && left <= 0) ? ' disabled' : ''}>+</button></div>`;
      }).join('');
      const extra = (m.opts.images || []).filter((p) => !(sc.portraitSet || []).includes(p));
      const pics = [['standin', 'Stand-in'], ['none', 'Initials only']].concat((sc.portraitSet || []).concat(extra).map((p) => [p, null]));
      if (author && typeof form.portrait === 'string' && E.isImagePath(form.portrait) && !pics.some(([v]) => v === form.portrait)) pics.push([form.portrait, null]);
      const assetUrl = m.opts.assetUrl || (() => null);
      const portraits = pics.map(([v, label]) => {
        const url = label ? null : assetUrl(v);
        const name = v.split('/').pop();
        return `<label class="mk-pic"><input type="radio" name="mk-portrait" value="${esc(v)}" data-portrait="1"${form.portrait === v ? ' checked' : ''}> ${label ? esc(label) : url ? `<img src="${esc(url)}" alt="${esc(name)}" class="portrait">` : esc(name)}</label>`;
      }).join('') + (author && m.opts.onPortraitFile ? '<label class="btn small mk-pfile">Choose an image file…<input type="file" accept="image/*" data-pfile="1" hidden></label>' : '');
      const feelings = CM.castFor(sc).map((id) => {
        const c = sc.characterData.find((d) => d.id === id);
        const v = form.feelings[id] || 0;
        return `<label class="mk-feel"><span>${esc(c.name)} <span class="muted small">${esc(c.role || '')}</span></span><input type="range" min="-100" max="100" step="5" value="${v}" data-feel-id="${esc(id)}" aria-label="${author ? 'Their' : 'Your'} feelings toward ${esc(c.name)}"><span class="rel-${E.relWord(v)}" data-feel-out="${esc(id)}">${E.relWord(v)} ${v > 0 ? '+' : ''}${v}</span></label>`;
      }).join('');
      const you = author ? { who: 'Who they are', voice: 'Voice (how they talk)', want: 'What they want', secret: 'A secret (the others may find it out; never shown to the player)', guard: 'How well they keep it', appearance: 'Appearance (the first sentence is how the story sees them)', feel: 'How they feel about the others at the start' }
        : { who: 'Who you are', voice: 'Voice (how you talk)', want: 'What you want', secret: 'A secret (optional; the others may find it out)', guard: 'How well you keep it', appearance: 'Appearance (the first sentence is how the story sees you)', feel: 'How you feel about them at the start' };
      body.innerHTML =
        '<div class="mk-row">' +
          `<label class="mk-name">Name<input type="text" data-f="name" data-fk="f-name" maxlength="${L.name}" value="${val('name')}" autocomplete="off"></label>` +
          `<label>Pronouns<input type="text" data-f="pronouns" data-fk="f-pronouns" maxlength="${L.pronouns}" value="${val('pronouns')}" list="mkPronouns"></label>` +
          `<label class="mk-age">Age<input type="number" data-f="age" data-fk="f-age" min="1" max="129" value="${val('age')}"></label>` +
        '</div><datalist id="mkPronouns"><option value="she/her"><option value="he/him"><option value="they/them"></datalist>' +
        (author ? `<div class="mk-row">${choices('role', null, 'Role', 'roleText')}${choices('people', null, 'People', 'peopleText')}</div>` : choices('role', slot.roles, 'Role', 'roleText') + choices('people', slot.peoples, 'People', 'peopleText')) +
        `<div class="mk-field">${text('description', you.who, L.description, 3)}${suggestBtn('description')}${offerBox('description')}</div>` +
        text('appearance', you.appearance, L.appearance, 2) +
        `<fieldset class="mk-traits"><legend>Traits</legend><div>${form.traits.map((t, i) => `<span class="tag mk-chip">${esc(t)} <button type="button" class="ghost" data-trait-remove="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('') || '<span class="muted small">None yet.</span>'}</div>` +
          `<div class="row"><input type="text" id="mkTrait" maxlength="${L.trait}" placeholder="Add a trait" aria-label="Add a trait" data-fk="trait-in"><button type="button" class="small" id="mkTraitAdd">Add</button>${suggestBtn('traits')}</div>` +
          (traitIdeas.length ? `<div class="mk-ideas"><span class="muted small">Ideas:</span> ${traitIdeas.map((t) => `<button type="button" class="small mk-idea" data-trait-add="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : '') +
        '</fieldset>' +
        `<div class="mk-field">${text('voice', you.voice, L.voice)}${suggestBtn('voice')}${offerBox('voice')}</div>` +
        text('want', you.want, L.want) +
        `<div class="mk-row">${text('secret', you.secret, L.secret, 2)}<label class="mk-guard">${you.guard}<select data-f="guard">${['low', 'medium', 'high'].map((g) => `<option value="${g}"${form.guard === g ? ' selected' : ''}>${g}</option>`).join('')}</select></label></div>` +
        `<fieldset class="mk-skills"><legend>${author ? `Skills: 0 to ${slot.maxSkill} each` : `Skills: <span class="${left < 0 ? 'fail' : ''}">${left} of ${slot.skillPoints} points left</span>, up to ${slot.maxSkill} each`}</legend>${skills}</fieldset>` +
        `<fieldset class="mk-pics"><legend>Portrait${author ? ' <span class="muted">(your own images only)</span>' : ''}</legend>${portraits}</fieldset>` +
        (feelings ? `<fieldset class="mk-feelings"><legend>${you.feel}</legend>${feelings}</fieldset>` : '') +
        (author ? authorFields(sc, form) : '') +
        (m.note ? `<div class="fail small">${esc(m.note)}</div>` : '');
      renderErrors();
      if (focusKey) { const el = body.querySelector(`[data-fk="${focusKey}"]`); if (el && !el.disabled) el.focus(); }
    };
    // What only an author sets: what they know, the default tier, tags,
    // starting needs and the agenda.
    function authorFields(sc, form) {
      const a = form.agenda;
      return `<fieldset class="mk-author"><legend>For the story engine</legend>
        <label>What they know at the start <span class="muted small">(one per line; private to them)</span><textarea data-af="knows" data-fk="af-knows" rows="2">${esc((form.knows || []).join('\n'))}</textarea></label>
        <label>Tags <span class="muted small">(comma-separated; visible states such as "bandaged left arm")</span><input type="text" data-af="tags" data-fk="af-tags" value="${esc((form.tags || []).join(', '))}"></label>
        <label>Lore topics <span class="muted small">(up to ${E.Lore.LIMITS.topics}, comma-separated, from ${esc(E.Lore.topicIds(sc).join(', '))}: when they are the player, lore on these comes first, besides what their role and traits bring)</span><input type="text" data-af="topics" data-fk="af-topics" value="${esc((form.topics || []).join(', '))}"></label>
        <div class="mk-row"><label>In the foreground<select data-af="tier"><option value=""${!form.tier ? ' selected' : ''}>if in the player's room</option><option value="local"${form.tier === 'local' ? ' selected' : ''}>yes</option><option value="secondary"${form.tier === 'secondary' ? ' selected' : ''}>no, offstage</option></select></label>
          <label class="mk-option"><input type="checkbox" data-af="pinned"${form.pinned ? ' checked' : ''}> <span>Always in the foreground</span></label></div>
        ${(sc.needs || []).length ? `<div class="mk-row">${sc.needs.map((n) => `<label>${esc(n.label || n.id)} at the start<input type="number" min="0" max="1" step="0.05" data-need="${esc(n.id)}" data-fk="need-${esc(n.id)}" value="${esc(form.needs[n.id] ?? '')}" placeholder="0"></label>`).join('')}</div>` : ''}
        <label>Agenda<select data-af="agendaMode"><option value="model"${form.agendaMode === 'model' ? ' selected' : ''}>the model proposes one in play</option><option value="none"${form.agendaMode === 'none' ? ' selected' : ''}>none: they keep to their routine</option><option value="set"${form.agendaMode === 'set' ? ' selected' : ''}>this one</option></select></label>
        ${form.agendaMode === 'set' ? `<div class="mk-agenda">
          <label>Goal<input type="text" data-ag="goal" data-fk="ag-goal" maxlength="200" value="${esc(a.goal)}"></label>
          <div class="mk-row"><label>Hours a step<input type="number" min="1" max="240" data-ag="hours" data-fk="ag-hours" value="${esc(a.hours ?? '')}" placeholder="12"></label>
            <label>Who sees the steps<select data-ag="visibility"><option value=""${!a.visibility ? ' selected' : ''}>hidden (default)</option><option value="heard"${a.visibility === 'heard' ? ' selected' : ''}>heard</option></select></label></div>
          ${a.steps.map((s, i) => `<div class="mk-step"><input type="text" data-step-text="${i}" data-fk="st-${i}" value="${esc(s.text)}" placeholder="runs a second culture in the unlogged incubator" aria-label="Step ${i + 1}"><label class="mk-option"><input type="checkbox" data-step-contact="${i}"${s.contact ? ' checked' : ''}> <span>comes to find the player</span></label><button type="button" class="small ghost" data-step-del="${i}" aria-label="Remove step ${i + 1}">✕</button></div>`).join('')}
          <button type="button" class="small" data-step-add="1">+ Step</button></div>` : ''}</fieldset>`;
    }

    body.addEventListener('input', (ev) => {
      const m = cf.state;
      if (!m) return;
      const t = ev.target;
      if (t.dataset.f) m.form[t.dataset.f] = t.dataset.f === 'age' ? (t.value === '' ? null : Number(t.value)) : t.value;
      // Typing your own role or people picks "Something else".
      if ((t.dataset.f === 'roleText' || t.dataset.f === 'peopleText') && t.closest('.mk-option')) {
        const radio = t.closest('.mk-option').querySelector('input[type=radio]');
        radio.checked = true;
        m.form[radio.dataset.choice] = '';
      }
      if (t.dataset.feelId) {
        const v = Number(t.value);
        m.form.feelings[t.dataset.feelId] = v;
        const out = body.querySelector(`[data-feel-out="${t.dataset.feelId}"]`);
        out.textContent = `${E.relWord(v)} ${v > 0 ? '+' : ''}${v}`;
        out.className = 'rel-' + E.relWord(v);
      }
      if (t.dataset.af === 'knows') m.form.knows = t.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (t.dataset.af === 'tags') m.form.tags = t.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (t.dataset.af === 'topics') m.form.topics = t.value.split(',').map((x) => x.trim()).filter(Boolean);
      if (t.dataset.need) m.form.needs[t.dataset.need] = t.value === '' ? '' : Number(t.value);
      if (t.dataset.ag) m.form.agenda[t.dataset.ag] = t.dataset.ag === 'hours' ? (t.value === '' ? null : Number(t.value)) : t.value;
      if (t.dataset.stepText != null) m.form.agenda.steps[Number(t.dataset.stepText)].text = t.value;
      changed();
    });
    body.addEventListener('change', async (ev) => {
      const m = cf.state;
      if (!m) return;
      const t = ev.target;
      if (t.dataset.choice) {
        m.form[t.dataset.choice] = t.value;
        // A listed role brings its skills; your own keeps what you set.
        if (t.dataset.choice === 'role' && t.value) m.form.skills = CM.roleSkills(m.sc, t.value);
      } else if (t.dataset.portrait) m.form.portrait = t.value;
      else if (t.dataset.pfile && t.files && t.files[0]) {
        try { m.form.portrait = await m.opts.onPortraitFile(t.files[0]); m.note = ''; } catch (e) { m.note = e.message; }
      } else if (t.dataset.af === 'pinned') m.form.pinned = t.checked;
      else if (t.dataset.af === 'tier' || t.dataset.af === 'agendaMode') m.form[t.dataset.af] = t.value;
      else if (t.dataset.ag === 'visibility') m.form.agenda.visibility = t.value;
      else if (t.dataset.stepContact != null) m.form.agenda.steps[Number(t.dataset.stepContact)].contact = t.checked;
      else return;
      changed();
      cf.render();
    });
    function addTrait(t) {
      const m = cf.state;
      const v = String(t || '').trim().slice(0, CM.LIMITS.trait);
      if (m.offers.traits) m.offers.traits = m.offers.traits.filter((x) => x !== t);
      if (!v || m.form.traits.some((x) => x.toLowerCase() === v.toLowerCase())) return;
      m.form.traits.push(v);
    }
    body.addEventListener('keydown', (ev) => {
      if (!cf.state || ev.target.id !== 'mkTrait' || ev.key !== 'Enter') return;
      ev.preventDefault();
      addTrait(ev.target.value);
      changed();
      cf.render();
      const i = body.querySelector('#mkTrait');
      if (i) i.focus();
    });
    body.addEventListener('click', (ev) => {
      const m = cf.state;
      if (!m) return;
      const b = ev.target.closest('button');
      if (!b) return;
      const f = m.form;
      if (b.dataset.skill) {
        const k = b.dataset.skill;
        const next = Object.assign({}, f.skills, { [k]: (f.skills[k] || 0) + Number(b.dataset.step) });
        if (CM.skillProblems(m.sc, next).length) return;
        f.skills = next;
      } else if (b.dataset.traitRemove != null) f.traits.splice(Number(b.dataset.traitRemove), 1);
      else if (b.dataset.traitAdd != null) addTrait(b.dataset.traitAdd);
      else if (b.id === 'mkTraitAdd') addTrait(body.querySelector('#mkTrait').value);
      else if (b.dataset.suggest) return void runSuggest(b.dataset.suggest);
      else if (b.dataset.offerUse) { f[b.dataset.offerUse] = m.offers[b.dataset.offerUse]; m.offers[b.dataset.offerUse] = null; }
      else if (b.dataset.offerDismiss) m.offers[b.dataset.offerDismiss] = null;
      else if (b.dataset.stepAdd) f.agenda.steps.push({ text: '', contact: false });
      else if (b.dataset.stepDel != null) f.agenda.steps.splice(Number(b.dataset.stepDel), 1);
      else return;
      changed();
      cf.render();
    });
    // One field from the model, offered and never applied on its own.
    async function runSuggest(field) {
      const m = cf.state;
      if (!m || m.pending) return;
      m.pending = field;
      m.note = '';
      cf.render();
      try { m.offers[field] = await CM.suggest(m.sc, field, m.form); }
      catch (e) { m.note = e.message; }
      m.pending = null;
      if (cf.state === m) cf.render();
    }
    return cf;
  };
})(typeof window !== 'undefined' ? window : globalThis);
