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

/** A 3D box given by its world matrix over the unit cube [-0.5, 0.5]^3 (column-major elements). */
export interface ForceGroundProtectedBox {
    type: 'box';
    matrix: readonly number[];
    inverseMatrix: readonly number[];
}

export interface ForceGroundWallSample {
    bottom: ForceGroundClusterPoint;
    top: ForceGroundClusterPoint;
}

/** A ruled wall surface; points within `thickness` of its bottom footprint and between its bottom and top are protected. */
export interface ForceGroundProtectedWall {
    type: 'wall';
    samples: readonly ForceGroundWallSample[];
    thickness: number;
}

/** Annotated objects whose points must never be corrected to ground. */
export type ForceGroundProtectedVolume = ForceGroundProtectedBox | ForceGroundProtectedWall;

export const FORCE_GROUND_THRESHOLD = 0.5;
export const AUTO_NON_GROUND_TOLERANCE = 12;

/**
 * Ego vehicle body in point cloud coordinates (rear-axle origin). XY matches
 * HORIZON_EGO_RANGE in backend/occ-worker/xtreme_occ/fusion.py, but the bottom is raised
 * from -0.3 to 0.0: ground under the vehicle reaches about -0.2 (ground is at -0.33) while
 * body returns start around 0.2. Points inside are never ground.
 */
export const EGO_BODY_RANGE = {
    min: [-1.17, -1.2, 0.0],
    max: [3.8, 1.2, 1.4],
} as const;

export function isInEgoBody(x: number, y: number, z: number): boolean {
    return x >= EGO_BODY_RANGE.min[0] && x <= EGO_BODY_RANGE.max[0] &&
        y >= EGO_BODY_RANGE.min[1] && y <= EGO_BODY_RANGE.max[1] &&
        z >= EGO_BODY_RANGE.min[2] && z <= EGO_BODY_RANGE.max[2];
}

export function createEgoBodyProtectedVolume(): ForceGroundProtectedBox {
    const [minX, minY, minZ] = EGO_BODY_RANGE.min;
    const [maxX, maxY, maxZ] = EGO_BODY_RANGE.max;
    const size = [maxX - minX, maxY - minY, maxZ - minZ];
    const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    return {
        type: 'box',
        matrix: [
            size[0], 0, 0, 0,
            0, size[1], 0, 0,
            0, 0, size[2], 0,
            center[0], center[1], center[2], 1,
        ],
        inverseMatrix: [
            1 / size[0], 0, 0, 0,
            0, 1 / size[1], 0, 0,
            0, 0, 1 / size[2], 0,
            -center[0] / size[0], -center[1] / size[1], -center[2] / size[2], 1,
        ],
    };
}

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
    protectedVolumes: readonly ForceGroundProtectedVolume[],
): Uint8Array {
    if (positions.length % 3 !== 0) {
        throw new RangeError(`Point positions must contain XYZ triples; received ${positions.length} values`);
    }

    const forceGround = new Uint8Array(positions.length / 3);
    if (operations.length === 0) return forceGround;
    const grid = createPointGrid(positions);
    // Applied oldest first, so a newer operation (e.g. an eraser stroke) overwrites the
    // corrections made before it.
    operations.forEach((operation) => {
        if (operation.type === 'cluster') {
            markClusterPoints(grid, operation, forceGround);
            return;
        }
        if (operation.type === 'brush' && isSparseBrush(operation)) {
            markSparseBrushPoints(grid, operation, forceGround);
            return;
        }
        const matcher = createOperationMatcher(operation);
        const value = matcher.erase ? 0 : 1;
        grid.forEachPointInBounds(matcher.bounds, (index, x, y, z) => {
            if (forceGround[index] !== value && matcher.matches(x, y, z)) forceGround[index] = value;
        });
    });

    const isProtected = createProtectionMatcher(protectedVolumes);
    for (let index = 0; index < forceGround.length; index++) {
        if (
            forceGround[index] &&
            isProtected(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2])
        ) {
            forceGround[index] = 0;
        }
    }
    return forceGround;
}

