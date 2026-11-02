import type {
    GroundCorrectionMask,
    GroundCorrectionMaskBrushOperation,
    GroundCorrectionMaskClusterOperation,
    GroundCorrectionMaskOperation,
    GroundCorrectionMaskClusterPoint,
    GroundCorrectionMaskHeightRange,
    GroundCorrectionMaskPoint,
} from '../type';

export interface GroundCorrectionMaskPose {
    dataId: string | number;
    posX: number;
    posY: number;
    posZ: number;
    yaw: number;
    roll?: number;
    pitch?: number;
}

interface FrameWithId {
    id: string | number;
    name?: string;
    sceneId?: string;
}

interface TransformMatrix {
    rotation: number[][];
    translation: [number, number, number];
}

export interface PropagationFramesResult {
    frameIds: string[];
    missingPoseFrameIds: string[];
    differentSegmentFrameIds: string[];
}

export interface GroundCorrectionMaskOverlayObject {
    objectType?: string;
}

export interface GroundCorrectionMaskToolContext {
    activeView: unknown;
    state: {
        config: {
            showSingleImgView: boolean;
        };
    };
    viewManager: {
        getMainView: () => unknown;
    };
    showMsg: (type: string, message: string) => void;
    groundCorrectionMaskManager: {
        propagate: (distance: number) => Promise<void>;
    };
}

export function isGroundCorrectionMaskBevActive(editor: GroundCorrectionMaskToolContext): boolean {
    const mainView = editor.viewManager.getMainView();
    return !!mainView && !editor.state.config.showSingleImgView;
}

export function requestGroundCorrectionMaskPropagation(
    editor: GroundCorrectionMaskToolContext,
    requestDistance: () => string | null,
): void {
    if (!isGroundCorrectionMaskBevActive(editor)) {
        editor.showMsg('warning', '地面纠正仅支持在 BEV 主视图中编辑');
        return;
    }
    const value = requestDistance();
    if (value == null) return;
    const distance = Number(value);
    if (!Number.isInteger(distance) || distance < 1) {
        editor.showMsg('warning', '应用帧数必须是大于 0 的整数');
        return;
    }
    void editor.groundCorrectionMaskManager.propagate(distance);
}

export function appendGroundCorrectionMaskOperation(
    mask: GroundCorrectionMask,
    operation: GroundCorrectionMaskOperation,
): GroundCorrectionMask {
    return {
        version: 1,
        operations: [...mask.operations.map(cloneOperation), cloneOperation(operation)],
    };
}

/**
 * Converts a cluster into the region it covers so other frames, whose points differ,
 * are corrected across the whole area. The xy footprint is rasterized with `cellSize`,
 * enclosed holes (e.g. occlusion shadows) are filled, and the height is limited to the
 * cluster z range expanded by `zMargin`. Clusters are connected within `radius`, so
 * `cellSize >= radius` keeps neighbouring points in 8-connected cells and the
 * 4-connected exterior flood cannot leak through the footprint.
 */
