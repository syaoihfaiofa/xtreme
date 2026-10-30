export interface ForceGroundPoint {
    x: number;
    y: number;
}

export interface ForceGroundHeightRange {
    min: number;
    max: number;
}

export interface ForceGroundPolygonOperation {
    type: 'polygon';
    vertices: readonly ForceGroundPoint[];
    heightRange?: ForceGroundHeightRange;
}

export interface ForceGroundBrushOperation {
    type: 'brush';
    center?: ForceGroundPoint;
    samples?: readonly ForceGroundPoint[];
    radius: number;
    heightRange?: ForceGroundHeightRange;
    erase?: boolean;
}

export interface ForceGroundClusterPoint extends ForceGroundPoint {
    z: number;
}

export interface ForceGroundClusterOperation {
    type: 'cluster';
    points: readonly ForceGroundClusterPoint[];
    radius: number;
}

export type ForceGroundOperation =
    | ForceGroundPolygonOperation
    | ForceGroundBrushOperation
    | ForceGroundClusterOperation;

export const FORCE_GROUND_THRESHOLD = 0.5;
export const AUTO_NON_GROUND_TOLERANCE = 12;

export function isForceGround(forceGround: number): boolean {
    return forceGround > FORCE_GROUND_THRESHOLD;
}

export interface AutomaticNonGroundInput {
    hasColor: boolean;
    hasIntensity: boolean;
    color?: readonly [number, number, number];
    intensity?: number;
}

export function isAutomaticNonGround(input: AutomaticNonGroundInput): boolean {
    if (!input.hasColor || !input.hasIntensity || !input.color || input.intensity === undefined) {
        return false;
    }
    return Math.abs(input.color[0] - input.intensity) < AUTO_NON_GROUND_TOLERANCE &&
        Math.abs(input.color[1] - input.intensity) < AUTO_NON_GROUND_TOLERANCE &&
        Math.abs(input.color[2] - input.intensity) < AUTO_NON_GROUND_TOLERANCE;
}

export interface GroundFilterInput extends AutomaticNonGroundInput {
    colorMode: number;
    hideGround: boolean;
    hideNonGroundRgb: boolean;
    forceGround: number;
    groundCorrectionPreview?: boolean;
}

export function shouldDiscardByGroundFilter(input: GroundFilterInput): boolean {
    const forcedGround = isForceGround(input.forceGround);
    const automaticNonGround = isAutomaticNonGround(input);
    if (input.colorMode === 2) {
        return input.hideNonGroundRgb && !forcedGround && automaticNonGround;
    }
    if (input.colorMode === 0 || input.colorMode === 1) {
        if (!input.hideGround) return false;
        if (forcedGround) {
            return !input.groundCorrectionPreview || !automaticNonGround;
        }
        return input.hasColor && input.hasIntensity && !automaticNonGround;
    }
    return false;
}

export interface PointRenderDecisionInput extends GroundFilterInput {
    openIntensity: number;
    intensity: number;
    intensityRange: readonly [number, number];
    sideViewContrast: number;
    isInSideViewContrastArea: boolean;
}

export interface PointRenderDecision {
    discard: boolean;
    discardedByGroundFilter: boolean;
    discardedByIntensityRange: boolean;
    sideViewContrastChangesColor: boolean;
}

export function evaluatePointRenderDecision(input: PointRenderDecisionInput): PointRenderDecision {
    const discardedByGroundFilter = shouldDiscardByGroundFilter(input);
    const discardedByIntensityRange = input.openIntensity > 0 &&
        (input.intensityRange[0] > input.intensity || input.intensityRange[1] < input.intensity);
    return {
        discard: discardedByGroundFilter || discardedByIntensityRange,
        discardedByGroundFilter,
        discardedByIntensityRange,
        sideViewContrastChangesColor: input.colorMode === 2 && input.hasColor &&
            input.sideViewContrast > 0 &&
            input.isInSideViewContrastArea,
    };
}

export function calculateForceGround(
    positions: ArrayLike<number>,
    operations: readonly ForceGroundOperation[],
): Uint8Array {
    if (positions.length % 3 !== 0) {
        throw new RangeError(`Point positions must contain XYZ triples; received ${positions.length} values`);
    }

    // Newest operation wins, so an eraser stroke only undoes corrections made before it.
    const matchers = operations.map(createOperationMatcher).reverse();
    const forceGround = new Uint8Array(positions.length / 3);
    for (let index = 0; index < forceGround.length; index++) {
        const offset = index * 3;
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        for (const matcher of matchers) {
            const { bounds } = matcher;
            if (
                x < bounds.minX || x > bounds.maxX ||
                y < bounds.minY || y > bounds.maxY ||
                z < bounds.minZ || z > bounds.maxZ ||
                !matcher.matches(x, y, z)
            ) {
                continue;
            }
            forceGround[index] = matcher.erase ? 0 : 1;
            break;
        }
    }
    return forceGround;
}

interface MatcherBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
}

interface OperationMatcher {
    /** Cheap reject box checked before `matches`; points outside can never match. */
    bounds: MatcherBounds;
    matches: (x: number, y: number, z: number) => boolean;
    erase: boolean;
}

function createOperationMatcher(operation: ForceGroundOperation): OperationMatcher {
    if (operation.type === 'cluster') {
        return createClusterMatcher(operation.radius, operation.points);
    }
    if (operation.type === 'polygon') {
        return {
            bounds: {
                ...expandXYBounds(operation.vertices, 0),
                ...heightBounds(operation.heightRange),
            },
            matches: (x, y, z) => isPointInPolygon(x, y, z, operation),
            erase: false,
        };
    }
    return createBrushMatcher(operation);
}