const POINT_GRID_MIN_CELL_SIZE = 0.5;

interface PointGrid {
    forEachPointInBounds(
        bounds: MatcherBounds,
        visit: (index: number, x: number, y: number, z: number) => void,
    ): void;
}

/** XY bucket grid (CSR layout) so each operation only scans points under its bounds. */
function createPointGrid(positions: ArrayLike<number>): PointGrid {
    const count = positions.length / 3;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < count; index++) {
        const x = positions[index * 3];
        const y = positions[index * 3 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(positions[index * 3 + 2])) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { forEachPointInBounds: () => undefined };

    // Far outliers must not blow up the cell count; coarser cells only cost extra checks.
    const maxCells = Math.max(1024, count * 2);
    let cellSize = POINT_GRID_MIN_CELL_SIZE;
    while ((Math.floor((maxX - minX) / cellSize) + 1) * (Math.floor((maxY - minY) / cellSize) + 1) > maxCells) {
        cellSize *= 2;
    }
    const columns = Math.floor((maxX - minX) / cellSize) + 1;
    const rows = Math.floor((maxY - minY) / cellSize) + 1;
    const cellOf = new Int32Array(count).fill(-1);
    const cellStart = new Int32Array(columns * rows + 1);
    for (let index = 0; index < count; index++) {
        const x = positions[index * 3];
        const y = positions[index * 3 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(positions[index * 3 + 2])) continue;
        const cell = Math.floor((y - minY) / cellSize) * columns + Math.floor((x - minX) / cellSize);
        cellOf[index] = cell;
        cellStart[cell + 1]++;
    }
    for (let cell = 0; cell < columns * rows; cell++) cellStart[cell + 1] += cellStart[cell];
    const cursor = cellStart.slice(0, columns * rows);
    const indices = new Int32Array(cellStart[columns * rows]);
    for (let index = 0; index < count; index++) {
        if (cellOf[index] >= 0) indices[cursor[cellOf[index]]++] = index;
    }

    return {
        forEachPointInBounds(bounds, visit): void {
            if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY) return;
            const firstColumn = Math.max(0, Math.floor((bounds.minX - minX) / cellSize));
            const lastColumn = Math.min(columns - 1, Math.floor((bounds.maxX - minX) / cellSize));
            const firstRow = Math.max(0, Math.floor((bounds.minY - minY) / cellSize));
            const lastRow = Math.min(rows - 1, Math.floor((bounds.maxY - minY) / cellSize));
            for (let row = firstRow; row <= lastRow; row++) {
                for (let column = firstColumn; column <= lastColumn; column++) {
                    const cell = row * columns + column;
                    for (let slot = cellStart[cell]; slot < cellStart[cell + 1]; slot++) {
                        const index = indices[slot];
                        const x = positions[index * 3];
                        const y = positions[index * 3 + 1];
                        const z = positions[index * 3 + 2];
                        if (
                            x < bounds.minX || x > bounds.maxX ||
                            y < bounds.minY || y > bounds.maxY ||
                            z < bounds.minZ || z > bounds.maxZ
                        ) {
                            continue;
                        }
                        visit(index, x, y, z);
                    }
                }
            }
        },
    };
}

function brushSamples(operation: ForceGroundBrushOperation): readonly ForceGroundPoint[] {
    return operation.samples || (operation.center ? [operation.center] : []);
}

