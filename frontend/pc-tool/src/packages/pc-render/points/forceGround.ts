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
}

export interface ForceGroundBrushOperation {
    type: 'brush';
    center?: ForceGroundPoint;
    samples?: readonly ForceGroundPoint[];
    radius: number;
    heightRange?: ForceGroundHeightRange;
}

export type ForceGroundOperation = ForceGroundPolygonOperation | ForceGroundBrushOperation;

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
}

export function shouldDiscardByGroundFilter(input: GroundFilterInput): boolean {
    const forcedGround = isForceGround(input.forceGround);
    const automaticNonGround = isAutomaticNonGround(input);
    if (input.colorMode === 2) {
        return input.hideNonGroundRgb && !forcedGround && automaticNonGround;
    }
    if (input.colorMode === 0 || input.colorMode === 1) {
        return input.hideGround && (forcedGround ||
            (input.hasColor && input.hasIntensity && !automaticNonGround));
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

    const forceGround = new Uint8Array(positions.length / 3);
    for (let index = 0; index < forceGround.length; index++) {
        const offset = index * 3;
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        forceGround[index] = operations.some((operation) =>
            operation.type === 'polygon'
                ? isPointInPolygon(x, y, operation.vertices)
                : isPointInBrush(x, y, z, operation),
        )
            ? 1
            : 0;
    }
    return forceGround;
}

function isPointInBrush(
    x: number,
    y: number,
    z: number,
    operation: ForceGroundBrushOperation,
): boolean {
    if (
        operation.heightRange &&
        (z < operation.heightRange.min || z > operation.heightRange.max)
    ) {
        return false;
    }
    const samples = operation.samples || (operation.center ? [operation.center] : []);
    return samples.some((sample) => {
        const dx = x - sample.x;
        const dy = y - sample.y;
        return dx * dx + dy * dy <= operation.radius * operation.radius;
    });
}

function isPointInPolygon(x: number, y: number, vertices: readonly ForceGroundPoint[]): boolean {
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
