// ==UserScript==
// @name         EL - Custom loading screen (Unity patch)
// @namespace    https://github.com/NononoMO/Evercustom
// @version      1.2.0
// @description  Replaces the Everlusting Life loading screen with custom art (random pick).
// @match        https://gi.nutaku.com/play-frame/everlusting-life/*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      raw.githubusercontent.com
// @connect      github.com
// @connect      objects.githubusercontent.com
// @connect      release-assets.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/NononoMO/Evercustom/main/EL_loading_screen.user.js
// @downloadURL  https://raw.githubusercontent.com/NononoMO/Evercustom/main/EL_loading_screen.user.js
// ==/UserScript==

(function () {
  // Set to true only while testing: prints [ELpatch] messages in the console
  const DEBUG = false;

  // Build, release and patch list come from manifest.json in the repo,
  // so updating the repo updates everyone without reinstalling the script.
  const MANIFEST_URL = 'https://raw.githubusercontent.com/NononoMO/Evercustom/main/manifest.json';
  const RELEASES     = 'https://github.com/NononoMO/Evercustom/releases/download/';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const log = (...a) => { if (DEBUG) console.log('[ELpatch]', ...a); };
  const origFetch = W.fetch;

  // Downloads go through the extension, not the page: they don't show up in the page's
  // network/performance data (or in anything the page reports, like Sentry).
  const gmGet = (url, responseType) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, responseType, anonymous: true, nocache: true, timeout: 60000,
      onload: (r) => (r.status === 200 ? resolve(r.response) : reject(new Error(url + ' HTTP ' + r.status))),
      onerror: () => reject(new Error('download failed: ' + url)),
      ontimeout: () => reject(new Error('download timeout: ' + url)),
    });
  });

  // Start loading the manifest right away and pick a patch from it
  const plan = gmGet(MANIFEST_URL, 'text').then((txt) => {
    const m = JSON.parse(txt);
    const list = m.patches || [];
    const chosen = list[Math.floor(Math.random() * list.length)];
    log('manifest: build', m.build, '| release', m.release, '| chosen', chosen);
    // Drop patches saved for older releases
    for (const k of GM_listValues()) {
      if (k.startsWith('patch:') && !k.startsWith('patch:' + m.release + '/')) GM_deleteValue(k);
    }
    return {
      build: m.build, chosen,
      key: chosen ? 'patch:' + m.release + '/' + chosen : null,
      url: chosen ? RELEASES + m.release + '/' + chosen : null,
    };
  });

  // Patches are kept in Tampermonkey storage after the first download (one per release+name)
  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => {
    const s = atob(b64), u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  };
  const getPatch = async (p) => {
    const saved = GM_getValue(p.key, null);
    if (saved) { log('patch from local storage:', p.chosen); return fromB64(saved); }
    const u8 = new Uint8Array(await gmGet(p.url, 'arraybuffer'));
    try { GM_setValue(p.key, toB64(u8)); } catch (e) { log('could not store patch:', e); }
    log('patch downloaded and stored:', p.chosen);
    return u8;
  };

  const gunzip = async (u8) =>
    new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

  const applyPatch = (src, patch) => {
    const dv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
    if (new TextDecoder().decode(patch.subarray(0, 8)) !== 'ELPATCH1') throw new Error('invalid patch file');
    const origLen = Number(dv.getBigUint64(8, true));
    const count = dv.getUint32(16, true);
    if (origLen !== src.length) throw new Error(`size mismatch (${src.length} vs ${origLen}): new game build?`);

    let p = 20, total = src.length;
    const splices = [];
    for (let i = 0; i < count; i++) {
      const o = Number(dv.getBigUint64(p, true)), l = dv.getUint32(p + 8, true), nl = dv.getUint32(p + 12, true);
      p += 16;
      splices.push([o, l, patch.subarray(p, p + nl)]);
      p += nl;
      total += nl - l;
    }
    const out = new Uint8Array(total);
    let cur = 0, w = 0;
    for (const [o, l, nb] of splices) {
      out.set(src.subarray(cur, o), w); w += o - cur;
      out.set(nb, w); w += nb.length;
      cur = o + l;
    }
    out.set(src.subarray(cur), w);
    return out;
  };

  const hooked = async function fetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (!url.includes('ac_webgl.data.unityweb')) return origFetch.call(this, input, init);
    try {
      const p = await plan;
      if (!p.url) { log('original screen this time'); return origFetch.call(this, input, init); }
      if (!url.includes(p.build)) {
        log('game updated; manifest is for build', p.build, '→ original');
        return origFetch.call(this, input, init);
      }
      const [dataBuf, patch] = await Promise.all([
        origFetch.call(W, url).then((r) => r.arrayBuffer()),
        getPatch(p),
      ]);
      let src = new Uint8Array(dataBuf);
      if (src[0] === 0x1f && src[1] === 0x8b) src = await gunzip(src);
      let out;
      try {
        out = applyPatch(src, patch);
      } catch (e) {
        GM_deleteValue(p.key); // corrupt or stale copy: download again next time
        throw e;
      }
      log('patch applied ✔', p.chosen, out.length, 'bytes');
      return new Response(out, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(out.length) },
      });
    } catch (e) {
      log('failed, loading the original:', e);
      return origFetch.call(this, input, init);
    }
  };

  // Look like the native function if something inspects it
  Object.defineProperty(hooked, 'toString', { value: () => 'function fetch() { [native code] }' });
  W.fetch = hooked;
})();
