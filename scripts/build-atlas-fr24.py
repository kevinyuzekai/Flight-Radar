#!/usr/bin/env python3
"""FR24 风格图集：白色机身 + 深色描边（运行时按颜色染成黄色/选中红色，描边保持深色）。
需要 Pillow。源图：app/renderer/assets/planes/<cls>.png（只取 alpha 轮廓）。"""
import os
from PIL import Image, ImageFilter, ImageChops
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'app/renderer/assets/planes')
OUT = os.path.join(ROOT, 'app/ui/tex/atlas.png')
CELL, COLS = 112, 5
NAMES = ['a380','b747','widebody','a330','narrowbody','regional','turboprop','light','heli','fighter']
SS = 4  # 超采样，抗锯齿
atlas = Image.new('RGBA', (CELL*COLS, CELL*2), (0,0,0,0))
for i, n in enumerate(NAMES):
    a = Image.open(os.path.join(SRC, n + '.png')).convert('RGBA').split()[3]
    a = a.crop(a.getbbox())
    big = CELL*SS; pad = 10*SS
    s = min((big-2*pad)/a.width, (big-2*pad)/a.height)
    a = a.resize((max(1,int(a.width*s)), max(1,int(a.height*s))), Image.LANCZOS)
    m = Image.new('L', (big, big), 0); m.paste(a, ((big-a.width)//2, (big-a.height)//2))
    m = m.point(lambda v: 255 if v > 110 else 0)
    outline = m.filter(ImageFilter.MaxFilter(4*SS+1))          # 描边约 2px
    cell = Image.new('RGBA', (big, big), (0,0,0,0))
    cell.paste(Image.new('RGBA', (big,big), (22,22,26,255)), mask=outline)
    cell.paste(Image.new('RGBA', (big,big), (255,255,255,255)), mask=m)
    cell = cell.resize((CELL, CELL), Image.LANCZOS)
    atlas.alpha_composite(cell, ((i % COLS)*CELL, (i//COLS)*CELL))
atlas.save(OUT, optimize=True)
print('atlas', atlas.size, os.path.getsize(OUT), 'bytes')