function heightBounds(heightRange: ForceGroundHeightRange | undefined): Pick<MatcherBounds, 'minZ' | 'maxZ'> {
    return heightRange
        ? { minZ: heightRange.min, maxZ: heightRange.max }
        : { minZ: -Infinity, maxZ: Infinity };
}

function expandXYBounds(
    points: readonly ForceGroundPoint[],
    margin: number,
): Pick<MatcherBounds, 'minX' | 'maxX' | 'minY' | 'maxY'> {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    points.forEach((point) => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
    });
    return { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
}

// Numeric cell keys avoid allocating strings for every point lookup. Cell indices stay
// far below +-CELL_OFFSET for point-cloud coordinates, keeping keys exact in float64.
const CELL_OFFSET = 1 << 16;
const CELL_BASE = 1 << 17;

function cellKey2D(cellX: number, cellY: number): number {
    return (cellX + CELL_OFFSET) * CELL_BASE + (cellY + CELL_OFFSET);
}

function cellKey3D(cellX: number, cellY: number, cellZ: number): number {
    return cellKey2D(cellX, cellY) * CELL_BASE + (cellZ + CELL_OFFSET);
}

function createBrushMatcher(operation: ForceGroundBrushOperation): OperationMatcher {
    const { radius } = operation;
    const samples = operation.samples || (operation.center ? [operation.center] : []);
    const cells = new Map<number, ForceGroundPoint[]>();
    samples.forEach((sample) => {
        const key = cellKey2D(Math.floor(sample.x / radius), Math.floor(sample.y / radius));
        const cell = cells.get(key);
        if (cell) cell.push(sample);
        else cells.set(key, [sample]);
    });
    const radiusSquared = radius * radius;
    return {
        bounds: {
            ...expandXYBounds(samples, radius),
            ...heightBounds(operation.heightRange),
        },
        matches(x: number, y: number): boolean {
            const cellX = Math.floor(x / radius);
            const cellY = Math.floor(y / radius);
            for (let offsetX = -1; offsetX <= 1; offsetX++) {
                for (let offsetY = -1; offsetY <= 1; offsetY++) {
                    const candidates = cells.get(cellKey2D(cellX + offsetX, cellY + offsetY));
                    if (!candidates) continue;
                    for (const sample of candidates) {
                        const dx = x - sample.x;
                        const dy = y - sample.y;
                        if (dx * dx + dy * dy <= radiusSquared) return true;
                    }
                }
            }
            return false;
        },
        erase: operation.erase === true,
    };
}

function createClusterMatcher(
    radius: number,
    points: readonly ForceGroundClusterPoint[],
): OperationMatcher {
    const cells = new Map<number, ForceGroundClusterPoint[]>();
    let minZ = Infinity;
    let maxZ = -Infinity;
    points.forEach((point) => {
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
        const key = cellKey3D(
            Math.floor(point.x / radius),
            Math.floor(point.y / radius),
            Math.floor(point.z / radius),
        );
        const cell = cells.get(key);
        if (cell) cell.push(point);
        else cells.set(key, [point]);
    });
    const radiusSquared = radius * radius;
    return {
        bounds: {
            ...expandXYBounds(points, radius),
            minZ: minZ - radius,
            maxZ: maxZ + radius,
        },
        matches(x: number, y: number, z: number): boolean {
            const cellX = Math.floor(x / radius);
            const cellY = Math.floor(y / radius);
            const cellZ = Math.floor(z / radius);
            for (let offsetX = -1; offsetX <= 1; offsetX++) {
                for (let offsetY = -1; offsetY <= 1; offsetY++) {
                    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
                        const candidates = cells.get(
                            cellKey3D(cellX + offsetX, cellY + offsetY, cellZ + offsetZ),
                        );
                        if (!candidates) continue;
                        for (const point of candidates) {
                            const dx = x - point.x;
                            const dy = y - point.y;
                            const dz = z - point.z;
                            if (dx * dx + dy * dy + dz * dz <= radiusSquared) return true;
                        }
                    }
                }
            }
            return false;
        },
        erase: false,
    };
}

function isPointInPolygon(
    x: number,
    y: number,
    z: number,
    operation: ForceGroundPolygonOperation,
): boolean {
    if (
        operation.heightRange &&
        (z < operation.heightRange.min || z > operation.heightRange.max)
    ) {
        return false;
    }
    const { vertices } = operation;
    let inside = false;
    for (let current = 0, previous = vertices.length - 1; current < vertices.length; previous = current++) {
        const start = vertices[previous];
        const end = vertices[current];
        if (isPointOnSegment(x, y, start, end)) return true;
        const intersects = (start.y > y) !== (end.y > y) &&
            x < ((end.x - start.x) * (y - start.y)) / (end.y - start.y) + start.x;
        if (intersects) inside = !inside;
    }
    return inside;
}

function isPointOnSegment(
    x: number,
    y: number,
    start: ForceGroundPoint,
    end: ForceGroundPoint,
): boolean {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const cross = (x - start.x) * dy - (y - start.y) * dx;
    if (Math.abs(cross) > Number.EPSILON) return false;
    const dot = (x - start.x) * dx + (y - start.y) * dy;
    return dot >= 0 && dot <= dx * dx + dy * dy;
}