export function clusterToRegionBrush(
    operation: GroundCorrectionMaskClusterOperation,
    cellSize: number,
    zMargin: number,
): GroundCorrectionMaskBrushOperation {
    if (!(cellSize >= operation.radius)) {
        throw new Error(`cellSize ${cellSize} must be >= cluster radius ${operation.radius}`);
    }
    if (operation.points.length === 0) {
        throw new Error('cannot convert an empty cluster to a region');
    }
    const cellOf = (value: number): number => Math.floor(value / cellSize);
    let minCellX = Infinity;
    let minCellY = Infinity;
    let maxCellX = -Infinity;
    let maxCellY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    operation.points.forEach((point) => {
        minCellX = Math.min(minCellX, cellOf(point.x));
        minCellY = Math.min(minCellY, cellOf(point.y));
        maxCellX = Math.max(maxCellX, cellOf(point.x));
        maxCellY = Math.max(maxCellY, cellOf(point.y));
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
    });
    // One empty cell of padding on each side lets the exterior flood surround the footprint.
    const originX = minCellX - 1;
    const originY = minCellY - 1;
    const width = maxCellX - minCellX + 3;
    const height = maxCellY - minCellY + 3;
    const occupied = new Uint8Array(width * height);
    operation.points.forEach((point) => {
        occupied[(cellOf(point.y) - originY) * width + cellOf(point.x) - originX] = 1;
    });
    const exterior = new Uint8Array(width * height);
    const stack = [0];
    exterior[0] = 1;
    while (stack.length) {
        const cell = stack.pop()!;
        const x = cell % width;
        const y = (cell - x) / width;
        const neighbours = [
            x > 0 ? cell - 1 : -1,
            x < width - 1 ? cell + 1 : -1,
            y > 0 ? cell - width : -1,
            y < height - 1 ? cell + width : -1,
        ];
        neighbours.forEach((next) => {
            if (next < 0 || exterior[next] || occupied[next]) return;
            exterior[next] = 1;
            stack.push(next);
        });
    }
    const samples: GroundCorrectionMaskPoint[] = [];
    for (let cell = 0; cell < width * height; cell++) {
        if (exterior[cell]) continue;
        const x = cell % width;
        const y = (cell - x) / width;
        samples.push({
            x: (originX + x + 0.5) * cellSize,
            y: (originY + y + 0.5) * cellSize,
        });
    }
    return {
        type: 'brush',
        samples,
        // Circumradius of a cell, so the union of discs covers every footprint cell.
        radius: (cellSize * Math.SQRT2) / 2,
        heightRange: { min: minZ - zMargin, max: maxZ + zMargin },
    };
}

export interface GroundTransferOptions {
    /** Rasterization cell edge in metres. */
    cellSize: number;
    /** Ground heights are quantized to this step so cells can share brushes. */
    zBinSize: number;
    /** Slack added below and above every height range. */
    zMargin: number;
    /** Empty source cells within this xy distance of ground inherit the nearest ground cell. */
    fillDistance: number;
    /** Height above the inherited ground top still corrected in filled cells. */
    fillHeightAbove: number;
    /** Grid edge (xy and z) for point-wise transfer inside cells mixing ground and non-ground. */
    mixedPointSpacing: number;
}

/**
 * Converts the final ground state of a frame into region brushes so another frame,
 * whose points differ, is corrected where this frame is ground. A cell qualifies when
 * it holds ground points and no non-ground point lies within its quantized ground z
 * range (curbs or objects the source frame deliberately kept). Cells without any
 * source point (occlusion, sparse returns) near qualifying ground inherit the height
 * of the nearest qualifying cell, raised by `fillHeightAbove`, because the target
 * frame may observe ground there that the source frame never saw. Rejected cells
 * (typically around pillar bases) still transfer their ground points point-wise, see
 * `mixedCellPointBrushes`.
 */
