// Says plainly when this browser won't keep what the page saves (task A-1).
// A DOM file, loaded by the game and the creator.
(function () {
  const E = window.Ensemble;
  const CLOSED_KEY = 'ensemble.fileNoticeClosed';
  const MARKER_KEY = 'peek.marker';

  function show(text, onClose) {
    let box = document.getElementById('storeNotice');
    if (!box) {
      box = document.createElement('div');
      box.id = 'storeNotice';
      box.className = 'store-notice';
      box.setAttribute('role', 'alert');
      document.body.prepend(box);
    }
    box.textContent = '';
    const line = document.createElement('span');
    line.textContent = text;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'OK';
    btn.addEventListener('click', () => { box.remove(); if (onClose) onClose(); });
    box.append(line, btn);
  }

  // Opened from disk, some browsers (Firefox) give each page its own storage.
  // A hidden frame of a sibling page reports what it can see of a marker
  // written here. → true, false, or null when it couldn't tell.
  function pagesShareStorage() {
    return new Promise((resolve) => {
      const marker = String(Math.random());
      try { localStorage.setItem(MARKER_KEY, marker); } catch (e) { return resolve(null); }
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = 'storecheck.html';
      const done = (out) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        frame.remove();
        try { localStorage.removeItem(MARKER_KEY); } catch (e) {}
        resolve(out);
      };
      const onMessage = (ev) => {
        if (ev.source === frame.contentWindow && ev.data && ev.data.type === 'ensemble-storecheck') done(ev.data.marker === marker);
      };
      const timer = setTimeout(() => done(null), 3000);
      window.addEventListener('message', onMessage);
      document.body.appendChild(frame);
    });
  }

  // Call once E.Store is ready.
  E.pageCheck = async function () {
    E.Store.onFail = () => show('Your last change could not be saved: the browser refused it, and its storage may be full. Press Save in the game to download your work.');
    if (!E.Store.kept) show('This browser isn\'t letting Ensemble keep anything, which usually means a private window. Your game and settings last only until you close this tab, so press Save in the game to download your work.');
    if (location.protocol !== 'file:' || E.Prefs.get(CLOSED_KEY)) return;
    if ((await pagesShareStorage()) !== false) return;
    show('This browser keeps each Ensemble page\'s saves and settings apart when the game is opened straight from a file, so its pages can\'t see each other\'s. Start Ensemble with start.bat or start.sh instead and play at localhost. Your game here is safe: press Save to download it, then Load it there.',
      () => E.Prefs.set(CLOSED_KEY, '1'));
  };
})();
