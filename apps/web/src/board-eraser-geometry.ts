type Point = { x: number; y: number };
type Shape = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeWidth: number;
  backgroundColor: string;
  locked?: boolean;
  isDeleted?: boolean;
  points?: readonly (readonly number[])[];
};
const distance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
function intersects(a: Point, b: Point, c: Point, d: Point) {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const x = cross(a, b, c),
    y = cross(a, b, d),
    u = cross(c, d, a),
    v = cross(c, d, b);
  return x * y < 0 && u * v < 0;
}
export function eraserHits(shape: Shape, from: Point, to: Point, radius: number) {
  if (
    shape.isDeleted ||
    shape.locked ||
    shape.id.startsWith('background_') ||
    shape.type === 'frame'
  )
    return false;
  const cx = shape.x + shape.width / 2,
    cy = shape.y + shape.height / 2,
    c = Math.cos(-shape.angle),
    s = Math.sin(-shape.angle),
    local = (p: Point) => ({
      x: cx + (p.x - cx) * c - (p.y - cy) * s - shape.x,
      y: cy + (p.x - cx) * s + (p.y - cy) * c - shape.y,
    }),
    a = local(from),
    b = local(to),
    w = shape.width,
    h = shape.height;
  let points: Point[] = [];
  if (shape.points?.length) points = shape.points.map((p) => ({ x: p[0], y: p[1] }));
  else if (shape.type === 'ellipse')
    points = Array.from({ length: 65 }, (_, i) => ({
      x: w / 2 + (w / 2) * Math.cos((i * Math.PI) / 32),
      y: h / 2 + (h / 2) * Math.sin((i * Math.PI) / 32),
    }));
  else if (shape.type === 'diamond')
    points = [
      { x: w / 2, y: 0 },
      { x: w, y: h / 2 },
      { x: w / 2, y: h },
      { x: 0, y: h / 2 },
      { x: w / 2, y: 0 },
    ];
  else
    points = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
      { x: 0, y: 0 },
    ];
  if (['text', 'image'].includes(shape.type) || shape.backgroundColor !== 'transparent') {
    const inside = (p: Point) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h;
    if (inside(a) || inside(b)) return true;
  }
  const reach = radius + (shape.strokeWidth * (shape.type === 'freedraw' ? 4.25 : 1)) / 2;
  if (points.length === 1) return distance(points[0], a, b) <= reach;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1],
      q = points[i];
    if (
      intersects(a, b, p, q) ||
      Math.min(distance(a, p, q), distance(b, p, q), distance(p, a, b), distance(q, a, b)) <= reach
    )
      return true;
  }
  return false;
}
