#!/usr/bin/env python3
"""把 10 类机型图标 + 家/选中标记合成一张图集，便于单次 draw call 绘制。"""
import os, zlib, struct, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'app/renderer/assets/planes')
OUT = os.path.join(ROOT, 'app/ui/tex/atlas.png')

# 图集：4x4 网格，每格 128x128
CELL = 112
COLS = 5
NAMES = ['a380','b747','widebody','a330','narrowbody','regional','turboprop','light','heli','fighter']

import subprocess, tempfile

def normalize_png(path):
    """sips 统一转成 RGB 8bit PNG，避免调色板/灰度导致解码分支不一致。"""
    out = os.path.join(tempfile.gettempdir(), 'fr_atlas_' + os.path.basename(path))
    subprocess.run(['sips', '-s', 'format', 'png', '-s', 'formatOptions', 'best',
                    path, '--out', out], capture_output=True)
    return out if os.path.exists(out) else path

def read_png(p):
    d = open(normalize_png(p),'rb').read()
    i = 8; idat = b''; w = h = 0; ct = 0; bd = 8
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; t = d[i+4:i+8]
        if t == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', d[i+8:i+18])
        elif t == b'IDAT':
            idat += d[i+8:i+8+ln]
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
            b = prev[x]
            c = prev[x-bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 0xff
            elif f == 2: line[x] = (line[x] + b) & 0xff
            elif f == 3: line[x] = (line[x] + (a+b)//2) & 0xff
            elif f == 4:
                pp = a + b - c
                pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xff
        out[y*stride:(y+1)*stride] = line
        prev = line
    # 转 RGBA
    rgba = bytearray(w*h*4)
    for y in range(h):
        for x in range(w):
            o = y*stride + x*bpp
            d4 = (y*w+x)*4
            rgba[d4] = out[o]; rgba[d4+1] = out[o+1]; rgba[d4+2] = out[o+2]
            rgba[d4+3] = out[o+3] if bpp == 4 else 255
    return w, h, rgba

def blend(dst, dw, dh, src, sw, sh, ox, oy):
    for y in range(sh):
        for x in range(sw):
            so = (y*sw+x)*4
            a = src[so+3]
            if a == 0: continue
            dy, dx = oy+y, ox+x
            if dy >= dh or dx >= dw: continue
            do = (dy*dw+dx)*4
            inv = (255-a)/255.0
            for k in range(3):
                dst[do+k] = int(src[so+k]*(a/255.0) + dst[do+k]*inv)
            dst[do+3] = min(255, int(a + dst[do+3]*inv))

rows = (len(NAMES) + COLS - 1)//COLS
W, H = CELL*COLS, CELL*rows
canvas = bytearray(W*H*4)

for i, name in enumerate(NAMES):
    p = os.path.join(SRC, name + '.png')
    if not os.path.exists(p): continue
    sw, sh, src = read_png(p)
    cx, cy = (i % COLS)*CELL, (i // COLS)*CELL
    # 等比缩放塞进 CELL，留 8px 边距
    scale = min((CELL-16)/sw, (CELL-16)/sh)
    tw, th = max(1,int(sw*scale)), max(1,int(sh*scale))
    # 最近邻缩放
    scaled = bytearray(tw*th*4)
    for y in range(th):
        for x in range(tw):
            sx = min(sw-1, int(x/scale)); sy = min(sh-1, int(y/scale))
            so = (sy*sw+sx)*4; do = (y*tw+x)*4
            scaled[do:do+4] = src[so:so+4]
    blend(canvas, W, H, scaled, tw, th, cx + (CELL-tw)//2, cy + (CELL-th)//2)

raw = bytearray()
for y in range(H):
    raw.append(0)
    raw += canvas[y*W*4:(y+1)*W*4]

def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)

hdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)
open(OUT, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr) +
                      chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
print('atlas', W, H, os.path.getsize(OUT), 'bytes')
