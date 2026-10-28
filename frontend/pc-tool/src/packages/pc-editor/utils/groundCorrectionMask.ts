import type {
    GroundCorrectionMask,
    GroundCorrectionMaskOperation,
    GroundCorrectionMaskPolygonOperation,
    GroundCorrectionMaskBrushOperation,
    ObjectType,
} from '../type';

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is { x: number; y: number } {
    if (!value || typeof value !== 'object') return false;
    const point = value as { x?: unknown; y?: unknown };
    return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function validatePolygonOperation(value: unknown): value is GroundCorrectionMaskPolygonOperation {
    if (!value || typeof value !== 'object') return false;
    const operation = value as { type?: unknown; vertices?: unknown };
    return (
        operation.type === 'polygon' &&
        Array.isArray(operation.vertices) &&
        operation.vertices.length >= 3 &&
        operation.vertices.every(isPoint)
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
    };
    if (
        operation.type !== 'brush' ||
        (!isPoint(operation.center) &&
            (!Array.isArray(operation.samples) ||
                operation.samples.length === 0 ||
                !operation.samples.every(isPoint))) ||
        !isFiniteNumber(operation.radius) ||
        operation.radius <= 0
    ) {
        return false;
    }
    if (operation.heightRange === undefined) return true;
    if (!operation.heightRange || typeof operation.heightRange !== 'object') return false;
    const heightRange = operation.heightRange as { min?: unknown; max?: unknown };
    return (
        isFiniteNumber(heightRange.min) &&
        isFiniteNumber(heightRange.max) &&
        heightRange.min <= heightRange.max
    );
}

function validateOperation(value: unknown): value is GroundCorrectionMaskOperation {
    return validatePolygonOperation(value) || validateBrushOperation(value);
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
