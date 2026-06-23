#!/usr/bin/env python
"""
Tileset banner-strip + repack pipeline (v6).

For each source spritesheet PNG in an asset pack:
  1. Remove the decorative title BANNER at the top (+ the frame/chain border).
  2. Auto-detect the tile grid (rows x cols) via projection-gap segmentation.
  3. Extract each occupied cell's tight content bbox = one tile.
  4. Repack the tiles into a clean square-ish grid (cols = ceil(sqrt(n))) on a
     transparent background, every cell `cell` px with `gap` px spacing.
  5. Write <pack>/TILESET/<name>__cell<C>_gap<G>_v6.png  + a downscaled preview
     under TILESET/_previews/ and a row in TILESET/SIZING_GUIDE.txt.

World unit = 128px, gap = 32px. Tiles are uniformly scaled so the pack's base
floor-tile size maps to 128 (scale = 128 / base_src), preserving aspect, each
tile centered in its cell.

Reverse-engineered to reproduce the original "v5" output (Abandoned Asylum) and
generalized; kept as a file so it survives context resets.
"""
import sys, os, glob, math, argparse
import numpy as np
from PIL import Image

GAP = 32
WORLD_UNIT = 128
MASK_LUM = 16
MASK_ALPHA = 16


def load_mask(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    alpha = a[:, :, 3]
    lum = a[:, :, :3].max(axis=2)
    if alpha.max() <= MASK_ALPHA:          # fully opaque sheet on black
        mask = lum > MASK_LUM
    else:
        mask = (alpha > MASK_ALPHA) & (lum > MASK_LUM)
    return a, mask


def segments(proj, thr, min_run):
    """Runs where proj >= thr, each at least min_run long. Returns [(start,end)]."""
    out = []
    i = 0
    n = len(proj)
    while i < n:
        if proj[i] >= thr:
            j = i
            while j < n and proj[j] >= thr:
                j += 1
            if j - i >= min_run:
                out.append((i, j))
            i = j
        else:
            i += 1
    return out


def strip_banner(mask):
    """Drop the title banner at the top. The banner is separated from the tile
    grid by a DEEP, multi-row horizontal gap; internal banner text creates only
    shallow single-row dips, so we smooth the row-occupancy and look for the
    first deep gap-run that has real content above it. Returns y0 (first tile row)."""
    h, w = mask.shape
    occ = mask.sum(axis=1) / w
    k = 9
    sm = np.convolve(occ, np.ones(k) / k, mode="same")
    deep_gap = (sm < 0.06).astype(int)
    gaps = segments(deep_gap, 1, 12)  # gap-runs >= 12px
    for (g0, g1) in gaps:
        if g0 < h * 0.45 and occ[:g0].sum() > 40 * 0.05:  # content (banner) above it
            return g1
    return 0


def content_extent(proj, thr_frac=0.03):
    thr = proj.max() * thr_frac
    idx = np.where(proj >= thr)[0]
    return (int(idx[0]), int(idx[-1] + 1)) if len(idx) else (0, len(proj))


def detect_discrete(mask, y0, cx0, cx1, ry0, ry1):
    """Objects separated by background: morphological-close to merge each object's
    internal cracks, label connected components, take each blob's bbox."""
    from scipy import ndimage
    reg = mask[y0 + ry0:y0 + ry1, cx0:cx1]
    closed = ndimage.binary_closing(reg, structure=np.ones((9, 9)), iterations=2)
    lbl, n = ndimage.label(closed)
    if n == 0:
        return []
    objs = ndimage.find_objects(lbl)
    areas = [(lbl[s] == i + 1).sum() for i, s in enumerate(objs) if s]
    if not areas:
        return []
    big = np.median([a for a in areas if a > 0])
    cells = []
    for i, s in enumerate(objs):
        if s is None:
            continue
        if (lbl[s] == i + 1).sum() < max(64, big * 0.06):
            continue
        ys, xs = s
        # tighten to actual (un-closed) content within the blob box
        sub = reg[ys, xs]
        yy, xx = np.where(sub)
        if len(xx) == 0:
            continue
        tx0 = cx0 + xs.start + xx.min(); tx1 = cx0 + xs.start + xx.max() + 1
        ty0 = y0 + ry0 + ys.start + yy.min(); ty1 = y0 + ry0 + ys.start + yy.max() + 1
        cells.append((tx0, ty0, tx1, ty1))
    cells.sort(key=lambda c: (round((c[1]) / 64), c[0]))  # reading order
    return cells


def estimate_pitch(proj, lo=64, hi=360):
    x = proj.astype(float) - proj.mean()
    if np.allclose(x, 0):
        return None
    ac = np.correlate(x, x, mode="full")[len(x) - 1:]
    ac = ac / (ac[0] + 1e-9)
    hi = min(hi, len(ac) - 1)
    peaks = [(lag, ac[lag]) for lag in range(lo, hi)
             if ac[lag] > ac[lag - 1] and ac[lag] >= ac[lag + 1] and ac[lag] > 0.2]
    if not peaks:
        return None
    return max(peaks, key=lambda p: p[1])[0]


def detect_seamless(mask, y0, cx0, cx1, ry0, ry1):
    """Densely-filled tile sheet: slice on the regular pitch (grout lines)."""
    region = mask[y0:, :]
    px = estimate_pitch(region.sum(axis=0)[cx0:cx1]) or (cx1 - cx0)
    py = estimate_pitch(region.sum(axis=1)[ry0:ry1]) or (ry1 - ry0)
    ncols = max(1, round((cx1 - cx0) / px))
    nrows = max(1, round((ry1 - ry0) / py))
    cells = []
    for r in range(nrows):
        for c in range(ncols):
            a = cx0 + round(c * (cx1 - cx0) / ncols); b = cx0 + round((c + 1) * (cx1 - cx0) / ncols)
            cc = ry0 + round(r * (ry1 - ry0) / nrows); dd = ry0 + round((r + 1) * (ry1 - ry0) / nrows)
            sub = region[cc:dd, a:b]
            if sub.size == 0 or sub.mean() < 0.04:
                continue
            cells.append((a, y0 + cc, b, y0 + dd))
    return cells


def detect_grid(mask, y0):
    """Branch by fill density: dense sheets (floor/wall) get pitch slicing; sparse
    sheets (discrete objects) get connected-component extraction."""
    region = mask[y0:, :]
    col_proj = region.sum(axis=0).astype(float)
    row_proj = region.sum(axis=1).astype(float)
    cx0, cx1 = content_extent(col_proj)
    ry0, ry1 = content_extent(row_proj)
    if cx1 - cx0 < 16 or ry1 - ry0 < 16:
        return []
    fill = region[ry0:ry1, cx0:cx1].mean()
    if fill > 0.62:
        return detect_seamless(mask, y0, cx0, cx1, ry0, ry1)
    return detect_discrete(mask, y0, cx0, cx1, ry0, ry1)


def is_tile_sheet(name):
    n = name.lower()
    return any(k in n for k in ("floor", "wall", "tiles", "ground", "grass", "terrain", "path"))


def process_pack(src_pngs, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    prev_dir = os.path.join(out_dir, "_previews")
    os.makedirs(prev_dir, exist_ok=True)

    # Pass 1 — detect every sheet's tiles + src tile size.
    sheets = []
    for path in src_pngs:
        a, mask = load_mask(path)
        y0 = strip_banner(mask)
        cells = detect_grid(mask, y0)
        if not cells:
            print(f"  !! no tiles detected: {os.path.basename(path)}")
            continue
        sheets.append((path, a, cells))

    if not sheets:
        return []

    guide = []
    for (path, a, cells) in sheets:
        name = os.path.splitext(os.path.basename(path))[0]
        # LOSSLESS-FIRST: place tiles at NATIVE resolution (no resampling) so the
        # output is pixel-identical to the source. The cell is the typical tile
        # size — capped at the 90th percentile (and <=2x median) so one mis-merged
        # strip or a single huge prop can't blow the whole sheet up. Only tiles
        # that exceed the cell get scaled down (rare); everything else stays crisp.
        n = len(cells)
        dims = sorted(max(x1 - tx0, y1 - ty0) for (tx0, ty0, x1, y1) in cells)
        med = dims[len(dims) // 2]
        p90 = dims[min(len(dims) - 1, int(len(dims) * 0.9))]
        cell = max(8, min(p90, med * 2))
        if cell % 2:
            cell += 1
        cols = max(1, math.ceil(math.sqrt(n)))
        rows = max(1, math.ceil(n / cols))
        W = cols * cell + (cols - 1) * GAP
        H = rows * cell + (rows - 1) * GAP
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

        for i, (x0, y0_, x1, y1) in enumerate(cells):
            tile = Image.fromarray(a[y0_:y1, x0:x1])
            tw, th = tile.size
            if tw > cell or th > cell:  # oversized outlier — scale to fit
                s = min(cell / tw, cell / th)
                tw, th = max(1, round(tw * s)), max(1, round(th * s))
                tile = tile.resize((tw, th), Image.LANCZOS)
            gx = (i % cols) * (cell + GAP) + (cell - tw) // 2
            gy = (i // cols) * (cell + GAP) + (cell - th) // 2
            canvas.alpha_composite(tile, (gx, gy))

        out_name = f"{name}__cell{cell}_gap{GAP}_v7.png"
        canvas.save(os.path.join(out_dir, out_name))
        pv = canvas.copy()
        pv.thumbnail((384, 384), Image.LANCZOS)  # preview only — not the asset
        pv.save(os.path.join(prev_dir, f"_pv_{name}.png"))
        kind = "TILE" if is_tile_sheet(name) else "obj"
        guide.append((name, cell, GAP, f"{cols}x{rows}", n, kind))
        print(f"  ok {name[:40]:40s} cell{cell} {cols}x{rows} n={n} {kind}")

    with open(os.path.join(out_dir, "SIZING_GUIDE.txt"), "w", encoding="utf-8") as f:
        f.write(f"Lossless repack — tiles kept at NATIVE resolution, no scaling. "
                f"gap/spacing = {GAP}px.\n")
        f.write(f"Import per sheet: Tile W=H=<cell> (varies per sheet, see below), "
                f"Spacing X/Y={GAP}, Margin/Offset=0.\n\n")
        f.write(f"{'TILESET':46s} {'cell':>4s} {'spacing':>8s} {'grid':>7s} {'tiles':>6s} type\n")
        for (name, cell, gap, grid, n, kind) in sorted(guide):
            f.write(f"{name:46s} {cell:4d} {gap:8d} {grid:>7s} {n:6d} {kind}\n")
    return guide


def find_source_pngs(pack_dir):
    """All real sheet PNGs in a pack, excluding our own TILESET output + previews."""
    out = []
    for p in glob.glob(os.path.join(pack_dir, "**", "*.png"), recursive=True):
        low = p.replace("\\", "/").lower()
        if "/tileset/" in low or "_pv_" in low or "__cell" in low:
            continue
        out.append(p)
    return sorted(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pack_dir")
    args = ap.parse_args()
    pngs = find_source_pngs(args.pack_dir)
    print(f"{os.path.basename(args.pack_dir)}: {len(pngs)} source PNGs")
    process_pack(pngs, os.path.join(args.pack_dir, "TILESET"))
