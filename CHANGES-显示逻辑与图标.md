# 本次改进（未改版本号）

## 1. 体积
- 删除可再生成的内容：node_modules（229M，`npm install` 恢复）、.build-cache（231M，Swift 编译缓存）、build/Flight Radar.app（`npm run build` 重建）、.DS_Store。
- docs 截图 zopflipng 无损重压（5.2MB → 4.2MB）；飞机图标改为无损 zopfli PNG，删除运行时从未引用的 @2x 图标。
- app/cesium 运行时、native/bin/FlightRadar 二进制保持不变。

## 2. 显示逻辑：飞机不再“回到之前的位置”
根因：
1. 每次数据到达 `scene.sync()` 都 `removeAll()` 重建全部图元，显示位置被重置到新数据的原始定位点；
2. 外推起点用的是“拉取时刻”而不是“定位时刻”（忽略了 `seen_pos`），所以外推一直比真实位置超前，新数据一到就往回跳；
3. adsb.lol / adsb.fi 合并时固定让 fi 覆盖，即使 fi 那条定位更旧；
4. 每轮 `aircraft.clear()`，某轮漏掉的飞机会消失再出现。

修复：
- `posTime = 拉取时刻 - seen_pos`，外推以定位时刻为起点；
- 合并时取定位更新的那条；比已有定位更旧/相同的数据不覆盖位置（只前进）；
- 一轮没出现的飞机保留 60 秒继续外推，过期才移除；
- `sync()` 改为增量：复用 billboard/label，只更新数据；
- 每帧：显示位置先按地速沿航向前进，再把剩余偏差平滑收敛（τ=1.2s）；若新目标在显示位置“后面”，丢弃沿航向向后的分量，只做横向修正，绝不倒退；偏差 >30km 才直接跳。

## 3. 图标
- FR24 风格俯视剪影：黄色实心 + 细深色描边，选中目标变红（`*-sel.png`）。图形由 `scripts/build-assets.mjs` 自绘，未使用 FR24 素材。
- 图标不再按高度染色（远景小圆点仍按高度着色）。

## 未测试
- 没在 macOS 上编译/运行（Swift 外壳未改动）；JS 只做了语法检查。
