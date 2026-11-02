import type {
    GroundCorrectionMask,
    GroundCorrectionMaskOperation,
    GroundCorrectionMaskPolygonOperation,
    GroundCorrectionMaskBrushOperation,
    GroundCorrectionMaskClusterOperation,
    ObjectType,
} from '../type';

const MAX_CLUSTER_POINTS = 10_000;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is { x: number; y: number } {
    if (!value || typeof value !== 'object') return false;
    const point = value as { x?: unknown; y?: unknown };
    return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function hasValidHeightRange(value: unknown): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object') return false;
    const heightRange = value as { min?: unknown; max?: unknown };
    return (
        isFiniteNumber(heightRange.min) &&
        isFiniteNumber(heightRange.max) &&
        heightRange.min <= heightRange.max
    );
}

function hasValidOrigin(value: unknown): boolean {
    return value === undefined || value === 'transfer' || value === 'propagated';
}

function validatePolygonOperation(value: unknown): value is GroundCorrectionMaskPolygonOperation {
    if (!value || typeof value !== 'object') return false;
    const operation = value as { type?: unknown; vertices?: unknown; heightRange?: unknown; origin?: unknown };
    return (
        operation.type === 'polygon' &&
        hasValidOrigin(operation.origin) &&
        Array.isArray(operation.vertices) &&
        operation.vertices.length >= 3 &&
        operation.vertices.every(isPoint) &&
        hasValidHeightRange(operation.heightRange)
    );
}

function validateBrushOperation(value: unknown): value is GroundCorrectionMaskBrushOperation {
    if (!value || typeof value !== 'object') return false;
    const operation = value as {
        type?: unknown;
        center?: unknown;
        samples?: unknown;
        radius?: unknown;
        heightRange?: unknown;
        erase?: unknown;
        origin?: unknown;
    };
    if (
        operation.type !== 'brush' ||
        !hasValidOrigin(operation.origin) ||
        (operation.erase !== undefined && operation.erase !== true) ||
        (!isPoint(operation.center) &&
            (!Array.isArray(operation.samples) ||
                operation.samples.length === 0 ||
                !operation.samples.every(isPoint))) ||
        !isFiniteNumber(operation.radius) ||
        operation.radius <= 0
    ) {
        return false;
    }
    return hasValidHeightRange(operation.heightRange);
}

function validateClusterOperation(value: unknown): value is GroundCorrectionMaskClusterOperation {
    if (!value || typeof value !== 'object') return false;
    const operation = value as { type?: unknown; points?: unknown; radius?: unknown; origin?: unknown };
    return (
        operation.type === 'cluster' &&
        hasValidOrigin(operation.origin) &&
        Array.isArray(operation.points) &&
        operation.points.length > 0 &&
        operation.points.length <= MAX_CLUSTER_POINTS &&
        operation.points.every(
            (point) =>
                isPoint(point) &&
                isFiniteNumber((point as { z?: unknown }).z),
        ) &&
        isFiniteNumber(operation.radius) &&
        operation.radius > 0
    );
}

function validateOperation(value: unknown): value is GroundCorrectionMaskOperation {
    return (
        validatePolygonOperation(value) ||
        validateBrushOperation(value) ||
        validateClusterOperation(value)
    );
}

export function isGroundCorrectionMaskObjectType(type: ObjectType | undefined): boolean {
    return type === 'GROUND_CORRECTION_MASK';
}

export function deserializeGroundCorrectionMask(value: unknown): GroundCorrectionMask {
    if (!value || typeof value !== 'object') {
        throw new TypeError('GROUND_CORRECTION_MASK payload must be an object');
    }
    const payload = value as { version?: unknown; operations?: unknown };
    if (
        payload.version !== 1 ||
        !Array.isArray(payload.operations) ||
        !payload.operations.every(validateOperation)
    ) {
        throw new TypeError('GROUND_CORRECTION_MASK payload is invalid');
    }
    return {
        version: 1,
        operations: payload.operations.map((operation) => {
            if (operation.type === 'polygon') {
                return {
                    type: 'polygon',
                    vertices: operation.vertices.map((vertex) => ({ ...vertex })),
                    ...(operation.heightRange
                        ? { heightRange: { ...operation.heightRange } }
                        : {}),
                    ...(operation.origin ? { origin: operation.origin } : {}),
                };
            }
            if (operation.type === 'cluster') {
                return {
                    type: 'cluster',
                    points: operation.points.map((point) => ({ ...point })),
                    radius: operation.radius,
                    ...(operation.origin ? { origin: operation.origin } : {}),
                };
            }
            return {
                type: 'brush',
                ...(operation.samples
                    ? { samples: operation.samples.map((sample) => ({ ...sample })) }
                    : { center: { ...operation.center! } }),
                radius: operation.radius,
                ...(operation.heightRange
                    ? { heightRange: { ...operation.heightRange } }
                    : {}),
                ...(operation.erase ? { erase: true as const } : {}),
                ...(operation.origin ? { origin: operation.origin } : {}),
            };
        }),
    };
}

export function serializeGroundCorrectionMask(payload: GroundCorrectionMask): GroundCorrectionMask {
    return deserializeGroundCorrectionMask(payload);
}

export function serializeGroundCorrectionMaskMeta(
    payload: GroundCorrectionMask,
): Record<string, GroundCorrectionMask> {
    return {
        groundCorrectionMask: serializeGroundCorrectionMask(payload),
    };
}

export function deserializeGroundCorrectionMaskMeta(meta: unknown): GroundCorrectionMask {
    if (!meta || typeof meta !== 'object') {
        throw new TypeError('GROUND_CORRECTION_MASK meta must be an object');
    }
    return deserializeGroundCorrectionMask(
        (meta as { groundCorrectionMask?: unknown }).groundCorrectionMask,
    );
}

export interface GroundCorrectionMaskRestoreResult {
    mask?: GroundCorrectionMask;
    warning?: string;
}

export function restoreGroundCorrectionMask(
    payload: unknown,
    objectId: string | undefined,
): GroundCorrectionMaskRestoreResult {
    try {
        return { mask: deserializeGroundCorrectionMask(payload) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            warning: `Skipping GROUND_CORRECTION_MASK object ${objectId || 'unknown'}: ${reason}`,
        };
    }
}