export function groundToRegionBrushes(
    positions: ArrayLike<number>,
    isGround: (index: number) => boolean,
    options: GroundTransferOptions,
): GroundCorrectionMaskBrushOperation[] {
    const { cellSize, zBinSize, zMargin, fillDistance, fillHeightAbove, mixedPointSpacing } = options;
    interface GroundCell {
        x: number;
        y: number;
        minZ: number;
        maxZ: number;
        nonGroundZ: number[];
        groundIndexes: number[];
    }
    interface CellRange {
        x: number;
        y: number;
        low: number;
        high: number;
    }
    const keyOf = (x: number, y: number): string => `${x},${y}`;
    const cells = new Map<string, GroundCell>();
    const pointCount = Math.floor(positions.length / 3);
    for (let index = 0; index < pointCount; index++) {
        const x = positions[index * 3];
        const y = positions[index * 3 + 1];
        const z = positions[index * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const cellX = Math.floor(x / cellSize);
        const cellY = Math.floor(y / cellSize);
        const key = keyOf(cellX, cellY);
        let cell = cells.get(key);
        if (!cell) {
            cell = { x: cellX, y: cellY, minZ: Infinity, maxZ: -Infinity, nonGroundZ: [], groundIndexes: [] };
            cells.set(key, cell);
        }
        if (isGround(index)) {
            cell.minZ = Math.min(cell.minZ, z);
            cell.maxZ = Math.max(cell.maxZ, z);
            cell.groundIndexes.push(index);
        } else {
            cell.nonGroundZ.push(z);
        }
    }
    const ranges: CellRange[] = [];
    const sources: { range: CellRange; maxZ: number }[] = [];
    const mixedGroundIndexes: number[] = [];
    cells.forEach((cell) => {
        if (cell.minZ > cell.maxZ) return;
        const low = Math.floor(cell.minZ / zBinSize);
        const high = Math.ceil(cell.maxZ / zBinSize);
        const min = low * zBinSize - zMargin;
        const max = high * zBinSize + zMargin;
        if (cell.nonGroundZ.some((z) => z >= min && z <= max)) {
            mixedGroundIndexes.push(...cell.groundIndexes);
            return;
        }
        const range = { x: cell.x, y: cell.y, low, high };
        ranges.push(range);
        sources.push({ range, maxZ: cell.maxZ });
    });
    // Multi-source BFS over empty cells so each inherits its nearest qualifying cell.
    const fillSteps = Math.floor(fillDistance / cellSize);
    const visited = new Set<string>(ranges.map((range) => keyOf(range.x, range.y)));
    let frontier = sources.map((source) => ({ x: source.range.x, y: source.range.y, source }));
    for (let step = 1; step <= fillSteps && frontier.length; step++) {
        const next: typeof frontier = [];
        frontier.forEach(({ x, y, source }) => {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const key = keyOf(x + dx, y + dy);
                    if (visited.has(key) || cells.has(key)) continue;
                    visited.add(key);
                    ranges.push({
                        x: x + dx,
                        y: y + dy,
                        low: source.range.low,
                        high: Math.ceil((source.maxZ + fillHeightAbove) / zBinSize),
                    });
                    next.push({ x: x + dx, y: y + dy, source });
                }
            }
        });
        frontier = next;
    }
    // Cells sharing the same quantized [low, high] share one brush and one height range.
    const bins = new Map<string, { samples: GroundCorrectionMaskPoint[]; low: number; high: number }>();
    ranges.forEach((range) => {
        const binKey = keyOf(range.low, range.high);
        let bin = bins.get(binKey);
        if (!bin) {
            bin = { samples: [], low: range.low, high: range.high };
            bins.set(binKey, bin);
        }
        bin.samples.push({ x: (range.x + 0.5) * cellSize, y: (range.y + 0.5) * cellSize });
    });
    const cellBrushes = [...bins.values()]
        .sort((a, b) => a.low - b.low || a.high - b.high)
        .map((bin) => ({
            type: 'brush' as const,
            samples: bin.samples,
            // Circumradius of a cell, so the union of discs covers every selected cell.
            radius: (cellSize * Math.SQRT2) / 2,
            heightRange: {
                min: bin.low * zBinSize - zMargin,
                max: bin.high * zBinSize + zMargin,
            },
            origin: 'transfer' as const,
        }));
    return [
        ...cellBrushes,
        ...mixedCellPointBrushes(positions, isGround, mixedGroundIndexes, mixedPointSpacing, zMargin),
    ];
}

/**
 * Transfers ground points of rejected cells on a fine voxel grid. A ground point is kept
 * only when no non-ground point within `spacing` in xy lies within `zMargin` of its
 * height; closer points (e.g. the very foot of a pillar) are ambiguous across frames.
 */
