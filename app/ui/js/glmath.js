'use strict';
/**
 * glmath.js — 最小矩阵 / 球面数学
 * 只保留本项目需要的：透视投影、lookAt、经纬度↔三维、屏幕投影、地平线判定。
 */
(function (root) {
  const G = {};
  const DEG = Math.PI / 180;
  G.DEG = DEG;

  G.perspective = (fovyRad, aspect, near, far) => {
    const f = 1 / Math.tan(fovyRad / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  };

  G.lookAt = (eye, center, up) => {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;

    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;

    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ]);
  };

  G.multiply = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  };

  G.latLonToXYZ = (lat, lon, r) => {
    const phi = lat * DEG, theta = lon * DEG, c = Math.cos(phi);
    return [r * c * Math.sin(theta), r * Math.sin(phi), r * c * Math.cos(theta)];
  };

  /** 世界坐标 → 屏幕像素；depth<=0 表示在相机背后 */
  G.project = (vp, p, w, h) => {
    const x = p[0], y = p[1], z = p[2];
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 1e-6) return null;
    const nx = cx / cw, ny = cy / cw;
    if (nx < -1.8 || nx > 1.8 || ny < -1.8 || ny > 1.8) return null;
    return {
      x: (nx * 0.5 + 0.5) * w,
      y: (1 - (ny * 0.5 + 0.5)) * h,
      depth: cw,
      z: cz / cw,          // NDC 深度：交给 GPU 做遮挡，球背面会被地球挡住
    };
  };

  /**
   * 地平线剔除：相机在球外时，球背面的点不可见。
   * 若相机在球内（近地视角）则一律可见。
   */
  G.isVisible = (cam, p, radius) => {
    const camLen = Math.hypot(cam[0], cam[1], cam[2]);
    if (camLen <= radius * 1.002) return true;
    const dot = (cam[0] * p[0] + cam[1] * p[1] + cam[2] * p[2]) / (camLen * radius);
    const cosHorizon = Math.sqrt(Math.max(0, 1 - (radius / camLen) ** 2));
    return dot >= cosHorizon * 0.999;
  };

  root.GLMath = G;
})(window);
