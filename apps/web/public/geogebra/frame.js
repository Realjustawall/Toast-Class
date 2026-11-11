/* TOASTER bridge for the unmodified GeoGebra Classic runtime.
   Serve this ONLY from the dedicated static math origin, never the app origin.
   GWT needs same-origin access to its own nested compilation frames. */
(() => {
  const options = new URLSearchParams(location.hash.slice(1));
  const token = options.get('token'),
    assetOrigin = new URL(location.href).origin,
    parentOrigin = options.get('parent');
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  let pdfReady;
  const pdf = () =>
    (pdfReady ??= (async () => {
      const directory = assetOrigin + '/vendor/geogebra/GeoGebra/HTML5/5.0/web3d/js/';
      if (!window.canvas2pdf) await loadScript(directory + 'canvas2pdf.min.js');
      await Promise.all([
        loadScript(directory + 'Roboto.js'),
        loadScript(directory + 'RobotoSerif.js'),
      ]);
    })());
  if (
    parent === window ||
    !parentOrigin ||
    parentOrigin === assetOrigin ||
    !/^https?:\/\//.test(parentOrigin)
  )
    return;
  const editable = options.get('edit') === '1';
  let canEdit = editable,
    api,
    applying = false,
    timer;
  const send = (type, extra = {}) =>
    parent.postMessage({ channel: 'toaster-geogebra', token, type, ...extra }, parentOrigin);
  const snapshot = () => {
    if (!api || applying || !canEdit) return;
    api.getBase64((state) => send('state', { state }));
  };
  const dirty = () => {
    if (!api || applying || !canEdit) return;
    send('dirty');
    clearTimeout(timer);
    timer = setTimeout(snapshot, 700);
  };
  const permissions = () => {
    api.showToolBar(canEdit);
    api.showMenuBar(canEdit);
    api.showAlgebraInput(canEdit);
    api.enableRightClick(canEdit);
    api.enableLabelDrags(canEdit);
  };
  addEventListener('message', (event) => {
    const message = event.data;
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      message?.channel !== 'toaster-geogebra' ||
      message.token !== token ||
      !api
    )
      return;
    if (message.type === 'load') {
      if (typeof message.state !== 'string' || message.state.length > 7000000) return;
      clearTimeout(timer);
      applying = true;
      canEdit = message.canEdit === true;
      const loaded = () => {
        permissions();
        applying = false;
        send('loaded');
      };
      try {
        if (message.state) api.setBase64(message.state, loaded);
        else {
          api.reset();
          loaded();
        }
      } catch {
        applying = false;
        send('error');
      }
    } else if (message.type === 'permissions') {
      canEdit = message.canEdit === true;
      permissions();
    } else if (message.type === 'snapshot') snapshot();
    else if (message.type === 'perspective' && /^[1-6]$/.test(message.perspective)) {
      const previous = applying;
      applying = true;
      try {
        api.setPerspective(message.perspective);
      } finally {
        applying = previous;
      }
    } else if (message.type === 'export') {
      if (message.format === 'ggb')
        api.getBase64((data) => send('download', { format: 'ggb', data }));
      else if (message.format === 'png')
        send('download', { format: 'png', data: api.getPNGBase64(1, false, 72) });
      else if (message.format === 'svg')
        api.exportSVG((data) => {
          if (typeof data === 'string') send('download', { format: 'svg', data });
        });
      else if (message.format === 'pdf')
        pdf()
          .then(() => {
            api.exportPDF(1, (data) => {
              if (typeof data === 'string') send('download', { format: 'pdf', data });
            });
          })
          .catch(() => send('error', { kind: 'export' }));
    }
  });
  try {
    const applet = new GGBApplet(
      {
        id: 'toasterGeoGebra',
        appName: 'classic',
        language: options.get('lang') === 'fa' ? 'fa' : 'en',
        width: Math.max(240, innerWidth),
        height: Math.max(180, innerHeight),
        showToolBar: editable,
        showAlgebraInput: editable,
        showMenuBar: editable,
        allowStyleBar: true,
        showZoomButtons: true,
        showAnimationButton: true,
        enableRightClick: editable,
        enableLabelDrags: editable,
        enableShiftDragZoom: true,
        enableCAS: true,
        enable3d: true,
        disableAutoScale: true,
        showFullscreenButton: false,
        perspective: '1',
        preventFocus: true,
        appletOnLoad(loadedApi) {
          api = loadedApi;
          window.__ggbApi = api;
          document.querySelector('#status').hidden = true;
          for (const method of [
            'registerAddListener',
            'registerRemoveListener',
            'registerUpdateListener',
            'registerClearListener',
            'registerRenameListener',
          ])
            api[method](dirty);
          api.registerClientListener((event) => {
            if (
              [
                'undo',
                'redo',
                'updateStyle',
                'perspectiveChange',
                'addMacro',
                'removeMacro',
              ].includes(event.type)
            )
              dirty();
          });
          send('ready', { version: api.getVersion() });
        },
      },
      true,
    );
    applet.setHTML5Codebase(assetOrigin + '/vendor/geogebra/GeoGebra/HTML5/5.0/web3d/');
    applet.inject('applet');
  } catch {
    send('error');
  }
  new ResizeObserver(() => {
    if (api && innerWidth >= 100 && innerHeight >= 100) api.setSize(innerWidth, innerHeight);
  }).observe(document.documentElement);
  addEventListener('pagehide', () => {
    clearTimeout(timer);
    api?.remove();
  });
})();