function mixedCellPointBrushes(
    positions: ArrayLike<number>,
    isGround: (index: number) => boolean,
    groundIndexes: number[],
    spacing: number,
    zMargin: number,
): GroundCorrectionMaskBrushOperation[] {
    if (groundIndexes.length === 0) return [];
    const keyOf = (x: number, y: number): string => `${x},${y}`;
    const nonGroundByCell = new Map<string, number[]>();
    const pointCount = Math.floor(positions.length / 3);
    for (let index = 0; index < pointCount; index++) {
        if (isGround(index)) continue;
        const x = positions[index * 3];
        const y = positions[index * 3 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(positions[index * 3 + 2])) continue;
        const key = keyOf(Math.floor(x / spacing), Math.floor(y / spacing));
        const bucket = nonGroundByCell.get(key);
        if (bucket) bucket.push(index);
        else nonGroundByCell.set(key, [index]);
    }
    const isNearNonGround = (x: number, y: number, z: number): boolean => {
        const cellX = Math.floor(x / spacing);
        const cellY = Math.floor(y / spacing);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const bucket = nonGroundByCell.get(keyOf(cellX + dx, cellY + dy));
                if (!bucket) continue;
                for (const index of bucket) {
                    if (Math.abs(positions[index * 3 + 2] - z) > zMargin) continue;
                    const distanceX = positions[index * 3] - x;
                    const distanceY = positions[index * 3 + 1] - y;
                    if (distanceX * distanceX + distanceY * distanceY < spacing * spacing) return true;
                }
            }
        }
        return false;
    };
    const voxels = new Set<string>();
    const samplesByZBin = new Map<number, GroundCorrectionMaskPoint[]>();
    groundIndexes.forEach((index) => {
        const x = positions[index * 3];
        const y = positions[index * 3 + 1];
        const z = positions[index * 3 + 2];
        const voxelX = Math.floor(x / spacing);
        const voxelY = Math.floor(y / spacing);
        const zBin = Math.floor(z / spacing);
        const voxelKey = `${voxelX},${voxelY},${zBin}`;
        if (voxels.has(voxelKey) || isNearNonGround(x, y, z)) return;
        voxels.add(voxelKey);
        const sample = { x: (voxelX + 0.5) * spacing, y: (voxelY + 0.5) * spacing };
        const samples = samplesByZBin.get(zBin);
        if (samples) samples.push(sample);
        else samplesByZBin.set(zBin, [sample]);
    });
    return [...samplesByZBin.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([zBin, samples]) => ({
            type: 'brush' as const,
            samples,
            radius: (spacing * Math.SQRT2) / 2,
            heightRange: { min: zBin * spacing - zMargin, max: (zBin + 1) * spacing + zMargin },
            origin: 'transfer' as const,
        }));
}

export function transformGroundCorrectionMaskOperation(
    operation: GroundCorrectionMaskOperation,
    sourcePose: GroundCorrectionMaskPose,
    targetPose: GroundCorrectionMaskPose,
): GroundCorrectionMaskOperation {
    const sourceMatrix = poseMatrix(sourcePose);
    const targetInverse = invertRigidTransform(poseMatrix(targetPose));
    const transform = multiplyTransforms(targetInverse, sourceMatrix);
    const origin = operation.origin ? { origin: operation.origin } : {};
    if (operation.type === 'polygon') {
        return {
            type: 'polygon',
            vertices: operation.vertices.map((point) => transformPoint(point, transform)),
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
            ...origin,
        };
    }
    if (operation.type === 'cluster') {
        return {
            type: 'cluster',
            points: operation.points.map((point) => transformClusterPoint(point, transform)),
            radius: operation.radius,
            ...origin,
        };
    }
    if (operation.samples) {
        return {
            type: 'brush',
            samples: operation.samples.map((point) => transformPoint(point, transform)),
            radius: operation.radius,
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
            ...(operation.erase ? { erase: true as const } : {}),
            ...origin,
        };
    }
    return {
        type: 'brush',
        center: transformPoint(operation.center!, transform),
        radius: operation.radius,
        ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
        ...(operation.erase ? { erase: true as const } : {}),
        ...origin,
    };
}

/**
 * Operations generated from a frame's final ground state during propagation. Masks saved
 * before origins existed carry them untagged; those are recognized by the radii that
 * propagation produces (cell circumradii), which hand-drawn brushes do not use.
 */
export function isGroundTransferOperation(
    operation: GroundCorrectionMaskOperation,
    legacyTransferRadii: readonly number[],
): boolean {
    if (operation.origin) return operation.origin === 'transfer';
    return (
        operation.type === 'brush' &&
        !operation.erase &&
        !!operation.samples &&
        !!operation.heightRange &&
        legacyTransferRadii.some((radius) => Math.abs(operation.radius - radius) < 1e-9)
    );
}