/** True when the sample discs cover less than the bounding box, e.g. long strokes or region brushes. */
function isSparseBrush(operation: ForceGroundBrushOperation): boolean {
    const samples = brushSamples(operation);
    const bounds = expandXYBounds(samples, operation.radius);
    const diameter = operation.radius * 2;
    return samples.length * diameter * diameter < (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
}

/** Visits only the points around each sample instead of the whole bounding box. */
function markSparseBrushPoints(
    grid: PointGrid,
    operation: ForceGroundBrushOperation,
    forceGround: Uint8Array,
): void {
    const { radius } = operation;
    const radiusSquared = radius * radius;
    const value = operation.erase === true ? 0 : 1;
    const { minZ, maxZ } = heightBounds(operation.heightRange);
    brushSamples(operation).forEach((sample) => {
        grid.forEachPointInBounds(
            {
                minX: sample.x - radius,
                maxX: sample.x + radius,
                minY: sample.y - radius,
                maxY: sample.y + radius,
                minZ,
                maxZ,
            },
            (index, x, y) => {
                if (forceGround[index] === value) return;
                const dx = x - sample.x;
                const dy = y - sample.y;
                if (dx * dx + dy * dy <= radiusSquared) forceGround[index] = value;
            },
        );
    });
}

/** Marks every point within `radius` (3D) of a persisted cluster point. */
function markClusterPoints(
    grid: PointGrid,
    operation: ForceGroundClusterOperation,
    forceGround: Uint8Array,
): void {
    const { radius, points } = operation;
    const radiusSquared = radius * radius;
    const buckets = createNeighborhoodBuckets(points, radius);
    let minZ = Infinity;
    let maxZ = -Infinity;
    points.forEach((point) => {
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    });
    grid.forEachPointInBounds(
        { ...expandXYBounds(points, radius), minZ: minZ - radius, maxZ: maxZ + radius },
        (index, x, y, z) => {
            // Cluster points are dense, so most candidates are already marked by now.
            if (forceGround[index] === 1) return;
            const bucket = buckets.get(x, y);
            if (!bucket) return;
            for (const point of bucket) {
                const dx = x - point.x;
                const dy = y - point.y;
                const dz = z - point.z;
                if (dx * dx + dy * dy + dz * dz <= radiusSquared) {
                    forceGround[index] = 1;
                    return;
                }
            }
        },
    );
}

export function createProtectionMatcher(
    volumes: readonly ForceGroundProtectedVolume[],
): (x: number, y: number, z: number) => boolean {
    const matchers = volumes.map((volume) =>
        volume.type === 'box' ? createBoxMatcher(volume) : createWallMatcher(volume),
    );
    return (x, y, z) => matchers.some(({ bounds, matches }) =>
        x >= bounds.minX && x <= bounds.maxX &&
        y >= bounds.minY && y <= bounds.maxY &&
        z >= bounds.minZ && z <= bounds.maxZ &&
        matches(x, y, z),
    );
}

type VolumeMatcher = Pick<OperationMatcher, 'bounds' | 'matches'>;

function createBoxMatcher(box: ForceGroundProtectedBox): VolumeMatcher {
    const m = box.matrix;
    const inv = box.inverseMatrix;
    const corners: ForceGroundClusterPoint[] = [];
    for (const cx of [-0.5, 0.5]) {
        for (const cy of [-0.5, 0.5]) {
            for (const cz of [-0.5, 0.5]) {
                corners.push({
                    x: m[0] * cx + m[4] * cy + m[8] * cz + m[12],
                    y: m[1] * cx + m[5] * cy + m[9] * cz + m[13],
                    z: m[2] * cx + m[6] * cy + m[10] * cz + m[14],
                });
            }
        }
    }
    return {
        bounds: {
            ...expandXYBounds(corners, 0),
            minZ: Math.min(...corners.map((corner) => corner.z)),
            maxZ: Math.max(...corners.map((corner) => corner.z)),
        },
        matches(x: number, y: number, z: number): boolean {
            const localX = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
            const localY = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
            const localZ = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
            return Math.abs(localX) <= 0.5 && Math.abs(localY) <= 0.5 && Math.abs(localZ) <= 0.5;
        },
    };
}

function createWallMatcher(wall: ForceGroundProtectedWall): VolumeMatcher {
    const { samples, thickness } = wall;
    const thicknessSquared = thickness * thickness;
    const allPoints = samples.flatMap((sample) => [sample.bottom, sample.top]);
    return {
        bounds: {
            ...expandXYBounds(allPoints, thickness),
            minZ: Math.min(...allPoints.map((point) => point.z)),
            maxZ: Math.max(...allPoints.map((point) => point.z)),
        },
        matches(x: number, y: number, z: number): boolean {
            for (let index = 0; index + 1 < samples.length; index++) {
                const start = samples[index];
                const end = samples[index + 1];
                const dx = end.bottom.x - start.bottom.x;
                const dy = end.bottom.y - start.bottom.y;
                const lengthSquared = dx * dx + dy * dy;
                const t = lengthSquared <= 0
                    ? 0
                    : Math.min(1, Math.max(0, ((x - start.bottom.x) * dx + (y - start.bottom.y) * dy) / lengthSquared));
                const offsetX = x - (start.bottom.x + dx * t);
                const offsetY = y - (start.bottom.y + dy * t);
                if (offsetX * offsetX + offsetY * offsetY > thicknessSquared) continue;
                const bottomZ = start.bottom.z + (end.bottom.z - start.bottom.z) * t;
                const topZ = start.top.z + (end.top.z - start.top.z) * t;
                if (z >= Math.min(bottomZ, topZ) && z <= Math.max(bottomZ, topZ)) return true;
            }
            return false;
        },
    };
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

function createOperationMatcher(
    operation: ForceGroundPolygonOperation | ForceGroundBrushOperation,
): OperationMatcher {
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

interface NeighborhoodBuckets<T> {
    /** Points that may lie within `cellSize` of (x, y). */
    get(x: number, y: number): readonly T[] | undefined;
}

/**
 * Buckets of `cellSize` cells where each point is stored in its own cell and the 8 around
 * it, so anything within `cellSize` of a query is found with a single bucket lookup.
 * Keys are relative to the buckets' own extent so they stay small integers, which V8
 * hashes much faster than heap numbers.
 */
function createNeighborhoodBuckets<T extends ForceGroundPoint>(
    points: readonly T[],
    cellSize: number,
): NeighborhoodBuckets<T> {
    let minCellX = Infinity;
    let maxCellX = -Infinity;
    let minCellY = Infinity;
    let maxCellY = -Infinity;
    points.forEach((point) => {
        const cellX = Math.floor(point.x / cellSize);
        const cellY = Math.floor(point.y / cellSize);
        minCellX = Math.min(minCellX, cellX - 1);
        maxCellX = Math.max(maxCellX, cellX + 1);
        minCellY = Math.min(minCellY, cellY - 1);
        maxCellY = Math.max(maxCellY, cellY + 1);
    });
    const rows = maxCellY - minCellY + 1;
    const buckets = new Map<number, T[]>();
    points.forEach((point) => {
        const cellX = Math.floor(point.x / cellSize);
        const cellY = Math.floor(point.y / cellSize);
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
            for (let offsetY = -1; offsetY <= 1; offsetY++) {
                const key = (cellX + offsetX - minCellX) * rows + (cellY + offsetY - minCellY);
                const bucket = buckets.get(key);
                if (bucket) bucket.push(point);
                else buckets.set(key, [point]);
            }
        }
    });
    return {
        get(x: number, y: number): readonly T[] | undefined {
            const cellX = Math.floor(x / cellSize);
            const cellY = Math.floor(y / cellSize);
            if (cellX < minCellX || cellX > maxCellX || cellY < minCellY || cellY > maxCellY) return undefined;
            return buckets.get((cellX - minCellX) * rows + (cellY - minCellY));
        },
    };
}

function createBrushMatcher(operation: ForceGroundBrushOperation): OperationMatcher {
    const { radius } = operation;
    const samples = brushSamples(operation);
    const cells = createNeighborhoodBuckets(samples, radius);
    const radiusSquared = radius * radius;
    return {
        bounds: {
            ...expandXYBounds(samples, radius),
            ...heightBounds(operation.heightRange),
        },
        matches(x: number, y: number): boolean {
            const candidates = cells.get(x, y);
            if (!candidates) return false;
            for (const sample of candidates) {
                const dx = x - sample.x;
                const dy = y - sample.y;
                if (dx * dx + dy * dy <= radiusSquared) return true;
            }
            return false;
        },
        erase: operation.erase === true,
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
