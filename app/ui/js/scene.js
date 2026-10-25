'use strict';
/**
 * 三维地球：Cesium 场景、卫星影像、飞机图元与交互
 *
 * 关于「飞机穿透地球、看到背面目标」的修复：
 *   1. 关键：绝不能给 billboard / point 设 disableDepthTestDistance: Infinity。
 *      那等于强制关闭深度测试，地球背面的飞机会被画在球面上。
 *      这里用 0（默认），让 GPU 正常做深度测试 —— 被地球挡住的自然不显示。
 *   2. 双保险：每帧用 EllipsoidalOccluder 做视锥/地平线剔除，
 *      把位于地球背面（相对相机在视线之外）的飞机直接隐藏，
 *      既省渲染、又避免地球边缘的深度精度问题造成的漏画。
 *   3. 不要用 distanceDisplayCondition 的下界去“猜”远近，那是距离不是遮挡，
 *      球背面的飞机距离相机可能比正面的还近，猜不出来。
 */
(function () {
  const FR = (window.FR = window.FR || {});
  const U = FR.util;
  const C = window.Cesium;

  const VIEW_PRESETS = {
    world: { lon: 20, lat: 18, height: 33000000 },
    europe: { lon: 9, lat: 50, height: 5200000 },
    asia: { lon: 116, lat: 32, height: 6200000 },
    namerica: { lon: -98, lat: 40, height: 7000000 },
    samerica: { lon: -60, lat: -18, height: 7400000 },
    africa: { lon: 20, lat: 3, height: 7400000 },
    oceania: { lon: 140, lat: -25, height: 7600000 },
    mideast: { lon: 48, lat: 27, height: 5200000 },
  };

  const IMAGERY = {
    satellite:
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // Esri 暗灰画布（CARTO 的公开瓦片已加 "API KEY REQUIRED" 水印）
    dark: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    reference:
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  };

  const SKYBOX_DIR = 'app://local/cesium/Assets/Textures/SkyBox/tycho2t3_80_';
  const ICON_DIR = 'assets/planes/';

  /* ---------------- 机型分类 ----------------
   * 把 ADS-B 的机型代码映射到 10 个图标类别，用真实尺寸决定图标大小与比例。
   */
  const TYPE_TABLE = [
    // 四发巨型（A380 / A340 / C-5 / An-124）—— 注意别把 B74x 也吞进来，B747 有自己的图标
    { cls: 'a380', re: /^(A38[0-9]|A3ST|A34[0-9]|C5M?|AN22|AN124)$/ },
    { cls: 'b747', re: /^(B74[0-9]|B74R|B74S)$/ },
    // 宽体双发（A330 单独成类，故此处不再包含 A33x）
    { cls: 'widebody', re: /^(B77[0-9]|B778|B779|B78[0-9]|A35[0-9]|A350|B76[0-9]|IL96|A30[0-9]|A310)$/ },
    { cls: 'a330', re: /^(A33[0-9]|A332|A333|A338|A339)$/ },
    // 窄体干线
    { cls: 'narrowbody', re: /^(A31[0-9]|A32[0-9]|A19N|A20N|A21N|B73[0-9]|B75[0-9]|MD8[0-9]|MD9[0-9]|B71[0-9]|CS3[0-9]|BCS[123])$/ },
    // 支线喷气 / 公务机
    { cls: 'regional', re: /^(CRJ[0-9]|CRJ9|E1[0-9][0-9]|E2[0-9][0-9]|EMB[0-9]|ERJ[0-9]|GLF[0-9]|G[0-9]|C25[0-9]|C5[0-9][0-9]|C68[0-9]|C75[0-9]|F2TH|E55P|E50P|HDJT|PC24|LJ[0-9]|FA[0-9]|BE40|BE20|BE30|H25[0-9]|SBR1|WW24|CL3[0-9]|CL6[0-9])$/ },
    // 涡桨
    { cls: 'turboprop', re: /^(AT[47][0-9]|DH8[0-9]|DHC[0-9]|Q40[0-9]|SF34|SB20|J328|B190|C208|PC12|TBM[0-9]|BE99|BE9L|BE10|MET[0-9]|AC6[0-9]|C441)$/ },
    // 直升机
    { cls: 'heli', re: /^(H[0-9]{3}|EC[0-9]{2}|AS[0-9]{2}|A[0-9]{3}|R[0-9]{2}|B[0-9]{3}|S[0-9]{2}|AW[0-9]{3}|UH[0-9]{2}|CH[0-9]{2}|MD[0-9]{2}|LYNX|PUMA)$/ },
    // 战斗机
    { cls: 'fighter', re: /^(F1[0-9]|F2[0-9]|F3[0-9]|F4|F5|F8|FA18|EA18|RF4|MIG[0-9]|SU[0-9]|JAS3[0-9]|T38|A4|A10|AV8B|HAR|TEX2|HAWK)$/ },
  ];

  /** 大类兜底判断：用 category / 描述 */
  const CATEGORY_HINT = {
    A1: 'light',
    A2: 'light',
    A3: 'narrowbody',
    A4: 'widebody',
    A5: 'widebody',
    A6: 'fighter',
    A7: 'heli',
  };

  function classify(plane) {
    const t = (plane.type || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (t) {
      for (const row of TYPE_TABLE) {
        if (row.re.test(t)) return row.cls;
      }
    }
    // 用描述文本兜底
    const d = (plane.desc || '').toUpperCase();
    if (d) {
      if (/HELICOPTER|ROTORCRAFT/.test(d)) return 'heli';
      if (/BOEING 747/.test(d)) return 'b747';
      if (/AIRBUS A380/.test(d)) return 'a380';
      if (/AIRBUS A330/.test(d)) return 'a330';
      if (/BOEING 7[67]|AIRBUS A3[35]|BOEING 78/.test(d)) return 'widebody';
      if (/BOEING 7[34]|AIRBUS A32|AIRBUS A31|AIRBUS A20|AIRBUS A21/.test(d)) return 'narrowbody';
      if (/ATR|DASH|TURBOPROP/.test(d)) return 'turboprop';
      if (/FIGHTER|F-\d/.test(d)) return 'fighter';
      if (/CESSNA 1[0-9]|CIRRUS|PIPER/.test(d)) return 'light';
      if (/CESSNA|BEECHCRAFT|DIAMOND/.test(d)) return 'light';
      if (/GULFSTREAM|BOMBARDIER|LEARJET|EMBRAER|CESSNA CITATION/.test(d)) return 'regional';
    }
    if (plane.category && CATEGORY_HINT[plane.category]) return CATEGORY_HINT[plane.category];
    // 无信息时按窄体画，避免出现巨大的四发图标
    return 'narrowbody';
  }

  /* ---------------- 状态 ---------------- */
  const state = {
    viewer: null,
    scene: null,
    billboards: null,
    points: null,
    labels: null,
    selectedHex: null,
    followHex: null,
    showLabels: true,
    showPoints: true,
    basemap: 'satellite',
    satelliteLayer: null,
    darkLayer: null,
    referenceLayer: null,
    referenceWanted: true,
    occluder: null,
    lastUpdateMs: 0,
  };

  /** hex -> {plane, bb, pt, label, hidden} */
  const planeIndex = new Map();
  let selectListener = null;
  let followListener = null;

  /* ---------------- 初始化 ---------------- */
  async function init() {
    if (!C) throw new Error('Cesium 未加载');

    const viewer = new C.Viewer('cesiumContainer', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      creditContainer: document.createElement('div'),
      terrainProvider: new C.EllipsoidTerrainProvider(),
      skyBox: new C.SkyBox({
        sources: {
          positiveX: SKYBOX_DIR + 'px.jpg',
          negativeX: SKYBOX_DIR + 'mx.jpg',
          positiveY: SKYBOX_DIR + 'py.jpg',
          negativeY: SKYBOX_DIR + 'my.jpg',
          positiveZ: SKYBOX_DIR + 'pz.jpg',
          negativeZ: SKYBOX_DIR + 'mz.jpg',
        },
      }),
    });

    const scene = viewer.scene;
    state.viewer = viewer;
    state.scene = scene;

    scene.globe.enableLighting = false;
    scene.globe.baseColor = new C.Color(0.012, 0.03, 0.055, 1);
    scene.globe.showGroundAtmosphere = true;
    scene.globe.depthTestAgainstTerrain = false;
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.hueShift = -0.1;
    scene.skyAtmosphere.saturationShift = 0.2;
    scene.backgroundColor = new C.Color(0.004, 0.008, 0.016, 1);
    scene.fog.enabled = false;
    scene.highDynamicRange = false;
    scene.postProcessStages.fxaa.enabled = true;
    scene.screenSpaceCameraController.minimumZoomDistance = 260;
    scene.screenSpaceCameraController.maximumZoomDistance = 62000000;
    scene.screenSpaceCameraController.inertiaSpin = 0.84;
    scene.screenSpaceCameraController.inertiaZoom = 0.72;

    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(VIEW_PRESETS.world.lon, VIEW_PRESETS.world.lat, VIEW_PRESETS.world.height),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });

    /* 影像层：三个都显式持有引用，避免依赖 add 顺序 */
    state.satelliteLayer = viewer.imageryLayers.addImageryProvider(
      makeProvider(IMAGERY.satellite, 19, 'Esri World Imagery')
    );
    state.darkLayer = viewer.imageryLayers.addImageryProvider(
      makeProvider(IMAGERY.dark, 16, 'Esri 暗灰画布')
    );
    state.darkLayer.show = false;
    state.darkLayer.brightness = 0.34;
    state.darkLayer.contrast = 1.45;
    state.darkLayer.saturation = 0.35;

    state.referenceLayer = viewer.imageryLayers.addImageryProvider(
      makeProvider(IMAGERY.reference, 11, 'Esri 地名与边界')
    );
    state.referenceLayer.alpha = 0.42;

    /* 图元：轨迹线在飞机之下 */
    state.trails = scene.primitives.add(new C.PolylineCollection());
    state.billboards = scene.primitives.add(new C.BillboardCollection({ scene }));
    state.points = scene.primitives.add(new C.PointPrimitiveCollection({ scene }));
    state.labels = scene.primitives.add(
      new C.LabelCollection({ scene, scaleByDistance: new C.NearFarScalar(1.4e6, 1, 5e6, 0) })
    );

    /* 地平线剔除器：每帧更新相机位置 */
    state.occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, viewer.camera.positionWC);

    bindInteractions(viewer);
    return viewer;
  }

  function makeProvider(url, maximumLevel, credit) {
    return new C.UrlTemplateImageryProvider({
      url,
      maximumLevel,
      minimumLevel: 0,
      credit: new C.Credit(credit),
    });
  }

  /* ---------------- 相机 ---------------- */
  function flyTo(preset) {
    const p = typeof preset === 'string' ? VIEW_PRESETS[preset] : preset;
    if (!p) return;
    unfollow();
    state.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    state.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      duration: 1.5,
      easingFunction: C.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  function flyToPlane(plane, height) {
    if (!plane) return;
    state.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    const h = height || 420000;
    state.viewer.camera.flyTo({
      destination: C.Cartesian3.fromDegrees(plane.lon, plane.lat, h),
      orientation: {
        heading: C.Math.toRadians(plane.track || 0),
        pitch: C.Math.toRadians(-55),
        roll: 0,
      },
      duration: 1.6,
      easingFunction: C.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  function follow(hex) {
    if (!hex) return false;
    state.followHex = hex;
    const entry = planeIndex.get(hex);
    if (entry) flyToPlane(entry.plane, 380000);
    if (followListener) followListener(hex);
    return true;
  }

  function unfollow() {
    if (state.followHex) {
      state.followHex = null;
      // 解除跟随：把相机从局部 ENU 坐标系还原到世界坐标系（位置保持连续）
      if (state.viewer) state.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
      if (followListener) followListener(null);
    }
  }

  function onFollowChange(fn) {
    followListener = fn;
  }

  function currentRect() {
    if (!state.viewer) return null;
    const rect = state.viewer.camera.computeViewRectangle(state.scene.globe.ellipsoid);
    if (!rect) return { west: -Math.PI, south: -Math.PI / 2, east: Math.PI, north: Math.PI / 2 };
    return rect;
  }

  /* ---------------- 图元同步 ---------------- */
  function altitudeOf(plane) {
    return plane.alt === 'ground' ? 0 : Number(plane.alt) || 0;
  }

  function iconFor(cls, hex) {
    return ICON_DIR + cls + (hex && hex === state.selectedHex ? '-sel' : '') + '.png';
  }

  /** 按定位时刻把飞机外推到 t（毫秒），返回 {lat, lon, altM} */
  function extrapolate(p, t) {
    const toRad = Math.PI / 180;
    const dtMs = Math.min(MAX_EXTRAP_MS, Math.max(0, t - (p.posTime || p.updatedAt)));
    let lat = p.lat;
    let lon = p.lon;
    let altM = Math.max(0, altitudeOf(p) * FR.const.FT_TO_M);
    if (p.gs && p.track !== null && p.gs > 5 && dtMs > 0) {
      const distM = p.gs * FR.const.KT_TO_MS * (dtMs / 1000);
      const rad = p.track * toRad;
      const cosLat = Math.max(0.15, Math.cos(p.lat * toRad));
      lat = p.lat + (distM * Math.cos(rad)) / 111320;
      lon = U.wrapLon(p.lon + (distM * Math.sin(rad)) / (111320 * cosLat));
    }
    if (p.vs && dtMs > 0) altM = Math.max(0, altM + p.vs * 0.00508 * (dtMs / 1000));
    return { lat, lon, altM };
  }

  const MAX_EXTRAP_MS = 60000;
  /** 显示位置向目标收敛的时间常数（秒） */
  const SMOOTH_TAU = 1.2;
  /** 偏差超过这个距离（米）直接跳到目标（如重新出现 / 数据大跳） */
  const SNAP_M = 30000;

  /**
   * 增量同步：已存在的飞机复用图元，只更新数据；
   * 不再每轮 removeAll 重建（旧版重建会把显示位置重置到旧的定位点 → 飞机“回到之前的位置”）。
   */
  function sync(planes) {
    if (!state.viewer) return;

    const camHeight = state.viewer.camera.positionCartographic.height;
    const labelBudget = camHeight > 9e6 ? 0 : camHeight > 3.5e6 ? 260 : 1400;
    const showLabels = state.showLabels && labelBudget > 0;

    let labelCount = 0;
    let rendered = 0;
    const now = Date.now();
    const alive = new Set();

    for (const plane of planes) {
      alive.add(plane.hex);
      const cls = classify(plane);
      const color = C.Color.fromCssColorString(U.altitudeColor(plane.alt));
      const isGround = plane.alt === 'ground';
      const rotation = plane.track ? -C.Math.toRadians(plane.track) : 0;
      const scale = plane.isMil ? 0.30 : isGround ? 0.20 : 0.26;

      let entry = planeIndex.get(plane.hex);
      if (!entry) {
        const e = extrapolate(plane, now);
        const pos = C.Cartesian3.fromDegrees(e.lon, e.lat, e.altM);
        const bb = state.billboards.add({
          position: pos,
          image: iconFor(cls, plane.hex),
          // FR24 风格：图标本身就是黄色，不再按高度染色
          color: C.Color.WHITE,
          // 关键：不设 disableDepthTestDistance，让 GPU 正常做深度测试
          rotation,
          alignedAxis: C.Cartesian3.ZERO,
          scale,
          scaleByDistance: new C.NearFarScalar(1.5e5, 1.8, 1.2e7, 0.30),
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, 3.4e7),
          id: { _frHex: plane.hex },
        });
        const pt = state.points.add({
          position: pos,
          pixelSize: isGround ? 1.5 : 2,
          color: color.withAlpha(0.62),
          distanceDisplayCondition: new C.DistanceDisplayCondition(9e6, 3.2e7),
          id: { _frHex: plane.hex },
        });
        entry = { plane, bb, pt, label: null, cls, pos, hidden: false, disp: e, lastFrame: now };
        planeIndex.set(plane.hex, entry);
      } else {
        entry.plane = plane;
        if (entry.cls !== cls) entry.cls = cls;
        entry.bb.image = iconFor(cls, plane.hex);
        entry.bb.rotation = rotation;
        entry.bb.scale = scale;
        entry.pt.color = color.withAlpha(0.62);
      }

      const wantLabel = showLabels && labelCount < labelBudget;
      if (wantLabel) {
        const text = isGround ? plane.callsign : plane.callsign + '  ' + U.fmtAltShort(plane.alt);
        if (!entry.label) {
          entry.label = state.labels.add({
            position: entry.pos,
            text,
            font: '500 11px "SF Mono", Menlo, Consolas, monospace',
            fillColor: C.Color.WHITE,
            outlineColor: C.Color.fromCssColorString('rgba(3,8,16,0.92)'),
            outlineWidth: 3,
            style: C.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: C.VerticalOrigin.BOTTOM,
            pixelOffset: new C.Cartesian2(0, -15),
            distanceDisplayCondition: new C.DistanceDisplayCondition(0, 9e5),
            showBackground: true,
            backgroundColor: C.Color.fromCssColorString('rgba(5,12,20,0.62)'),
            backgroundPadding: new C.Cartesian2(6, 3),
            id: { _frHex: plane.hex },
          });
        } else if (entry.label.text !== text) {
          entry.label.text = text;
        }
        entry.label.fillColor = C.Color.fromCssColorString(
          plane.emergency && plane.emergency !== 'none' ? '#ff8b96' : '#dcf3ff'
        );
        entry.label.show = !entry.hidden;
        labelCount += 1;
      } else if (entry.label) {
        state.labels.remove(entry.label);
        entry.label = null;
      }
      rendered += 1;
    }

    // 移除已消失的飞机
    for (const [hex, entry] of planeIndex) {
      if (alive.has(hex)) continue;
      state.billboards.remove(entry.bb);
      state.points.remove(entry.pt);
      if (entry.label) state.labels.remove(entry.label);
      planeIndex.delete(hex);
    }

    FR.state.renderedCount = rendered;
    FR.state.labelCount = labelCount;
    state.lastUpdateMs = Date.now();
  }

  /** 选中态切换时只换图标（红色 = 选中） */
  function refreshSelectionIcons(prev, next) {
    for (const hex of [prev, next]) {
      const e = hex && planeIndex.get(hex);
      if (e) e.bb.image = iconFor(e.cls, hex);
    }
  }

  /* ---------------- 地平线剔除 + 平滑外推（只前进，不回退） ---------------- */
  let hiddenCount = 0;

  function animate() {
    if (!state.viewer) return;
    const now = Date.now();
    const toRad = Math.PI / 180;

    // 更新遮挡器（相机每帧可能移动）
    state.occluder.cameraPosition = state.viewer.camera.positionWC;

    hiddenCount = 0;

    for (const entry of planeIndex.values()) {
      const p = entry.plane;
      const target = extrapolate(p, now);
      const d = entry.disp;
      const dt = Math.max(0, Math.min(1, (now - entry.lastFrame) / 1000));
      entry.lastFrame = now;

      // 先按真实地速沿航向推进显示位置（与外推同速，不滞后）
      if (p.gs && p.track !== null && p.gs > 5 && dt > 0) {
        const step = p.gs * FR.const.KT_TO_MS * dt;
        const r = p.track * toRad;
        d.lat += (step * Math.cos(r)) / 111320;
        d.lon = U.wrapLon(d.lon + (step * Math.sin(r)) / (111320 * Math.max(0.15, Math.cos(d.lat * toRad))));
      }

      // 显示位置 → 目标 的偏移（米，局部平面近似）
      const cosLat = Math.max(0.15, Math.cos(d.lat * toRad));
      let dLon = target.lon - d.lon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      const north = (target.lat - d.lat) * 111320;
      const east = dLon * 111320 * cosLat;
      const dist = Math.hypot(north, east);

      if (dist > SNAP_M) {
        entry.disp = target;
      } else if (dist > 0.01) {
        // 沿航向的分量：目标在显示位置“后面”时不往回走，只等目标追上来
        let along = 0;
        if (p.track !== null && p.gs && p.gs > 5) {
          const r = p.track * toRad;
          along = north * Math.cos(r) + east * Math.sin(r);
        }
        let n = north;
        let e = east;
        if (along < 0) {
          const r = p.track * toRad;
          n -= along * Math.cos(r);
          e -= along * Math.sin(r);
        }
        const k = 1 - Math.exp(-dt / SMOOTH_TAU);
        // 剩余偏差平滑收敛
        d.lat += (n * k) / 111320;
        d.lon = U.wrapLon(d.lon + (e * k) / (111320 * cosLat));
        d.altM += (target.altM - d.altM) * k;
      }
      const disp = entry.disp;
      const pos = C.Cartesian3.fromDegrees(disp.lon, disp.lat, disp.altM);
      entry.pos = pos;

      /* ---- 地平线剔除：地球背面的直接隐藏 ---- */
      const visible = state.occluder.isPointVisible(pos);
      if (entry.hidden !== !visible) {
        entry.hidden = !visible;
        entry.bb.show = visible;
        entry.pt.show = visible;
        if (entry.label) entry.label.show = visible;
      }
      if (!visible) {
        hiddenCount += 1;
        continue;
      }

      entry.bb.position = pos;
      entry.pt.position = pos;
      if (entry.label) entry.label.position = pos;
    }

    FR.state.hiddenBackside = hiddenCount;

    /* ---- 跟随：以目标为原点建立 ENU 坐标系，目标始终居中 ---- */
    if (state.followHex) {
      const entry = planeIndex.get(state.followHex);
      if (entry) {
        const p = entry.plane;
        const target = entry.bb.position;
        const transform = C.Transforms.eastNorthUpToFixedFrame(target);
        state.viewer.camera.lookAtTransform(
          transform,
          new C.HeadingPitchRange(
            C.Math.toRadians(p.track || 0),
            C.Math.toRadians(-28),
            190000
          )
        );
      } else {
        state.followHex = null;
        if (followListener) followListener(null);
      }
    }
  }

  /* ---------------- 交互 ---------------- */
  function bindInteractions(viewer) {
    const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);

    const hexAt = (position) => {
      const picked = viewer.scene.pick(position);
      if (C.defined(picked)) {
        if (picked.id && picked.id._frHex) return picked.id._frHex;
        if (picked.primitive && picked.primitive.id && picked.primitive.id._frHex) {
          return picked.primitive.id._frHex;
        }
      }
      return null;
    };

    handler.setInputAction((movement) => {
      select(hexAt(movement.position));
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((movement) => {
      const hex = hexAt(movement.position);
      if (hex) {
        select(hex);
        follow(hex);
      } else if (state.followHex) {
        unfollow();
      }
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    viewer.scene.canvas.addEventListener(
      'wheel',
      () => {
        if (state.followHex) unfollow();
      },
      { passive: true }
    );
  }

  function onSelect(fn) {
    selectListener = fn;
  }

  function select(hex) {
    const prev = state.selectedHex;
    state.selectedHex = hex || null;
    if (prev !== state.selectedHex) refreshSelectionIcons(prev, state.selectedHex);
    FR.state.selectedHex = state.selectedHex;
    if (!selectListener) return;
    const plane = state.selectedHex ? FR.sources.byHex.get(state.selectedHex) || null : null;
    selectListener(plane);
  }

  /* ---------------- 底图 / 图层 ---------------- */
  function setBasemap(kind) {
    if (!state.viewer) return;
    const sat = state.satelliteLayer;
    const dark = state.darkLayer;

    if (kind === 'satellite') {
      if (sat) sat.show = true;
      if (dark) dark.show = false;
      state.basemap = 'satellite';
    } else if (kind === 'dark') {
      if (sat) sat.show = false;
      if (dark) dark.show = true;
      state.basemap = 'dark';
    } else {
      if (sat) sat.show = false;
      if (dark) dark.show = false;
      state.basemap = 'none';
    }
    if (state.referenceLayer) state.referenceLayer.show = state.referenceWanted;
  }

  function setReferenceVisible(v) {
    state.referenceWanted = !!v;
    if (state.referenceLayer) state.referenceLayer.show = !!v;
  }

  function setAtmosphere(v) {
    state.scene.skyAtmosphere.show = !!v;
    state.scene.globe.showGroundAtmosphere = !!v;
  }

  function setPlaneLabels(v) {
    state.showLabels = !!v;
    if (FR.sources) sync(FR.sources.planes);
  }

  /* ---------------- 帧循环 ---------------- */
  let frames = 0;
  let fpsAt = performance.now();

  function startRenderLoop() {
    if (!state.viewer) return;

    state.scene.preRender.addEventListener(() => {
      animate();
      // 贴近地面时隐藏边界/地名参考层，让卫星影像保持干净
      if (state.referenceLayer && state.referenceWanted) {
        const h = state.viewer.camera.positionCartographic.height;
        const want = h > 1.6e6 && state.basemap !== 'none';
        if (state.referenceLayer.show !== want) state.referenceLayer.show = want;
      }
    });

    state.scene.postRender.addEventListener(() => {
      frames += 1;
      const now = performance.now();
      if (now - fpsAt >= 1000) {
        FR.state.fps = Math.round((frames * 1000) / (now - fpsAt));
        frames = 0;
        fpsAt = now;
      }
    });
  }

  /* ---------------- 调试 ---------------- */
  function debugDepth() {
    if (!state.viewer) return null;
    let depthOff = 0;
    let total = 0;
    let sample = null;
    let hidden = 0;
    for (const e of planeIndex.values()) {
      total += 1;
      // disableDepthTestDistance 为 undefined / 0 => GPU 正常深度测试（正确行为）
      const d = e.bb.disableDepthTestDistance;
      if (d !== undefined && d !== 0) depthOff += 1;
      if (e.hidden) hidden += 1;
      if (!sample) {
        sample = {
          hex: e.plane.hex,
          cls: e.cls,
          disableDepthTestDistance: d === undefined ? 'undefined(默认=正常深度测试)' : d,
          show: e.bb.show,
          hidden: e.hidden,
          image: e.bb.image,
        };
      }
    }
    return { total, depthTestDisabled: depthOff, hiddenBackside: hidden, sample };
  }

  const FR_DEBUG = {
    info() {
      if (!state.viewer) return { ready: false };
      const layers = state.viewer.imageryLayers;
      const out = { ready: true, layers: [] };
      for (let i = 0; i < layers.length; i++) {
        const l = layers.get(i);
        out.layers.push({ index: i, show: l.show, url: l.imageryProvider && l.imageryProvider.url });
      }
      out.camera = {
        height: Math.round(state.viewer.camera.positionCartographic.height),
        lon: +C.Math.toDegrees(state.viewer.camera.positionCartographic.longitude).toFixed(2),
        lat: +C.Math.toDegrees(state.viewer.camera.positionCartographic.latitude).toFixed(2),
      };
      out.primitives = { billboards: state.billboards.length, labels: state.labels.length };
      return out;
    },
  };
  FR.debug = FR_DEBUG;

  FR.scene = {
    init,
    state,
    planeIndex,
    classify,
    sync,
    animate,
    select,
    onSelect,
    onFollowChange,
    follow,
    unfollow,
    flyTo,
    flyToPlane,
    currentRect,
    setBasemap,
    setReferenceVisible,
    setAtmosphere,
    setPlaneLabels,
    startRenderLoop,
    debugDepth,
    VIEW_PRESETS,
    get followHex() {
      return state.followHex;
    },
  };
})();
