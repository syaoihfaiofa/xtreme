import type {
    GroundCorrectionMask,
    GroundCorrectionMaskOperation,
    GroundCorrectionMaskClusterPoint,
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

export function transformGroundCorrectionMaskOperation(
    operation: GroundCorrectionMaskOperation,
    sourcePose: GroundCorrectionMaskPose,
    targetPose: GroundCorrectionMaskPose,
): GroundCorrectionMaskOperation {
    const sourceMatrix = poseMatrix(sourcePose);
    const targetInverse = invertRigidTransform(poseMatrix(targetPose));
    const transform = multiplyTransforms(targetInverse, sourceMatrix);
    if (operation.type === 'polygon') {
        return {
            type: 'polygon',
            vertices: operation.vertices.map((point) => transformPoint(point, transform)),
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
        };
    }
    if (operation.type === 'cluster') {
        return {
            type: 'cluster',
            points: operation.points.map((point) => transformClusterPoint(point, transform)),
            radius: operation.radius,
        };
    }
    if (operation.samples) {
        return {
            type: 'brush',
            samples: operation.samples.map((point) => transformPoint(point, transform)),
            radius: operation.radius,
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
            ...(operation.erase ? { erase: true as const } : {}),
        };
    }
    return {
        type: 'brush',
        center: transformPoint(operation.center!, transform),
        radius: operation.radius,
        ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
        ...(operation.erase ? { erase: true as const } : {}),
    };
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
    const previousFrameIds: string[] = [];
    const nextFrameIds: string[] = [];
    const missingPoseFrameIds: string[] = [];
    const differentSegmentFrameIds: string[] = [];
    const sourceSegmentId = segmentByFrameId[String(frames[sourceIndex]?.id)];
    for (const direction of [-1, 1] as const) {
        let blocked = false;
        for (let step = 1; step <= distance; step++) {
            const index = sourceIndex + direction * step;
            if (index < 0 || index >= frames.length) break;
            const frame = frames[index];
            const frameId = String(frame.id);
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
            (direction < 0 ? previousFrameIds : nextFrameIds).push(frameId);
        }
    }
    return {
        frameIds: previousFrameIds.reverse().concat(nextFrameIds),
        missingPoseFrameIds,
        differentSegmentFrameIds,
    };
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
        : `已应用到前后 ${applied} 帧`;
}

function cloneOperation(operation: GroundCorrectionMaskOperation): GroundCorrectionMaskOperation {
    if (operation.type === 'polygon') {
        return {
            type: 'polygon',
            vertices: operation.vertices.map((point) => ({ ...point })),
            ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
        };
    }
    if (operation.type === 'cluster') {
        return {
            type: 'cluster',
            points: operation.points.map((point) => ({ ...point })),
            radius: operation.radius,
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

