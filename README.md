# Flight Radar

macOS **菜单栏实时航班雷达**。不打开窗口、不占 Dock，常驻菜单栏，点一下才弹出半透明悬浮面板：
三维地球 + 真实卫星影像 + 你头顶正在经过的飞机，还能对指定机型设「拍机警报」。

<p align="center">
  <img src="docs/screenshot.jpg" width="360" alt="Flight Radar 面板">
</p>

- **版本**：0.2.1
- **系统**：macOS 13+（Apple Silicon）
- **安装包**：2.6 MB（App 本体 8.1 MB）
- **数据**：[adsb.lol](https://adsb.lol/) + [adsb.fi](https://adsb.fi/)
- **影像**：Esri World Imagery

---

## 它是怎么工作的

```
菜单栏图标（实时显示全球在空飞机数）
        │  点击
        ▼
悬浮面板（无边框 / 半透明 / 可拖动）
   ├── 迷你三维地球（Cesium）+ 真实卫星底图
   ├── 头顶经过的飞机列表（距离 / 方位 / 高度）
   └── 当前空域最繁忙机场榜
        │
        └── 拍机警报 → 右上角系统通知
```

App 以 `LSUIElement` 运行，**没有 Dock 图标、没有大窗口**。数据在后台每 20 秒刷新一次，
菜单栏数字始终是最新的，面板按需生成，不用时不会占用屏幕。

---

## 功能

### 菜单栏
- 实时显示全球在空飞机数量（图标由代码绘制，无图片资源）
- 左键：开/关悬浮面板；右键：显示面板、开关拍机警报、退出

### 悬浮面板
| 模块 | 说明 |
| --- | --- |
| 迷你三维地球 | Cesium 真实球体 + Esri 卫星影像，可拖动旋转、滚轮缩放、双击复位 |
| 头顶经过 | 按距离排序的附近飞机：航班号、航空公司、机型、高度、距离、方位 |
| 最繁忙机场 | 用周边 55 km 内的在空飞机数近似，列出前 5 名 |
| 点选跟踪 | 点列表中的飞机，地球自动对准并跟随，目标始终居中 |

### 拍机警报
设定关注机型 + 半径后，一旦有匹配的飞机进入范围，立刻推送系统通知：

> ⚠️ 拍机警报 · A380
> 一架阿联酋航空 空客 A380 正从你附近飞过，高度 35000 英尺，距离 12 公里。

- **关注机型**：A380 / B747 / 宽体 / A330 / 窄体 / 支线 / 涡桨 / 通航 / 直升机 / 战机，可多选
- **额外机型码**：支持填 `B77W A35K` 这类精确代码
- **半径**：5–120 km 可调
- **去重**：同一架飞机 30 分钟内只提醒一次，避免刷屏
- **测试按钮**：设置页里可发一条测试通知，确认权限是否正常

### 通知中心小组件（需签名，见下文）
`native/Widget/` 是完整的 WidgetKit 扩展：

- **小尺寸**：旋转地球 + 在空飞机数
- **中尺寸**：地球 + 最繁忙机场前 5 名
- App 写入共享快照，小组件按时间线读取，超过 30 分钟会提示「打开 App 以更新」

### 设置
- 观察点：经纬度 + 名称（默认杭州），不依赖定位权限
- 警报半径、关注机型、额外机型码
- 数据范围：100 / 250 / 450 NM（范围越大，全球计数与机场榜越准）

---

## 数据来源

| 源 | 接口 | 用途 |
| --- | --- | --- |
| adsb.lol | `api.adsb.lol/v2/point/{lat}/{lon}/{dist}` | 主数据源，单次可取较大范围 |
| adsb.fi | `opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}` | 补充，单次上限 250 NM |

两路并行拉取，按 `hex`（ICAO 24 位地址）合并，同一架取最新定位。
所有请求由原生 `URLSession` 发出，只放行上述域名——页面不会被当成任意代理。

---

## 构建

`app/cesium/` 是从 npm 包生成的运行时（不入库），所以需要三步：

```bash
npm install        # 安装 cesium（仅构建期需要）
npm run runtime    # 生成 app/cesium：裁剪 + 只复制运行时真正用到的部分
npm run build      # 编译原生外壳 + 组装 .app + ad-hoc 签名 + 打包 DMG
```

其他命令：

```bash
npm run start      # 构建后直接打开
npm run icon       # 重新生成 build/icon.icns
npm run smoke      # 冒烟自检：抓状态 + 截图后退出
```

构建产物：`release/Flight Radar.dmg`

### 体积是怎么压下来的

原始工程 16 MB，现在安装包 2.6 MB，主要靠这几刀：

| 处理 | 节省 |
| --- | --- |
| 去掉 `app/cesium/cesium/` 重复副本 | 11 MB |
| 删掉失效的 `.gz` 预压缩文件 | 1.7 MB |
| SkyBox 六张星空图 → 单张可平铺星图 | 810 KB |
| 删除 `NaturalEarthII` / `Assets/Images` | 580 KB |
| 删除旧渲染层、中间素材、旧单体入口 | 730 KB |
| 截图 3000px PNG → JPEG | 3.7 MB |

另外 `build-app.sh` 的 Swift 模块缓存改写到系统临时目录——之前它会在工程里堆出 **484 MB** 的
`.build-cache`。

---

## 目录结构

```
Flight-Radar/
├── native/
│   ├── App/                 原生外壳（Swift / AppKit）
│   │   ├── main.swift       菜单栏、状态图标、自检
│   │   ├── Panel.swift      无边框半透明悬浮窗 + WKWebView 宿主
│   │   ├── Store.swift      设置持久化、轮询、警报判定、机场统计
│   │   ├── Feed.swift       并行拉取 adsb.lol / adsb.fi 并按 hex 合并
│   │   ├── Core.swift       地理计算、机型分类、航空公司表
│   │   ├── Notifier.swift   系统通知
│   │   ├── Scheme.swift     app:// 静态资源 + radar:// 数据代理
│   │   └── WidgetBridge.swift  与小组件共享快照
│   ├── Widget/              WidgetKit 扩展（SwiftUI）
│   └── Info.plist
├── app/ui/                  面板前端
│   ├── index.html           面板结构（地球 / 列表 / 机场榜 / 设置）
│   ├── panel.css            暗色 + 青色霓虹设计系统
│   ├── js/scene.js          Cesium 场景、图元、遮挡剔除、交互
│   ├── js/panel.js          列表、设置、与原生通信
│   ├── js/sources.js        ADS-B 拉取与合并
│   ├── js/bridge.js         渲染层 ↔ 原生桥
│   ├── js/util.js           格式化与地理工具
│   ├── tex/stars.jpg        星空（替代 860 KB 的 SkyBox）
│   └── assets/planes/       10 类机型图标
├── scripts/                 构建、图标、贴图、冒烟脚本
├── build/icon.icns
└── release/Flight Radar.dmg
```

---

## 几个踩过的坑（写下来省得再踩）

**1. 自定义协议是必需的，不是洁癖**
Cesium 需要 Web Worker 与 ES Module。`file://` 的 origin 是 `null`，内核直接拒绝 Worker，
影像瓦片解不出来（表现为地球全黑）。所以注册 `app://local` 当本地静态站点。
CSP 里还必须放行 `script-src blob:`，否则 Cesium 的 worker 会被拦。

**2. CSP 少一项，数据请求会静默失败**
`connect-src` 不含 `radar:` 时，面板里的 fetch 全部报 `Load failed`，而且不会告诉你原因。

**3. `WKWebView` 不显示就不渲染**
自检时如果窗口没显示，帧循环会停摆（`fps: 0`）、截图只能拿到首帧。自检也必须把窗口显示出来。

**4. 未签名的应用拿不到通知与小组件**
`UNUserNotificationCenter` 授权会返回 `Notifications are not allowed for this application`，
未签名的 WidgetKit 扩展则根本不会被 `pluginkit` 注册。这两项功能需要 Apple 开发者证书签名：

```bash
codesign --force --sign "Developer ID Application: YOUR NAME (TEAMID)" \
  --entitlements native/Widget/Widget.entitlements "build/Flight Radar.app/Contents/PlugIns/FlightRadarWidget.appex"
codesign --force --sign "Developer ID Application: YOUR NAME (TEAMID)" "build/Flight Radar.app"
```

拍机警报在未签名时仍会在面板内提示（绿色 toast + 自动开面板），但不会进系统通知中心。

---

## 安装

```bash
# 拖进 /Applications 后，如果 Gatekeeper 拦截：
xattr -dr com.apple.quarantine "/Applications/Flight Radar.app"
```

应用未做代码签名，属正常现象。

---

## 声明

ADS-B 数据来自 adsb.lol / adsb.fi 的志愿者接收站网络，版权归各社区所有；卫星影像 © Esri。
本项目仅用于学习与个人观测，请控制刷新频率，遵守数据源的使用条款。
