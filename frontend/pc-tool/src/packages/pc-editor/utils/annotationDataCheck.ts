import * as THREE from 'three';
import { Box } from 'pc-render';

import { ClassSizePrior } from '../../../config/annotationDataCheckConfig';
import { ANNOTATION_DATA_CHECK_CONFIG, AnnotationDataCheckRuntimeConfig } from '../../../config/annotationDataCheck.runtime';
import { computeBevIoU } from './iou';

export interface AnnotationDataCheckConfig {
    minDim: number;
    iouThreshold: number;
}

export const DEFAULT_ANNOTATION_DATA_CHECK_CONFIG: AnnotationDataCheckConfig = {
    minDim: ANNOTATION_DATA_CHECK_CONFIG.minDim,
    iouThreshold: ANNOTATION_DATA_CHECK_CONFIG.iouThreshold,
};

export interface AnnotationBoxCheckInput {
    box: Box;
    className: string;
    trackId?: string;
}

export interface AnnotationBoxSizeFinding {
    code: 'INVALID_SIZE' | 'SIZE_PRIOR' | 'ASPECT';
    message: string;
}

export interface AnnotationOverlapFinding {
    code: 'OVERLAP';
    message: string;
    primaryBox: Box;
    secondaryBox: Box;
}

export function normalizeAnnotationClassName(className?: string): string {
    return (className || '').trim().toLowerCase();
}

export function resolveAnnotationClassName(
    className: string | undefined,
    runtimeConfig: AnnotationDataCheckRuntimeConfig,
): string {
    const normalized = normalizeAnnotationClassName(className);
    if (!normalized) {
        return normalized;
    }
    return runtimeConfig.classAliases[normalized] || normalized;
}

function overlapPairKey(leftClass: string, rightClass: string): string {
    const pair = [leftClass, rightClass].sort();
    return `${pair[0]}::${pair[1]}`;
}

function zOverlap(a: Box, b: Box): number {
    const lo = Math.max(a.position.z - a.scale.z / 2, b.position.z - b.scale.z / 2);
    const hi = Math.min(a.position.z + a.scale.z / 2, b.position.z + b.scale.z / 2);
    return hi - lo;
}

function checkSizePrior(
    cls: string,
    length: number,
    width: number,
    height: number,
    prior: ClassSizePrior,
): AnnotationBoxSizeFinding[] {
    const findings: AnnotationBoxSizeFinding[] = [];
    const checks: Array<{ name: string; value: number; range: { min: number; max: number } }> = [
        { name: 'l', value: length, range: prior.length },
        { name: 'w', value: width, range: prior.width },
        { name: 'h', value: height, range: prior.height },
    ];
    checks.forEach(({ name, value, range }) => {
        if (value < range.min || value > range.max) {
            findings.push({
                code: 'SIZE_PRIOR',
                message:
                    `${cls} ${name}=${value.toFixed(2)} outside [${range.min.toFixed(2)}, ${range.max.toFixed(2)}] ` +
                    `(box ${length.toFixed(2)} x ${width.toFixed(2)} x ${height.toFixed(2)})`,
            });
        }
    });
    return findings;
}

/**
 * The actual world-Z span of an oriented box.  This is intentionally kept
 * separate from a pole's semantic H (its shaft length): a horizontal pole is
 * long, but occupies only roughly one diameter in the vertical direction.
 */
function getWorldVerticalSpan(box: Box, length: number, width: number, height: number): number {
    const rotation = new THREE.Matrix4().makeRotationFromEuler(box.rotation);
    const elements = rotation.elements;
    return (
        Math.abs(elements[2]) * length +
        Math.abs(elements[6]) * width +
        Math.abs(elements[10]) * height
    );
}

function getSizeForClass(
    cls: string,
    box: Box,
): { length: number; width: number; height: number; verticalSpan?: number } {
    const dimensions = [box.scale.x, box.scale.y, box.scale.z];
    if (cls !== 'pole') {
        return { length: dimensions[0], width: dimensions[1], height: dimensions[2] };
    }

    // Pole may be laid down, so local Z is not reliably its shaft.  Its two
    // shortest dimensions form the cross-section and the longest is its H.
    const [length, width, height] = [...dimensions].sort((left, right) => left - right);
    return {
        length,
        width,
        height,
        verticalSpan: getWorldVerticalSpan(box, ...dimensions),
    };
}

