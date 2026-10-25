'use strict';
/**
 * globe.js — 轻量 WebGL 地球渲染器（替代 Cesium，约 20 KB）
 *
 * 只做两件事：画贴图球 + 画飞机精灵。
 * 飞机按「是否在地球背面」逐帧剔除，所以球背面的目标不会出现在画面上。
 */
(function (root) {
  const G = window.GLMath;
  const M = {};

  const VS_SPHERE = `
    attribute vec3 aPos; attribute vec3 aNor; attribute vec2 aUV;
    uniform mat4 uVP;
    varying vec2 vUV; varying vec3 vN; varying vec3 vP;
    void main(){ vUV=aUV; vN=aNor; vP=aPos; gl_Position=uVP*vec4(aPos,1.0); }`;

  const FS_SPHERE = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec3 uCam;
    varying vec2 vUV; varying vec3 vN; varying vec3 vP;
    void main(){
      vec3 c = texture2D(uTex, vUV).rgb;
      // 很轻的明暗，保证地图可读
      vec3 sun = normalize(vec3(0.5,0.42,0.76));
      float ndl = max(0.0, dot(normalize(vN), sun));
      c *= 0.78 + 0.30 * ndl;
      // 边缘淡淡的青色大气
      vec3 V = normalize(uCam - vP);
      float f = pow(1.0 - max(0.0, dot(V, normalize(vN))), 4.0);
      c += vec3(0.04,0.16,0.28) * f;
      gl_FragColor = vec4(c,1.0);
    }`;

  const VS_ATMOS = `
    attribute vec3 aPos; uniform mat4 uVP;
    varying vec3 vP;
    void main(){ vP=aPos; gl_Position=uVP*vec4(aPos,1.0); }`;

  const FS_ATMOS = `
    precision mediump float;
    uniform vec3 uCam;
    varying vec3 vP;
    void main(){
      vec3 V = normalize(uCam - vP);
      float rim = pow(1.0 - max(0.0, dot(V, normalize(vP))), 3.0);
      gl_FragColor = vec4(0.28,0.70,1.0, rim*0.45);
    }`;

  const VS_SPRITE = `
    attribute vec2 aCorner; attribute vec2 aCenter; attribute vec2 aSize;
    attribute float aRot; attribute float aAlpha; attribute vec4 aColor;
    attribute vec2 aUV;
    uniform vec2 uVP;
    varying vec2 vUV; varying vec4 vColor;
    void main(){
      float c=cos(aRot), s=sin(aRot);
      vec2 p=aCorner*aSize;
      vec2 r=vec2(p.x*c-p.y*s, p.x*s+p.y*c);
      vec2 px=aCenter+r;
      gl_Position=vec4(px.x/uVP.x*2.0-1.0, 1.0-px.y/uVP.y*2.0, 0.0, 1.0);
      vUV=aUV; vColor=vec4(aColor.rgb, aColor.a*aAlpha);
    }`;

  const FS_SPRITE = `
    precision mediump float;
    uniform sampler2D uAtlas;
    varying vec2 vUV; varying vec4 vColor;
    void main(){
      vec4 t = texture2D(uAtlas, vUV);
      if (t.a < 0.04) discard;
      gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
    }`;

  function buildSphere(latSeg, lonSeg) {
    const pos = [], nor = [], uv = [], idx = [];
    for (let i = 0; i <= latSeg; i++) {
      const v = i / latSeg;
      const phi = (v - 0.5) * Math.PI;
      for (let j = 0; j <= lonSeg; j++) {
        const u = j / lonSeg;
        const th = (u - 0.5) * Math.PI * 2;
        const x = Math.cos(phi) * Math.sin(th);
        const y = Math.sin(phi);
        const z = Math.cos(phi) * Math.cos(th);
        pos.push(x, y, z); nor.push(x, y, z); uv.push(u, v);
      }
    }
    for (let i = 0; i < latSeg; i++) {
      for (let j = 0; j < lonSeg; j++) {
        const a = i * (lonSeg + 1) + j, b = a + lonSeg + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return {
      pos: new Float32Array(pos), nor: new Float32Array(nor),
      uv: new Float32Array(uv), idx: new Uint16Array(idx), count: idx.length,
    };
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vs, fs, attrs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    const a = {}, u = {};
    for (const k of attrs) a[k] = gl.getAttribLocation(p, k);
    for (const k of ['uVP', 'uCam', 'uTex', 'uAtlas']) u[k] = gl.getUniformLocation(p, k);
    return { p, a, u };
  }

  // 每顶点: corner2 center2 size2 rot1 alpha1 color4 uv2 = 14 floats
  const V_FLOATS = 14;
  const MAX_SPRITES = 3000;

  M.create = function (canvas, opts) {
    opts = opts || {};
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL 不可用');

    const sphere = buildSphere(64, 128);
    const P = {
      sphere: program(gl, VS_SPHERE, FS_SPHERE, ['aPos', 'aNor', 'aUV']),
      atmos: program(gl, VS_ATMOS, FS_ATMOS, ['aPos']),
      sprite: program(gl, VS_SPRITE, FS_SPRITE,
        ['aCorner', 'aCenter', 'aSize', 'aRot', 'aAlpha', 'aColor', 'aUV']),
    };

    const bPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferData(gl.ARRAY_BUFFER, sphere.pos, gl.STATIC_DRAW);
    const bNor = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bNor); gl.bufferData(gl.ARRAY_BUFFER, sphere.nor, gl.STATIC_DRAW);
    const bUV = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bUV); gl.bufferData(gl.ARRAY_BUFFER, sphere.uv, gl.STATIC_DRAW);
    const bIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.idx, gl.STATIC_DRAW);

    const R = 1.045;
    const atmos = new Float32Array(sphere.pos.length);
    for (let i = 0; i < sphere.pos.length; i++) atmos[i] = sphere.pos[i] * R;
    const bAtmos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bAtmos); gl.bufferData(gl.ARRAY_BUFFER, atmos, gl.STATIC_DRAW);

    const spriteData = new Float32Array(MAX_SPRITES * 4 * V_FLOATS);
    const bSprite = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bSprite);
    gl.bufferData(gl.ARRAY_BUFFER, spriteData.byteLength, gl.DYNAMIC_DRAW);

    function tex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    }
    const texEarth = tex(), texAtlas = tex();

    const isPOT = (n) => (n & (n - 1)) === 0;
    let earthReady = false;
    function load(url, t, flipY, onDone) {
      const img = new Image();
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!flipY);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        if (isPOT(img.width) && isPOT(img.height)) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (onDone) onDone();
      };
      img.onerror = () => console.error('[globe] 贴图加载失败', url);
      img.src = url;
    }
    // 地球贴图：图像第 0 行是北极，球体 v=0 在南极 → 翻转 Y
    load('tex/earth.jpg', texEarth, true, () => { earthReady = true; });
    load('tex/atlas.png', texAtlas, true);

    return {
      gl, canvas, P,
      bPos, bNor, bUV, bIdx, bAtmos, bSprite,
      sphereCount: sphere.count, spriteData,
      texEarth, texAtlas,
      lat: opts.lat || 30, lon: opts.lon || 120,
      dist: opts.dist || 2.6,
      targetDist: opts.dist || 2.6,
      targetLat: opts.lat || 30, targetLon: opts.lon || 120,
      spin: opts.spin === true,
      drag: false,
      isReady: () => earthReady,
    };
  };

  M.camera = function (s) {
    const eye = G.latLonToXYZ(s.lat, s.lon, s.dist);
    const view = G.lookAt(eye, [0, 0, 0], [0, 1, 0]);
    const aspect = s.canvas.width / Math.max(1, s.canvas.height);
    const proj = G.perspective((34 * Math.PI) / 180, aspect, 0.02, 200);
    return { eye, vp: G.multiply(proj, view) };
  };

  M.draw = function (s, sprites) {
    const gl = s.gl, w = s.canvas.width, h = s.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.004, 0.008, 0.016, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cam = M.camera(s);

    // 地球
    const SP = s.P.sphere;
    gl.useProgram(SP.p);
    gl.uniformMatrix4fv(SP.u.uVP, false, cam.vp);
    gl.uniform3fv(SP.u.uCam, new Float32Array(cam.eye));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.texEarth);
    gl.uniform1i(SP.u.uTex, 0);

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.bindBuffer(gl.ARRAY_BUFFER, s.bPos);
    gl.enableVertexAttribArray(SP.a.aPos);
    gl.vertexAttribPointer(SP.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.bNor);
    gl.enableVertexAttribArray(SP.a.aNor);
    gl.vertexAttribPointer(SP.a.aNor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.bUV);
    gl.enableVertexAttribArray(SP.a.aUV);
    gl.vertexAttribPointer(SP.a.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.bIdx);
    gl.drawElements(gl.TRIANGLES, s.sphereCount, gl.UNSIGNED_SHORT, 0);

    // 大气：只画背面，形成外圈光
    const AP = s.P.atmos;
    gl.useProgram(AP.p);
    gl.uniformMatrix4fv(AP.u.uVP, false, cam.vp);
    gl.uniform3fv(AP.u.uCam, new Float32Array(cam.eye));
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.bAtmos);
    gl.enableVertexAttribArray(AP.a.aPos);
    gl.vertexAttribPointer(AP.a.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.bIdx);
    gl.drawElements(gl.TRIANGLES, s.sphereCount, gl.UNSIGNED_SHORT, 0);
    gl.depthMask(true); gl.disable(gl.CULL_FACE);

    // 飞机精灵
    const list = sprites || [];
    if (list.length) {
      const n = Math.min(list.length, MAX_SPRITES);
      const arr = s.spriteData;
      let o = 0;
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      const uvs = [[0, 1], [1, 1], [0, 0], [1, 0]];
      for (let i = 0; i < n; i++) {
        const sp = list[i], col = sp.color;
        for (let c = 0; c < 4; c++) {
          arr[o++] = corners[c][0]; arr[o++] = corners[c][1];
          arr[o++] = sp.x; arr[o++] = sp.y;
          arr[o++] = sp.size; arr[o++] = sp.size;
          arr[o++] = sp.rot || 0;
          arr[o++] = sp.alpha == null ? 1 : sp.alpha;
          arr[o++] = col[0]; arr[o++] = col[1]; arr[o++] = col[2]; arr[o++] = 1;
          arr[o++] = uvs[c][0] * sp.uw + sp.ux;
          arr[o++] = uvs[c][1] * sp.uh + sp.uy;
        }
      }
      const GP = s.P.sprite;
      gl.useProgram(GP.p);
      gl.uniform2f(GP.u.uVP, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.texAtlas);
      gl.uniform1i(GP.u.uAtlas, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, s.bSprite);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr.subarray(0, o));
      const stride = V_FLOATS * 4;
      const bind = (loc, size, off) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      };
      bind(GP.a.aCorner, 2, 0);
      bind(GP.a.aCenter, 2, 8);
      bind(GP.a.aSize, 2, 16);
      bind(GP.a.aRot, 1, 24);
      bind(GP.a.aAlpha, 1, 28);
      bind(GP.a.aColor, 4, 32);
      bind(GP.a.aUV, 2, 48);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, n * 4);
      gl.enable(gl.DEPTH_TEST);
    }
    return cam;
  };

  root.Globe = M;
})(window);