/**
 * Target operations after a propagation. Earlier propagation results are replaced rather
 * than appended, so repeated or chained propagation does not grow the mask; operations
 * drawn on the target itself are kept and still precede (lose to) the propagated ones.
 * Untagged target operations identical to a propagated one are legacy copies of the same
 * source operation and are dropped as well.
 */
export function replacePropagatedOperations(
    targetOperations: readonly GroundCorrectionMaskOperation[],
    propagatedOperations: readonly GroundCorrectionMaskOperation[],
    legacyTransferRadii: readonly number[],
): GroundCorrectionMaskOperation[] {
    const propagatedKeys = new Set(propagatedOperations.map(operationGeometryKey));
    return [
        ...targetOperations.filter(
            (operation) =>
                !operation.origin &&
                !isGroundTransferOperation(operation, legacyTransferRadii) &&
                !propagatedKeys.has(operationGeometryKey(operation)),
        ),
        ...propagatedOperations,
    ].map(cloneOperation);
}

/** Origin-independent identity at millimetre precision, so pose round-off still matches. */
function operationGeometryKey(operation: GroundCorrectionMaskOperation): string {
    const value = (number: number): string => number.toFixed(3);
    const point = (sample: GroundCorrectionMaskPoint): string => `${value(sample.x)},${value(sample.y)}`;
    const range = (heightRange: GroundCorrectionMaskHeightRange | undefined): string =>
        heightRange ? `${value(heightRange.min)}..${value(heightRange.max)}` : '';
    if (operation.type === 'polygon') {
        return `polygon|${range(operation.heightRange)}|${operation.vertices.map(point).join(';')}`;
    }
    if (operation.type === 'cluster') {
        return `cluster|${value(operation.radius)}|${operation.points
            .map((sample) => `${point(sample)},${value(sample.z)}`)
            .join(';')}`;
    }
    const samples = operation.samples || (operation.center ? [operation.center] : []);
    return `brush|${operation.erase ? 'erase' : ''}|${value(operation.radius)}|${range(operation.heightRange)}|${samples
        .map(point)
        .join(';')}`;
}

export function getContiguousPropagationFrameIds(
    frames: FrameWithId[],
    sourceIndex: number,
    distance: number,
    poses: Record<string, GroundCorrectionMaskPose>,
): PropagationFramesResult {
    return planGroundCorrectionMaskPropagation(frames, sourceIndex, distance, poses, {});
}

export function planGroundCorrectionMaskPropagation(
    frames: FrameWithId[],
    sourceIndex: number,
    distance: number,
    poses: Record<string, GroundCorrectionMaskPose>,
    segmentByFrameId: Record<string, string>,
): PropagationFramesResult {
    // Corrections only flow forward in time: frames after the source frame.
    const frameIds: string[] = [];
    const missingPoseFrameIds: string[] = [];
    const differentSegmentFrameIds: string[] = [];
    const sourceSegmentId = segmentByFrameId[String(frames[sourceIndex]?.id)];
    let blocked = false;
    for (let step = 1; step <= distance; step++) {
        const index = sourceIndex + step;
        if (index >= frames.length) break;
        const frameId = String(frames[index].id);
        if (blocked) {
            differentSegmentFrameIds.push(frameId);
            continue;
        }
        if (!poses[frameId]) {
            missingPoseFrameIds.push(frameId);
            blocked = true;
            continue;
        }
        if (!sourceSegmentId || segmentByFrameId[frameId] !== sourceSegmentId) {
            differentSegmentFrameIds.push(frameId);
            blocked = true;
            continue;
        }
        frameIds.push(frameId);
    }
    return { frameIds, missingPoseFrameIds, differentSegmentFrameIds };
}

export function mergePendingGroundCorrectionMask<T extends GroundCorrectionMaskOverlayObject>(
    objects: T[],
    pendingMask: T | null | undefined,
): T[] {
    if (pendingMask === undefined) return objects;
    const withoutMasks = objects.filter(
        (object) => object.objectType !== 'GROUND_CORRECTION_MASK',
    );
    return pendingMask ? [...withoutMasks, pendingMask] : withoutMasks;
}