export function checkAnnotationBoxSize(
    box: Box,
    className: string,
    config: AnnotationDataCheckConfig = DEFAULT_ANNOTATION_DATA_CHECK_CONFIG,
    runtimeConfig: AnnotationDataCheckRuntimeConfig = ANNOTATION_DATA_CHECK_CONFIG,
): AnnotationBoxSizeFinding[] {
    const findings: AnnotationBoxSizeFinding[] = [];
    const cls = resolveAnnotationClassName(className, runtimeConfig);
    const { length, width, height, verticalSpan } = getSizeForClass(cls, box);
    const dims = [length, width, height];

    if (!dims.every((value) => Number.isFinite(value) && value > 0)) {
        findings.push({
            code: 'INVALID_SIZE',
            message: `尺寸异常 (x=${length}, y=${width}, z=${height})`,
        });
        return findings;
    }

    if (Math.min(...dims) < config.minDim) {
        findings.push({
            code: 'INVALID_SIZE',
            message: `尺寸退化 ${length.toFixed(3)} x ${width.toFixed(3)} x ${height.toFixed(3)}`,
        });
        return findings;
    }

    const prior = runtimeConfig.sizePrior[cls];
    if (prior) {
        findings.push(
            ...checkSizePrior(cls, length, width, height, prior).map((finding) => ({
                ...finding,
                message:
                    verticalSpan == null
                        ? finding.message
                        : `${finding.message}；世界 Z 向高度 ${verticalSpan.toFixed(2)}m`,
            })),
        );
    }

    if (runtimeConfig.longAxisClasses.has(cls) && width > length) {
        findings.push({
            code: 'ASPECT',
            message: `${cls} wider than long (${length.toFixed(2)} x ${width.toFixed(2)}), yaw likely off 90 deg`,
        });
    }

    return findings;
}

export function checkAnnotationFrameOverlaps(
    boxes: AnnotationBoxCheckInput[],
    config: AnnotationDataCheckConfig = DEFAULT_ANNOTATION_DATA_CHECK_CONFIG,
    runtimeConfig: AnnotationDataCheckRuntimeConfig = ANNOTATION_DATA_CHECK_CONFIG,
): AnnotationOverlapFinding[] {
    const findings: AnnotationOverlapFinding[] = [];

    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const left = boxes[i];
            const right = boxes[j];
            const leftClass = resolveAnnotationClassName(left.className, runtimeConfig);
            const rightClass = resolveAnnotationClassName(right.className, runtimeConfig);
            if (runtimeConfig.overlapSkipPairs.has(overlapPairKey(leftClass, rightClass))) {
                continue;
            }

            const maxDistance =
                (left.box.scale.x +
                    left.box.scale.y +
                    right.box.scale.x +
                    right.box.scale.y) /
                2;
            const centerDistance = Math.hypot(
                left.box.position.x - right.box.position.x,
                left.box.position.y - right.box.position.y,
            );
            if (centerDistance > maxDistance) {
                continue;
            }

            const verticalOverlap = zOverlap(left.box, right.box);
            if (verticalOverlap <= 0) {
                continue;
            }

            const iou = computeBevIoU(left.box, right.box);
            if (iou < config.iouThreshold) {
                continue;
            }

            const leftTrack = left.trackId || '?';
            const rightTrack = right.trackId || '?';
            findings.push({
                code: 'OVERLAP',
                message:
                    `${leftClass}(${leftTrack}) and ${rightClass}(${rightTrack}) overlap, ` +
                    `BEV IoU ${iou.toFixed(2)}, z-overlap ${verticalOverlap.toFixed(2)} m`,
                primaryBox: left.box,
                secondaryBox: right.box,
            });
        }
    }

    return findings;
}
