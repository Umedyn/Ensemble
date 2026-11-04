// Picture URLs for a world's images (task A-6: shared by the New game and
// game pages). Paths in the scenario are relative to the world folder. Server
// worlds load them from scenarios/<folder>/; worlds kept from a folder or zip
// (task A-5) and test play use object URLs made from their stored files.
// Neither URL is ever saved. A picture that fails to load falls back to the
// monogram.
(function () {
  const E = window.Ensemble;
  const U = E.UI;

  const diskAssets = new Map(); // world folder -> { path: File }
  const assetUrls = new Map(); // "folder/path" -> object URL
  const portraitUrl = (path) => assetUrl(U.state.scenario.folder, path);
  // Site maps from the shared library (task 6-3) have their images there:
  // picked with Open folder (object URLs) or on the server.
  const siteMapUrl = (m) => {
    if (!m.library) return portraitUrl(m.image);
    const f = U.libraryAssets[m.image];
    if (f) { const key = 'library/' + m.image; if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(f)); return assetUrls.get(key); }
    return location.protocol === 'file:' ? null : `library/${m.image.split('/').map(encodeURIComponent).join('/')}`;
  };
  function assetUrl(folder, path) {
    const files = diskAssets.get(folder);
    if (files && files[path]) {
      const key = folder + '/' + path;
      if (!assetUrls.has(key)) assetUrls.set(key, URL.createObjectURL(files[path]));
      return assetUrls.get(key);
    }
    return location.protocol === 'file:' ? null : `scenarios/${encodeURIComponent(folder)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  const failedUrls = new Set(); // pictures that didn't load: monogram from then on, no flicker
  Object.assign(U, { diskAssets, portraitUrl, siteMapUrl, assetUrl, failedUrls });
})();
