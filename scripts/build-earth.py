#!/usr/bin/env python3
"""
用真实的 Esri 瓦片拼一张 4096x2048 的地球贴图（等距圆柱投影）。

做法：取 Web Mercator 的 z=4 层级 16x16 瓦片，逐块贴到经纬度网格上。
  · 底图：World_Imagery（真实卫星影像）
  · 叠加：World_Boundaries_and_Places（国界 + 城市名，Esri 官方标注层）
这样得到的是「真实影像 + 官方地名」，不是手绘。
"""
import os, sys, zlib, struct, math, io, subprocess, ssl
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'app/ui/tex/earth.jpg')
MASK = os.path.join(ROOT, 'app/ui/tex/landmask.png')

W, H = 2048, 1024
Z = 3                      # 8x8 瓦片（体积优先，地表细节够用）
N = 1 << Z
TILE = 256

BASE = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
LABEL = "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"

CACHE = '/tmp/fr_tiles'
os.makedirs(CACHE, exist_ok=True)

def fetch(url):
    key = os.path.join(CACHE, str(abs(hash(url))) + '.bin')
    if os.path.exists(key):
        return open(key, 'rb').read()
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'FlightRadar/2.0'})
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            data = urllib.request.urlopen(req, timeout=45, context=ctx).read()
            open(key, 'wb').write(data)
            return data
        except Exception as e:
            if attempt == 2:
                print('  ! fail', url, e)
                return b''
    return b''

print(f'下载 {N*N} 张卫星瓦片 (z={Z}) ...')
tiles = {}
for y in range(N):
    for x in range(N):
        tiles[(x, y)] = fetch(BASE.format(z=Z, y=y, x=x))
print(f'  完成，共 {sum(1 for v in tiles.values() if v)} 张')

print(f'下载 {N*N} 张标注瓦片 ...')
labels = {}
for y in range(N):
    for x in range(N):
        labels[(x, y)] = fetch(LABEL.format(z=Z, y=y, x=x))
print(f'  完成，共 {sum(1 for v in labels.values() if v)} 张')

# 把瓦片合成到 PNG（先缩放到 W x H 的等距网格）
TMP = '/tmp/fr_tiles/img'
os.makedirs(TMP, exist_ok=True)

def tile_to_png(data, path):
    open(path + '.src', 'wb').write(data)

# 用 sips 无法直接做重投影，这里用逐像素采样：
# 目标图像是等距圆柱，源瓦片是墨卡托，需要按纬度映射回墨卡托 y。
def merc_y(lat_deg):
    lat = math.radians(lat_deg)
    return (1.0 - math.log(math.tan(lat) + 1.0 / math.cos(lat)) / math.pi) / 2.0

# 预解每块瓦片为 RGBA
def decode_png(data):
    if not data: return None
    p = TMP + '/t.png'
    open(p, 'wb').write(data)
    out = TMP + '/t_rgba.raw'
    r = subprocess.run(['sips', '-s', 'format', 'png', '-s', 'formatOptions', 'best',
                        p, '--out', TMP + '/t2.png'], capture_output=True)
    if r.returncode != 0: return None
    d = open(TMP + '/t2.png', 'rb').read()
    i = 8; idat = b''; w = h = 0; ct = 0
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; t = d[i+4:i+8]
        if t == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', d[i+8:i+18])
        elif t == b'IDAT': idat += d[i+8:i+8+ln]
        i += 12 + ln
    raw = zlib.decompress(idat)
    bpp = 4 if ct == 6 else 3
    stride = w * bpp
    out = bytearray(h*stride); prev = bytearray(stride); pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0
            b = prev[x]; c = prev[x-bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 0xff
            elif f == 2: line[x] = (line[x] + b) & 0xff
            elif f == 3: line[x] = (line[x] + (a+b)//2) & 0xff
            elif f == 4:
                pp = a + b - c; pa = abs(pp-a); pb = abs(pp-b); pc = abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xff
        out[y*stride:(y+1)*stride] = line; prev = line
    return w, h, bpp, out

print('解码瓦片 ...')
base_imgs = {}
for k, data in tiles.items():
    r = decode_png(data)
    if r: base_imgs[k] = r
label_imgs = {}
for k, data in labels.items():
    r = decode_png(data)
    if r: label_imgs[k] = r
print(f'  卫星 {len(base_imgs)}/{len(tiles)}，标注 {len(label_imgs)}/{len(labels)}')

print(f'重投影到 {W}x{H} ...')
canvas = bytearray(W * H * 3)

# 对每个目标像素，反算纬度/经度 → 墨卡托坐标 → 瓦片 + 像素
for py in range(H):
    lat = 90.0 - (py + 0.5) / H * 180.0
    my = merc_y(max(-85.05, min(85.05, lat)))
    for px in range(W):
        lon = (px + 0.5) / W * 360.0 - 180.0
        u = (lon + 180.0) / 360.0
        gx = u * N
        gy = my * N
        tx, ty = int(gx), int(gy)
        if tx >= N: tx = N - 1
        if ty >= N: ty = N - 1
        if tx < 0: tx = 0
        if ty < 0: ty = 0
        fx = gx - tx
        fy = gy - ty
        sx = min(255, int(fx * TILE))
        sy = min(255, int(fy * TILE))

        # 极区：墨卡托在 |lat|>85 处退化，用邻近纬度填充避免条纹
        if abs(lat) > 78.0:
            sy = 0 if lat > 0 else TILE - 1
            ty = 0 if lat > 0 else N - 1

        d = base_imgs.get((tx, ty))
        o = (py * W + px) * 3
        if d:
            w_, h_, bpp, buf = d
            so = sy * w_ * bpp + sx * bpp
            canvas[o] = buf[so]; canvas[o+1] = buf[so+1]; canvas[o+2] = buf[so+2]

        # 叠加官方标注（alpha 混合）
        ld = label_imgs.get((tx, ty))
        if ld:
            w_, h_, bpp, buf = ld
            so = sy * w_ * bpp + sx * bpp
            if bpp == 4:
                a = buf[so+3]
                if a > 8:
                    af = a / 255.0
                    for c in range(3):
                        canvas[o+c] = int(buf[so+c] * af + canvas[o+c] * (1 - af))

print('编码 PNG ...')
raw = bytearray()
for y in range(H):
    raw.append(0)
    raw += canvas[y*W*3:(y+1)*W*3]

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)

hdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)
tmp_png = '/tmp/fr_earth_big.png'
open(tmp_png, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr) +
                          chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))

print('转 JPEG ...')
subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '68', tmp_png, '--out', OUT],
               capture_output=True)
print('earth.jpg', os.path.getsize(OUT), 'bytes')

# 陆地掩码（从同一张图判断海洋/陆地）
gray = bytearray(W // 8 * H // 8)
sw, sh = W // 8, H // 8
for y in range(sh):
    for x in range(sw):
        o = ((y * 8) * W + (x * 8)) * 3
        r, g, b = canvas[o], canvas[o+1], canvas[o+2]
        ocean = (b > r + 12) and (b > g - 10)
        gray[y*sw+x] = 0 if ocean else 255

raw2 = bytearray()
for y in range(sh):
    raw2.append(0)
    raw2 += gray[y*sw:(y+1)*sw]
hdr2 = struct.pack('>IIBBBBB', sw, sh, 8, 0, 0, 0, 0)
open(MASK, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr2) +
                       chunk(b'IDAT', zlib.compress(bytes(raw2), 9)) + chunk(b'IEND', b''))
print('landmask.png', sw, sh, os.path.getsize(MASK), 'bytes')
