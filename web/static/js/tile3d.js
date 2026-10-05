/*
 * tile3d.js
 * ---------------------------------------------------------------------------
 * Standalone 3D tile-box renderer for a Canvas 2D mahjong table.
 * No imports, no bundler, no external libraries. Plain ES5/ES2015 browser JS.
 *
 * Coordinate system (table space):
 *     x = right,  z = toward the viewer / bottom of the screen,  y = up.
 *     The table surface is the plane y = 0.
 *
 * Every public symbol lives on window.Tile3D:
 *
 *   createCamera(opts) -> projector
 *        projector.project(x, y, z) -> { x, y, scale }   true pinhole perspective
 *        projector.camera                              resolved options (read back)
 *        projector.set(opts)                           merge new camera parameters
 *        projector.viewPoint(x, y, z)                  -> { vx, vy, depth }  (extra helper)
 *
 *   PRESETS.flat / PRESETS.majsoul        ready-made camera option objects
 *   drawBox(ctx, projector, opts)         -> { topQuad, facesDrawn, depth, faces }
 *   quadPath(ctx, quad)                   trace a quad path on the ctx
 *   pointInQuad(pt, quad)                 convex hit test, for click picking
 *   drawFlatTile(ctx, opts)               enhanced 2D fallback tile
 *   loadTileAssets(baseUrl)               -> Promise, preloads every face bitmap
 *   getFaceUrl(tileStr, redDora, faceDown)  same mapping as renderer.js
 *   tileFaces(source, opts)               convenience faces object for drawBox
 *   getImage(url) / assets                shared image cache used by loadTileAssets
 *   TILE_ASSET_ROOT / TILE_ASSET_MAP
 *
 * Screen coordinates returned by the projector are board-logical: they are
 * centred on (0, 0) at the table centre (options centreX / centreY override
 * this) and one table unit maps to `scale` pixels at the reference depth.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  root.Tile3D = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * Asset mapping (mirrors web/static/js/renderer.js exactly)
   * ------------------------------------------------------------------ */

  var TILE_ASSET_ROOT = '/static/assets/tiles/Regular';

  var TILE_ASSET_MAP = {
    '1m': 'Man1', '2m': 'Man2', '3m': 'Man3', '4m': 'Man4', '5m': 'Man5',
    '6m': 'Man6', '7m': 'Man7', '8m': 'Man8', '9m': 'Man9',
    '1p': 'Pin1', '2p': 'Pin2', '3p': 'Pin3', '4p': 'Pin4', '5p': 'Pin5',
    '6p': 'Pin6', '7p': 'Pin7', '8p': 'Pin8', '9p': 'Pin9',
    '1s': 'Sou1', '2s': 'Sou2', '3s': 'Sou3', '4s': 'Sou4', '5s': 'Sou5',
    '6s': 'Sou6', '7s': 'Sou7', '8s': 'Sou8', '9s': 'Sou9',
    '1z': 'Ton', '2z': 'Nan', '3z': 'Shaa', '4z': 'Pei',
    '5z': 'Haku', '6z': 'Hatsu', '7z': 'Chun'
  };

  function getFaceUrl(tileStr, redDora, faceDown) {
    if (faceDown) { return TILE_ASSET_ROOT + '/Back.svg'; }
    var key = tileStr || '';
    var asset = TILE_ASSET_MAP[key];
    if (!asset) { return TILE_ASSET_ROOT + '/Front.svg'; }
    var suffix = redDora ? '-Dora' : '';
    return TILE_ASSET_ROOT + '/' + asset + suffix + '.svg';
  }

  /* ------------------------------------------------------------------ *
   * Small maths helpers
   * ------------------------------------------------------------------ */

  var EPS = 1e-6;
  var NEAR = 1;

  function num(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function lerp3(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
  }

  function sub3(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross3(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }
  function len3(a) { return Math.sqrt(dot3(a, a)); }
  function norm3(a) {
    var l = len3(a);
    if (l < EPS) { return { x: 0, y: 0, z: 0 }; }
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  }
  function dist2(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ------------------------------------------------------------------ *
   * Camera
   * ------------------------------------------------------------------ */

  var CAMERA_DEFAULTS = {
    camHeight: 1850,     // camera height above the table surface (table units)
    camDist: 1550,       // distance from the look-at point, measured in the xz plane
    lookAtZ: 0,          // z of the point the camera aims at (table centre = 0)
    fov: 0.62,           // vertical field of view, radians
    scale: 1,            // pixels per table unit at the reference depth
    tilt: null,          // elevation angle in radians; derived from camHeight/camDist when null
    centerX: 0,          // screen x of the table centre
    centerY: 0           // screen y of the table centre
  };

  var PRESETS = {
    /*
     * Near-orthographic top-down. Camera almost straight above the table with a
     * long lens, so the size falloff from the near edge to the far edge is ~1.5%.
     * This is the safe default that keeps the existing 2D layout legible.
     */
    flat: {
      camHeight: 60000,
      camDist: 2000,
      lookAtZ: 0,
      fov: 0.10,
      scale: 1,
      tilt: null
    },

    /*
     * The angled 雀魂 / Mahjong Soul table: the camera sits roughly 50 degrees
     * above the table surface, ~1.55 tiles in front of the centre, with a
     * normal lens. Far tiles end up about 68% the size of near tiles.
     */
    majsoul: {
      camHeight: 1850,
      camDist: 1550,
      lookAtZ: 0,
      fov: 0.62,
      scale: 1,
      tilt: null
    },

    /* Same perspective, but the table centre is pushed toward the far side. */
    majsoulCentered: {
      camHeight: 1850,
      camDist: 1550,
      lookAtZ: 120,
      fov: 0.62,
      scale: 1,
      tilt: null
    }
  };

  function resolveCamera(state, options) {
    var camDist = Math.max(1, num(options.camDist, CAMERA_DEFAULTS.camDist));
    var lookAtZ = num(options.lookAtZ, CAMERA_DEFAULTS.lookAtZ);
    var fov = clamp(num(options.fov, CAMERA_DEFAULTS.fov), 0.02, 2.6);
    var scale = num(options.scale, CAMERA_DEFAULTS.scale);
    var tilt = num(options.tilt, NaN);
    if (!isFinite(tilt)) {
      tilt = Math.atan2(num(options.camHeight, CAMERA_DEFAULTS.camHeight), camDist);
    }
    tilt = clamp(tilt, 0.02, Math.PI / 2 - 0.002);

    var camHeight = camDist * Math.sin(tilt);
    var targetZ = lookAtZ;
    var camPos = { x: 0, y: camHeight, z: targetZ + camDist * Math.cos(tilt) };
    var target = { x: 0, y: 0, z: targetZ };

    var forward = norm3(sub3(target, camPos));
    var worldUp = { x: 0, y: 1, z: 0 };
    var right = norm3(cross3(forward, worldUp));

    // Degenerate case: the camera is straight above the table, so the forward
    // axis is parallel to world up. Fall back to world x as the screen right.
    if (len3(right) < 0.5) { right = { x: 1, y: 0, z: 0 }; }
    var up = cross3(right, forward);

    var depthRef = dot3(sub3(target, camPos), forward);
    if (!isFinite(depthRef) || depthRef < NEAR) { depthRef = NEAR; }

    state.options = options;
    state.camHeight = camHeight;
    state.camDist = camDist;
    state.lookAtZ = lookAtZ;
    state.tilt = tilt;
    state.fov = fov;
    state.scale = scale;
    state.centerX = num(options.centerX, CAMERA_DEFAULTS.centerX);
    state.centerY = num(options.centerY, CAMERA_DEFAULTS.centerY);
    state.position = camPos;
    state.target = target;
    state.forward = forward;
    state.right = right;
    state.up = up;
    state.depthRef = depthRef;
    state.focal = scale * depthRef;
    state.tanHalfFov = Math.tan(fov / 2);
    return state;
  }

  function viewPoint(state, x, y, z) {
    var dx = x - state.position.x;
    var dy = y - state.position.y;
    var dz = z - state.position.z;
    var depth = dx * state.forward.x + dy * state.forward.y + dz * state.forward.z;
    if (depth < NEAR) { depth = NEAR; }
    return {
      vx: dx * state.right.x + dy * state.right.y + dz * state.right.z,
      vy: dx * state.up.x + dy * state.up.y + dz * state.up.z,
      depth: depth
    };
  }

  function createCamera(opts) {
    var state = {};
    function project(x, y, z) {
      var v = viewPoint(state, num(x, 0), num(y, 0), num(z, 0));
      var k = state.focal / v.depth;
      return {
        x: state.centerX + v.vx * k,
        y: state.centerY - v.vy * k,
        scale: state.depthRef / v.depth
      };
    }
    var projector = {
      camera: state,
      project: project,
      viewPoint: function (x, y, z) { return viewPoint(state, num(x, 0), num(y, 0), num(z, 0)); },
      set: function (next) {
        var merged = {};
        var key;
        for (key in state.options) {
          if (Object.prototype.hasOwnProperty.call(state.options, key)) { merged[key] = state.options[key]; }
        }
        for (key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key)) { merged[key] = next[key]; }
        }
        resolveCamera(state, merged);
        return projector;
      }
    };
    resolveCamera(state, opts || {});
    return projector;
  }

  /* ------------------------------------------------------------------ *
   * Image cache + asset preloading
   * ------------------------------------------------------------------ */

  var assetRoot = TILE_ASSET_ROOT;
  var assets = {};        // url -> { img, loaded, failed }

  function getImage(url) {
    var entry = assets[url];
    if (!entry) {
      var img = new Image();
      img.decoding = 'async';
      entry = { img: img, loaded: false, failed: false };
      assets[url] = entry;
      img.onload = function () { entry.loaded = true; };
      img.onerror = function () { entry.failed = true; };
      img.src = url;
    }
    return entry.img && entry.img.complete && entry.img.naturalWidth > 0 ? entry.img : null;
  }

  function preload(url) {
    return new Promise(function (resolve) {
      var entry = assets[url];
      if (!entry) {
        var img = new Image();
        img.decoding = 'async';
        entry = { img: img, loaded: false, failed: false };
        entry.done = resolve;
        assets[url] = entry;
        img.onload = function () { entry.loaded = true; resolve({ url: url, ok: true }); };
        img.onerror = function () { entry.failed = true; resolve({ url: url, ok: false }); };
        img.src = url;
      } else if (entry.loaded || entry.failed || (entry.img && entry.img.complete)) {
        resolve({ url: url, ok: !entry.failed });
      } else {
        var prev = entry.done;
        entry.done = function (r) { if (prev) { prev(r); } resolve(r); };
      }
    });
  }

  function assetUrlList() {
    var urls = [assetRoot + '/Back.svg', assetRoot + '/Front.svg'];
    var key, base;
    for (key in TILE_ASSET_MAP) {
      if (!Object.prototype.hasOwnProperty.call(TILE_ASSET_MAP, key)) { continue; }
      base = TILE_ASSET_MAP[key];
      urls.push(assetRoot + '/' + base + '.svg');
      if (base === 'Man5' || base === 'Pin5' || base === 'Sou5') {
        urls.push(assetRoot + '/' + base + '-Dora.svg');
      }
    }
    return urls;
  }

  function loadTileAssets(baseUrl) {
    if (typeof baseUrl === 'string' && baseUrl.length) { assetRoot = baseUrl; }
    var urls = assetUrlList();
    return Promise.all(urls.map(preload)).then(function (results) {
      var ok = 0, uri, i;
      for (i = 0; i < results.length; i++) { if (results[i].ok) { ok++; } }
      return { root: assetRoot, total: results.length, loaded: ok, results: results };
    });
  }

  /* ------------------------------------------------------------------ *
   * Quad helpers (screen space)
   * ------------------------------------------------------------------ */

  function quadPath(ctx, quad) {
    if (!quad || quad.length < 3) { return; }
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y);
    for (var i = 1; i < quad.length; i++) { ctx.lineTo(quad[i].x, quad[i].y); }
    ctx.closePath();
  }

  function pointInQuad(pt, quad) {
    if (!pt || !quad || quad.length < 3) { return false; }
    var sign = 0, i, a, b, cr;
    for (i = 0; i < quad.length; i++) {
      a = quad[i];
      b = quad[(i + 1) % quad.length];
      cr = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
      if (Math.abs(cr) < 1e-9) { continue; }
      var s = cr > 0 ? 1 : -1;
      if (sign === 0) { sign = s; }
      else if (s !== sign) { return false; }
    }
    return true;
  }

  function quadArea(quad) {
    if (!quad || quad.length < 3) { return 0; }
    var area = 0, i, a, b;
    for (i = 0; i < quad.length; i++) {
      a = quad[i];
      b = quad[(i + 1) % quad.length];
      area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) * 0.5;
  }

  function bilinearQuad(quad, u, v) {
    var p00 = quad[0], p10 = quad[1], p11 = quad[2], p01 = quad[3];
    var w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w11 = u * v, w01 = (1 - u) * v;
    return {
      x: p00.x * w00 + p10.x * w10 + p11.x * w11 + p01.x * w01,
      y: p00.y * w00 + p10.y * w10 + p11.y * w11 + p01.y * w01
    };
  }

  var rotateCache = new WeakMap ? new WeakMap() : null;

  function getRotatedImage(img, angle) {
    var twoPi = Math.PI * 2;
    var a = angle % twoPi;
    if (a < 0) { a += twoPi; }
    if (a < 1e-4 || Math.abs(a - twoPi) < 1e-4) { return img; }
    if (!rotateCache) { return img; }
    var per = rotateCache.get(img);
    if (!per) { per = {}; rotateCache.set(img, per); }
    var key = a.toFixed(4);
    if (per[key]) { return per[key]; }
    var cos = Math.cos(a), sin = Math.sin(a);
    var w = img.naturalWidth || img.width || 1;
    var h = img.naturalHeight || img.height || 1;
    var bw = Math.round(Math.abs(w * cos) + Math.abs(h * sin));
    var bh = Math.round(Math.abs(w * sin) + Math.abs(h * cos));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bw);
    canvas.height = Math.max(1, bh);
    var c2 = canvas.getContext('2d');
    c2.translate(bw / 2, bh / 2);
    c2.rotate(a);
    c2.drawImage(img, -w / 2, -h / 2, w, h);
    per[key] = canvas;
    return canvas;
  }

  /*
   * Map a bitmap onto an arbitrary screen-space quad. Canvas 2D can only apply
   * affine transforms, so the quad is subdivided into a grid of cells, each
   * drawn with a per-cell affine transform clipped to that cell. As the grid
   * gets finer the result converges on a true perspective texture map.
   */
  function drawImageInQuad(ctx, img, quad, options) {
    if (!img || !quad || quad.length !== 4) { return false; }
    var sw = img.naturalWidth || img.width;
    var sh = img.naturalHeight || img.height;
    if (!sw || !sh) { return false; }

    var opts = options || {};
    var fit = opts.fit || 'fill';
    var subdiv = Math.max(1, Math.min(12, Math.round(num(opts.subdiv, 4))));
    var imgRotation = num(opts.imageRotation, 0);
    var src = getRotatedImage(img, imgRotation);
    var rsw = src.naturalWidth || src.width || sw;
    var rsh = src.naturalHeight || src.height || sh;

    // Source rectangle inside the (possibly rotated) bitmap for the requested fit.
    var rx = 0, ry = 0, rw = rsw, rh = rsh;
    var quadW = dist2(quad[0], quad[1]);
    var quadH = dist2(quad[0], quad[3]);
    var imgAspect = rsw / rsh;
    if (fit === 'contain' || fit === 'cover') {
      var quadAspect = quadH > NEAR ? quadW / quadH : imgAspect;
      var scaleFit = fit === 'contain' ? imgAspect / quadAspect : quadAspect / imgAspect;
      if (scaleFit >= 1) {
        // Bitmap is wide relative to the cell: trim horizontally only.
        if (fit === 'contain') { rw = rsw / scaleFit; rx = (rsw - rw) / 2; }
        else { rh = rsh / scaleFit; ry = (rsh - rh) / 2; }
      } else {
        // Bitmap is tall relative to the cell: trim vertically only.
        if (fit === 'contain') { rh = rsh * scaleFit; ry = (rsh - rh) / 2; }
        else { rw = rsw * scaleFit; rx = (rsw - rw) / 2; }
      }
    }

    var i, j, u0, u1, v0, v1, cell, p0, p1, p2, p3, cw, chh, sx, sy, m11, m12, m21, m22, dx, dy;
    for (i = 0; i < subdiv; i++) {
      for (j = 0; j < subdiv; j++) {
        u0 = i / subdiv; u1 = (i + 1) / subdiv;
        v0 = j / subdiv; v1 = (j + 1) / subdiv;
        p0 = bilinearQuad(quad, u0, v0);
        p1 = bilinearQuad(quad, u1, v0);
        p2 = bilinearQuad(quad, u1, v1);
        p3 = bilinearQuad(quad, u0, v1);
        cell = [p0, p1, p2, p3];
        // Skip cells whose projected area collapses (avoids seams and NaNs).
        if (quadArea(cell) < 0.35) { continue; }

        sx = rx + u0 * rw;
        sy = ry + v0 * rh;
        cw = rw / subdiv;
        chh = rh / subdiv;

        ctx.save();
        quadPath(ctx, cell);
        ctx.clip();
        // Affine transform mapping the source rect onto the cell (3-point solve).
        m11 = (p1.x - p0.x) / cw;
        m12 = (p1.y - p0.y) / cw;
        m21 = (p3.x - p0.x) / chh;
        m22 = (p3.y - p0.y) / chh;
        dx = p0.x - m11 * sx - m21 * sy;
        dy = p0.y - m12 * sx - m22 * sy;
        ctx.transform(m11, m12, m21, m22, dx, dy);
        try { ctx.drawImage(src, 0, 0); } catch (e) { /* ignore tainted/gone bitmaps */ }
        ctx.restore();
      }
    }
    return true;
  }
  /* ------------------------------------------------------------------ *
   * Box geometry
   * ------------------------------------------------------------------ */

  var FACE_NAMES = ['top', 'front', 'right', 'back', 'left'];

  var DEFAULT_FACE_COLORS = {
    top: '#f4efe6',
    front: '#e5ddd0',
    right: '#c6bcaa',
    back: '#b9af9e',
    left: '#d4ccbd'
  };

  var DEFAULT_SHADING = {
    top: 1.0,
    front: 0.82,
    right: 0.62,
    back: 0.50,
    left: 0.72
  };

  function rotateYaw(px, pz, cx, cz, cos, sin) {
    var lx = px - cx, lz = pz - cz;
    return { x: cx + lx * cos + lz * sin, z: cz - lx * sin + lz * cos };
  }

  function buildBoxFaces(cx, cz, y, w, d, h, yaw) {
    var hw = w / 2, hd = d / 2;
    var cos = Math.cos(yaw), sin = Math.sin(yaw);

    function P(lx, ly, lz) {
      var r = rotateYaw(cx + lx, cz + lz, cx, cz, cos, sin);
      return { x: r.x, y: ly, z: r.z };
    }

    var A = P(-hw, y, hd), B = P(hw, y, hd), C = P(hw, y, -hd), D = P(-hw, y, -hd);
    var A2 = P(-hw, y + h, hd), B2 = P(hw, y + h, hd), C2 = P(hw, y + h, -hd), D2 = P(-hw, y + h, -hd);

    var faces = [
      { name: 'top', corners: [A2, B2, C2, D2], normal: { x: 0, y: 1, z: 0 }, uv: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      { name: 'front', corners: [A, B, B2, A2], normal: { x: 0, y: 0, z: 1 }, uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
      { name: 'right', corners: [B, C, C2, B2], normal: { x: 1, y: 0, z: 0 }, uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
      { name: 'back', corners: [C, D, D2, C2], normal: { x: 0, y: 0, z: -1 }, uv: [[0, 1], [1, 1], [1, 0], [0, 0]] },
      { name: 'left', corners: [D, A, A2, D2], normal: { x: -1, y: 0, z: 0 }, uv: [[0, 1], [1, 1], [1, 0], [0, 0]] }
    ];

    // Rotate the face normals by yaw as well.
    var i, f;
    for (i = 0; i < faces.length; i++) {
      f = faces[i];
      var n = rotateYaw(f.normal.x, f.normal.z, 0, 0, cos, sin);
      f.normal = { x: n.x, y: f.normal.y, z: n.z };
      var c = { x: 0, y: 0, z: 0 };
      var k;
      for (k = 0; k < 4; k++) { c.x += f.corners[k].x / 4; c.y += f.corners[k].y / 4; c.z += f.corners[k].z / 4; }
      f.centroid = c;
    }
    return faces;
  }

  function signedQuadArea(quad) {
    var area = 0, i, a, b;
    for (i = 0; i < quad.length; i++) {
      a = quad[i];
      b = quad[(i + 1) % quad.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area * 0.5;
  }

  function resolveFacePaint(spec, name) {
    if (spec === null || spec === undefined) { return null; }
    if (typeof spec === 'string') { return { color: spec }; }
    if (typeof spec === 'object') {
      if (spec.image) { return { image: spec.image, fit: spec.fit || 'fill' }; }
      if (spec.color) { return { color: spec.color }; }
      if (spec.fill) { return { color: spec.fill }; }
    }
    return null;
  }

  function shadeColor(hex, factor) {
    if (typeof hex !== 'string') { return hex; }
    var m = hex.trim();
    var r, g, b, a = 1;
    if (m.charAt(0) === '#') {
      var body = m.slice(1);
      if (body.length === 3) {
        r = parseInt(body.charAt(0) + body.charAt(0), 16);
        g = parseInt(body.charAt(1) + body.charAt(1), 16);
        b = parseInt(body.charAt(2) + body.charAt(2), 16);
      } else if (body.length === 6 || body.length === 8) {
        r = parseInt(body.slice(0, 2), 16);
        g = parseInt(body.slice(2, 4), 16);
        b = parseInt(body.slice(4, 6), 16);
        if (body.length === 8) { a = parseInt(body.slice(6, 8), 16) / 255; }
      } else { return hex; }
    } else {
      var rv = m.match(/rgba?\(([^)]+)\)/);
      if (!rv) { return hex; }
      var parts = rv[1].split(',').map(function (p) { return parseFloat(p); });
      r = parts[0]; g = parts[1]; b = parts[2];
      a = parts.length > 3 ? parts[3] : 1;
    }
    r = clamp(Math.round(r * factor), 0, 255);
    g = clamp(Math.round(g * factor), 0, 255);
    b = clamp(Math.round(b * factor), 0, 255);
    if (a < 1) { return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')'; }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function drawSoftShadow(ctx, projector, cx, cz, w, d, yaw, strength) {
    var cos = Math.cos(yaw), sin = Math.sin(yaw);
    var hw = w * 0.62, hd = d * 0.62;
    var segs = 28;
    var i, t, lx, lz, r, p;
    var pts = [];
    var sx = 0, sy = 0;
    for (i = 0; i < segs; i++) {
      t = (i / segs) * Math.PI * 2;
      lx = Math.cos(t) * hw;
      lz = Math.sin(t) * hd;
      r = rotateYaw(cx + lx, cz + lz, cx, cz, cos, sin);
      p = projector.project(r.x, 0.6, r.z);
      pts.push(p);
      sx += p.x / segs;
      sy += p.y / segs;
    }
    // Radius from the projected centroid to the projected rim.
    var radius = 0;
    for (i = 0; i < segs; i++) { radius += dist2(pts[i], { x: sx, y: sy }) / segs; }
    if (!(radius > 0.5)) { return; }

    // Soft shadow via a radial gradient: robust across browsers that do not
    // support ctx.filter (blur), unlike an actual blur pass.
    var alpha = clamp(num(strength, 0.30), 0, 1);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(1, 0.42);
    var grad = ctx.createRadialGradient(0, 0, radius * 0.10, 0, 0, radius);
    grad.addColorStop(0, 'rgba(0, 0, 0, ' + (alpha * 0.95).toFixed(3) + ')');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, ' + (alpha * 0.55).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBox(ctx, projector, opts) {
    var o = opts || {};
    var x = num(o.x, 0);
    var z = num(o.z, 0);
    var y = num(o.y, 0);
    var w = num(o.w, 1);
    var d = num(o.d, 1);
    var h = num(o.h, 1);
    var yaw = num(o.yaw, 0);
    var facesSpec = o.faces || {};
    var shading = o.shading || {};
    var drawShadow = o.shadow !== false;
    var outline = o.outline;

    var result = { topQuad: null, facesDrawn: {}, depth: 0, faces: [] };
    if (!projector || typeof projector.project !== 'function' || w <= 0 || d <= 0 || h <= 0) {
      return result;
    }

    if (drawShadow) {
      drawSoftShadow(ctx, projector, x, z, w, d, yaw, o.shadowStrength);
    }

    var geoms = buildBoxFaces(x, z, y, w, d, h, yaw);
    var list = [];
    var i, f, j, c;
    for (i = 0; i < geoms.length; i++) {
      f = geoms[i];
      var quad = [];
      var depthSum = 0;
      for (j = 0; j < 4; j++) {
        c = f.corners[j];
        var p = projector.project(c.x, c.y, c.z);
        quad.push(p);
        depthSum += projector.viewPoint(c.x, c.y, c.z).depth;
      }
      var area = signedQuadArea(quad);
      if (Math.abs(area) < 0.6) { continue; }              // edge-on / degenerate
      if (area > 0) { continue; }                          // back-facing: hidden by the box itself
      list.push({ name: f.name, quad: quad, uv: f.uv, depth: depthSum / 4 });
    }

    // Painter's algorithm: farthest centroid first, nearest last.
    list.sort(function (a, b) { return b.depth - a.depth; });

    var subdiv = Math.max(1, Math.min(12, Math.round(num(o.textureSubdiv, 4))));

    for (i = 0; i < list.length; i++) {
      var entry = list[i];
      var paint = resolveFacePaint(facesSpec[entry.name], entry.name);
      var fallback = DEFAULT_FACE_COLORS[entry.name] || DEFAULT_FACE_COLORS.top;
      var factor = num(shading[entry.name], DEFAULT_SHADING[entry.name] !== undefined ? DEFAULT_SHADING[entry.name] : 1);
      var opaque = !!paint && (!!paint.color || !!paint.image);

      ctx.save();
      if (paint && paint.image) {
        quadPath(ctx, entry.quad);
        ctx.fillStyle = shadeColor(fallback, factor);
        ctx.fill();
        drawImageInQuad(ctx, paint.image, entry.quad, {
          fit: paint.fit,
          subdiv: subdiv,
          imageRotation: entry.name === 'top' ? num(o.imageRotation, 0) : 0
        });
      } else {
        quadPath(ctx, entry.quad);
        ctx.fillStyle = shadeColor(fallback, factor);
        ctx.fill();
        if (paint && paint.color) {
          ctx.fillStyle = shadeColor(paint.color, factor);
          ctx.fill();
        }
      }

      if (outline) {
        quadPath(ctx, entry.quad);
        ctx.lineWidth = typeof outline === 'number' ? outline : 1;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = typeof outline === 'string' ? outline : 'rgba(35, 30, 24, 0.55)';
        ctx.stroke();
      }
      ctx.restore();

      result.facesDrawn[entry.name] = true;
      result.depth += entry.depth;
      result.faces.push({ name: entry.name, quad: entry.quad, depth: entry.depth, opaque: opaque });
    }

    var top = null;
    for (i = 0; i < result.faces.length; i++) {
      if (result.faces[i].name === 'top') { top = result.faces[i]; break; }
    }
    if (top) { result.topQuad = top.quad; result.depth = top.depth; }
    else if (result.faces.length) { result.depth = result.faces[0].depth; }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Enhanced 2D fallback tile (used by the main renderer in flat mode)
   * ------------------------------------------------------------------ */

  function roundedRectPath(ctx, x, y, w, h, r) {
    var rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function resolveSource(src, opts) {
    if (!src) {
      var url = getFaceUrl(opts.tileStr, opts.redDora, opts.faceDown);
      return getImage(url);
    }
    if (typeof src === 'string') { return getImage(src); }
    return src;
  }

  function drawFlatTile(ctx, opts) {
    var o = opts || {};
    var x = num(o.x, 0), y = num(o.y, 0);
    var w = num(o.w, 40), h = num(o.h, 54);
    var rot = num(o.rotation, 0);
    var selected = !!o.selected, highlighted = !!o.highlighted;
    var radius = num(o.radius, Math.max(3, Math.round(Math.min(w, h) * 0.12)));
    var img = resolveSource(o.source, o);

    var cx = x + w / 2, cy = y + h / 2;
    var lift = num(o.lift, 0);

    ctx.save();
    ctx.translate(cx, cy - lift);
    ctx.rotate(rot);
    if (o.alpha !== undefined) { ctx.globalAlpha = num(o.alpha, 1); }

    // Contact shadow.
    if (o.shadow !== false) {
      ctx.save();
      ctx.globalAlpha *= 0.28;
      ctx.fillStyle = '#000';
      roundedRectPath(ctx, -w / 2 + 1, -h / 2 + 4, w, h, radius);
      ctx.fill();
      ctx.globalAlpha = o.alpha === undefined ? 1 : num(o.alpha, 1);
      ctx.restore();
    }

    // Extruded bottom edge for a subtle 3D feel.
    var edge = num(o.edge, Math.max(2, Math.round(h * 0.06)));
    if (edge > 0) {
      ctx.fillStyle = 'rgba(150, 138, 118, 0.95)';
      roundedRectPath(ctx, -w / 2, -h / 2 + edge, w, h, radius);
      ctx.fill();
    }

    // Ivory body.
    ctx.fillStyle = '#f7f3ea';
    ctx.strokeStyle = 'rgba(178, 165, 143, 0.9)';
    ctx.lineWidth = 1;
    roundedRectPath(ctx, -w / 2, -h / 2, w, h, radius);
    ctx.fill();
    ctx.stroke();

    if (img) {
      ctx.save();
      roundedRectPath(ctx, -w / 2, -h / 2, w, h, radius);
      ctx.clip();
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else if (o.fallbackText && !o.faceDown) {
      ctx.fillStyle = '#a33b30';
      ctx.font = '700 ' + Math.round(h * 0.4) + 'px "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.fallbackText, 0, 1);
    }

    if (selected || highlighted) {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      ctx.fillStyle = selected ? '#ffcd5a' : '#78d2ff';
      roundedRectPath(ctx, -w / 2 - 4, -h / 2 - 4, w + 8, h + 8, radius + 4);
      ctx.fill();
      ctx.globalAlpha *= 2;
      ctx.fillStyle = selected ? 'rgba(255, 205, 90, 0.35)' : 'rgba(120, 210, 255, 0.28)';
      roundedRectPath(ctx, -w / 2 - 2, -h / 2 - 2, w + 4, h + 4, radius + 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = selected ? '#f6c552' : '#8ed2ff';
      ctx.lineWidth = 2;
      roundedRectPath(ctx, -w / 2 - 1.5, -h / 2 - 1.5, w + 3, h + 3, radius + 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * Convenience helper: build a `faces` object from one bitmap
   * ------------------------------------------------------------------ */

  function tileFaces(source, opts) {
    var o = opts || {};
    var top = source ? { image: source, fit: o.fit || 'fill' } : (o.top || null);
    return {
      top: top,
      front: o.front || '#e7dfd1',
      right: o.right || '#c9bfad',
      back: o.back || '#b6ac9b',
      left: o.left || '#d6cec0'
    };
  }

  return {
    VERSION: VERSION,
    TILE_ASSET_ROOT: TILE_ASSET_ROOT,
    TILE_ASSET_MAP: TILE_ASSET_MAP,
    PRESETS: PRESETS,
    CAMERA_DEFAULTS: CAMERA_DEFAULTS,
    DEFAULT_FACE_COLORS: DEFAULT_FACE_COLORS,
    DEFAULT_SHADING: DEFAULT_SHADING,
    createCamera: createCamera,
    drawBox: drawBox,
    quadPath: quadPath,
    pointInQuad: pointInQuad,
    quadArea: quadArea,
    signedQuadArea: signedQuadArea,
    drawFlatTile: drawFlatTile,
    drawImageInQuad: drawImageInQuad,
    loadTileAssets: loadTileAssets,
    getFaceUrl: getFaceUrl,
    getImage: getImage,
    tileFaces: tileFaces,
    assets: assets
  };
});
