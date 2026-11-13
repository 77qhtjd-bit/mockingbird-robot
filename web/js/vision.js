// Finds the gray person figure (printed in Bambu Lab PLA Basic Gray) in a small RGBA frame.
//
// 1. Color mask: a pixel matches when its brightness is close to the reference gray and its tint
//    (r-g, b-g) is close to the reference tint. The reference starts at PLA Basic Gray and can be
//    replaced by tapping the figure on screen (calibrate), which absorbs the camera's exposure and
//    white balance.
// 2. Connected blobs (4-neighbour) after an optional 1-pixel dilation that rejoins pieces split by
//    shading.
// 3. Each blob is scored: big, upright (height/width near the figure's shape), solid, and close to
//    where the target was in the previous frame. Wide blobs (gray floor, walls) are rejected.
//
// Everything is plain JS so it runs on the phone without OpenCV and can be tested in Node.

// Bambu Lab PLA Basic Gray is about #8E9089. Under room light the camera usually sees it darker,
// so calibrating on the real figure is recommended.
export const PLA_BASIC_GRAY = { r: 142, g: 144, b: 137 };

export const DEFAULT_VISION = {
  ref: PLA_BASIC_GRAY,
  lumTol: 40, // brightness difference allowed (0..255)
  chromaTol: 16, // tint difference allowed (0..255)
  dilate: 1, // 0 or 1 pixel
  minAreaFrac: 0.002, // smallest blob, as a fraction of the frame
  maxWidthFrac: 0.7, // wider blobs are floor / wall, not the figure
  targetAspect: 2.2, // height / width of the figure seen from the robot
  aspectSigma: 0.6, // how strict the shape check is (log scale)
  minAspectScore: 0.15,
  trackBonus: 1.5, // preference for the blob near the previous target
};

export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function colorMask(rgba, w, h, p, out = new Uint8Array(w * h)) {
  const { r: R, g: G, b: B } = p.ref;
  const refL = luma(R, G, B);
  const refA = R - G;
  const refB = B - G;
  const lt = p.lumTol;
  const ct2 = p.chromaTol * p.chromaTol;
  for (let i = 0, j = 0, n = w * h; i < n; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    const dl = luma(r, g, b) - refL;
    if (dl > lt || dl < -lt) {
      out[i] = 0;
      continue;
    }
    const da = r - g - refA;
    const db = b - g - refB;
    out[i] = da * da + db * db <= ct2 ? 1 : 0;
  }
  return out;
}

export function dilate(mask, w, h, out = new Uint8Array(w * h)) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] =
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < w - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - w]) ||
        (y < h - 1 && mask[i + w])
          ? 1
          : 0;
    }
  }
  return out;
}

// Connected blobs of a 0/1 mask. Returns blobs with pixel area, centroid and inclusive bbox.
export function findBlobs(mask, w, h, minArea = 1) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const blobs = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (y > 0 && mask[i - w] && !seen[i - w]) (seen[i - w] = 1), (stack[top++] = i - w);
      if (y < h - 1 && mask[i + w] && !seen[i + w]) (seen[i + w] = 1), (stack[top++] = i + w);
    }
    if (area >= minArea) blobs.push({ area, cx: sx / area, cy: sy / area, x0, x1, y0, y1 });
  }
  return blobs;
}

// Score one blob; returns null when it cannot be the figure. Coordinates in the result are
// normalized to 0..1 of the frame; size = blob height / frame height (distance proxy).
export function scoreBlob(b, w, h, p, prev = null) {
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  if (bw > p.maxWidthFrac * w) return null;
  const aspect = bh / bw;
  let aspectScore = Math.exp(-(Math.log(aspect / p.targetAspect) ** 2) / (2 * p.aspectSigma ** 2));
  // Very close, the figure runs off the top or bottom edge and its shape is no longer reliable.
  const clipped = b.y0 === 0 || b.y1 === h - 1;
  if (clipped && bh > 0.6 * h) aspectScore = Math.max(aspectScore, 0.5);
  if (aspectScore < p.minAspectScore) return null;
  const fill = b.area / (bw * bh);
  let score = Math.sqrt(b.area) * aspectScore * Math.min(1, fill / 0.3);
  const cx = b.cx / w;
  const cy = b.cy / h;
  if (prev) {
    const d = Math.hypot(cx - prev.cx, cy - prev.cy);
    score *= 1 + p.trackBonus * Math.max(0, 1 - d / 0.25);
  }
  return {
    cx,
    cy,
    size: bh / h,
    box: { x: b.x0 / w, y: b.y0 / h, w: bw / w, h: bh / h },
    aspect,
    fill,
    score,
  };
}

// Full detection on one frame. prev = previous result's target (for tracking), or null.
// Returns { found, target, candidates, mask } — mask is reused between calls via `buf`.
export function detectFigure(rgba, w, h, params = {}, prev = null, buf = {}) {
  const p = { ...DEFAULT_VISION, ...params };
  const n = w * h;
  if (!buf.mask || buf.mask.length !== n) {
    buf.mask = new Uint8Array(n);
    buf.grown = new Uint8Array(n);
  }
  colorMask(rgba, w, h, p, buf.mask);
  const m = p.dilate ? dilate(buf.mask, w, h, buf.grown) : buf.mask;
  const blobs = findBlobs(m, w, h, Math.max(4, Math.round(p.minAreaFrac * n)));
  const candidates = [];
  for (const b of blobs) {
    const s = scoreBlob(b, w, h, p, prev);
    if (s) candidates.push(s);
  }
  candidates.sort((a, b) => b.score - a.score);
  return { found: candidates.length > 0, target: candidates[0] ?? null, candidates, mask: buf.mask };
}

// Median color of a small square around (x, y) — used to calibrate the reference gray.
export function sampleColor(rgba, w, h, x, y, radius = 3) {
  const rs = [];
  const gs = [];
  const bs = [];
  for (let yy = Math.max(0, y - radius); yy <= Math.min(h - 1, y + radius); yy++) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(w - 1, x + radius); xx++) {
      const j = (yy * w + xx) * 4;
      rs.push(rgba[j]);
      gs.push(rgba[j + 1]);
      bs.push(rgba[j + 2]);
    }
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return { r: med(rs), g: med(gs), b: med(bs) };
}