export function formatGroundCorrectionMaskPropagationStatus(
    applied: number,
    selection: PropagationFramesResult,
    loadFailures: number,
): string {
    const details = [
        selection.missingPoseFrameIds.length
            ? `缺少 location 位姿 ${selection.missingPoseFrameIds.length} 帧`
            : '',
        selection.differentSegmentFrameIds.length
            ? `不同 location segment ${selection.differentSegmentFrameIds.length} 帧`
            : '',
        loadFailures ? `加载失败 ${loadFailures} 帧` : '',
    ].filter(Boolean);
    return details.length
        ? `已应用到 ${applied} 帧；${details.join('，')}，已跳过`
        : `已应用到后续 ${applied} 帧`;
}

function cloneOperation(operation: GroundCorrectionMaskOperation): GroundCorrectionMaskOperation {
    const origin = operation.origin ? { origin: operation.origin } : {};
    if (operation.type === 'polygon') {
        return {
            type: 'polygon',
            vertices: operation.vertices.map((point) => ({ ...point })),
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
            ...origin,
        };
    }
    if (operation.type === 'cluster') {
        return {
            type: 'cluster',
            points: operation.points.map((point) => ({ ...point })),
            radius: operation.radius,
            ...origin,
        };
    }
    return {
        type: 'brush',
        ...(operation.samples
            ? { samples: operation.samples.map((point) => ({ ...point })) }
            : { center: { ...operation.center! } }),
        radius: operation.radius,
        ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
        ...(operation.erase ? { erase: true as const } : {}),
        ...origin,
    };
}

function poseMatrix(pose: GroundCorrectionMaskPose): TransformMatrix {
    const roll = Number(pose.roll) || 0;
    const pitch = Number(pose.pitch) || 0;
    const yaw = Number(pose.yaw) || 0;
    const cx = Math.cos(roll);
    const sx = Math.sin(roll);
    const cy = Math.cos(pitch);
    const sy = Math.sin(pitch);
    const cz = Math.cos(yaw);
    const sz = Math.sin(yaw);
    return {
        rotation: [
            [cy * cz, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [cy * sz, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx],
        ],
        translation: [Number(pose.posX) || 0, Number(pose.posY) || 0, Number(pose.posZ) || 0],
    };
}

function invertRigidTransform(transform: TransformMatrix): TransformMatrix {
    const rotation = transform.rotation[0].map((_, row) =>
        transform.rotation.map((column) => column[row]),
    );
    return {
        rotation,
        translation: multiplyMatrixVector(rotation, transform.translation).map((value) => -value) as [
            number,
            number,
            number,
        ],
    };
}

function multiplyTransforms(left: TransformMatrix, right: TransformMatrix): TransformMatrix {
    const rotation = left.rotation.map((row) =>
        right.rotation[0].map((_, column) =>
            row.reduce((sum, value, index) => sum + value * right.rotation[index][column], 0),
        ),
    );
    const rotatedTranslation = multiplyMatrixVector(left.rotation, right.translation);
    return {
        rotation,
        translation: [
            rotatedTranslation[0] + left.translation[0],
            rotatedTranslation[1] + left.translation[1],
            rotatedTranslation[2] + left.translation[2],
        ],
    };
}

function transformPoint(point: GroundCorrectionMaskPoint, transform: TransformMatrix): GroundCorrectionMaskPoint {
    const transformed = multiplyMatrixVector(transform.rotation, [point.x, point.y, 0]);
    return {
        x: transformed[0] + transform.translation[0],
        y: transformed[1] + transform.translation[1],
    };
}

function transformClusterPoint(
    point: GroundCorrectionMaskClusterPoint,
    transform: TransformMatrix,
): GroundCorrectionMaskClusterPoint {
    const transformed = multiplyMatrixVector(transform.rotation, [point.x, point.y, point.z]);
    return {
        x: transformed[0] + transform.translation[0],
        y: transformed[1] + transform.translation[1],
        z: transformed[2] + transform.translation[2],
    };
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
    return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

