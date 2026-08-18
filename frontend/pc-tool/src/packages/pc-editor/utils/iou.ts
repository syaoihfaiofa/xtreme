import { Box } from 'pc-render';

interface Point2D {
    x: number;
    y: number;
}

// Corners of a yaw-rotated rectangle (bird's-eye view), ordered counter-clockwise.
function getBevCorners(cx: number, cy: number, dx: number, dy: number, yaw: number): Point2D[] {
    const hx = dx / 2;
    const hy = dy / 2;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const local: [number, number][] = [
        [hx, hy],
        [-hx, hy],
        [-hx, -hy],
        [hx, -hy],
    ];
    return local.map(([lx, ly]) => ({
        x: cx + lx * cos - ly * sin,
        y: cy + lx * sin + ly * cos,
    }));
}

function polygonArea(points: Point2D[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area += a.x * b.y - b.x * a.y;
    }
    return Math.abs(area) / 2;
}

// Sutherland-Hodgman polygon clipping. Both inputs must be convex polygons
// (true for the rectangles here), `clip` vertices given counter-clockwise.
function clipPolygon(subject: Point2D[], clip: Point2D[]): Point2D[] {
    let output = subject;
    for (let i = 0; i < clip.length; i++) {
        if (output.length === 0) break;
        const clipA = clip[i];
        const clipB = clip[(i + 1) % clip.length];
        const input = output;
        output = [];
        const edgeCross = (p: Point2D) => (clipB.x - clipA.x) * (p.y - clipA.y) - (clipB.y - clipA.y) * (p.x - clipA.x);
        for (let j = 0; j < input.length; j++) {
            const current = input[j];
            const prev = input[(j + input.length - 1) % input.length];
            const currentInside = edgeCross(current) >= 0;
            const prevInside = edgeCross(prev) >= 0;
            if (currentInside) {
                if (!prevInside) {
                    output.push(lineIntersection(prev, current, clipA, clipB));
                }
                output.push(current);
            } else if (prevInside) {
                output.push(lineIntersection(prev, current, clipA, clipB));
            }
        }
    }
    return output;
}

function lineIntersection(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): Point2D {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x;
    const d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-12) return p2;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/**
 * Bird's-eye-view IoU between two boxes, based on their (x, y) center, (dx, dy) size
 * and yaw rotation (rotation.z). Ignores height/z, since duplicate-detection only cares
 * about footprint overlap on the ground plane.
 */
export function computeBevIoU(a: Box, b: Box): number {
    const cornersA = getBevCorners(a.position.x, a.position.y, a.scale.x, a.scale.y, a.rotation.z);
    const cornersB = getBevCorners(b.position.x, b.position.y, b.scale.x, b.scale.y, b.rotation.z);

    const areaA = polygonArea(cornersA);
    const areaB = polygonArea(cornersB);
    if (areaA <= 0 || areaB <= 0) return 0;

    const intersection = clipPolygon(cornersA, cornersB);
    if (intersection.length < 3) return 0;
    const interArea = polygonArea(intersection);

    const unionArea = areaA + areaB - interArea;
    if (unionArea <= 0) return 0;
    return interArea / unionArea;
}
