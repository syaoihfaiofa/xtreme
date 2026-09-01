export interface ISnapHeightReference {
    anchorZ: number;
    neighborZs: readonly number[];
}

interface IPointCloudHit {
    point: {
        z: number;
    };
}

const MAX_ANCHOR_Z_DELTA_METERS = 0.5;
const MAX_ADDITIONAL_NEIGHBOR_Z_DELTA_METERS = 0.5;

export function selectHeightContinuousHit<T extends IPointCloudHit>(
    hits: readonly T[],
    reference: ISnapHeightReference,
): T | null {
    return hits.find((hit) => isHeightContinuous(hit, reference)) ?? null;
}

/**
 * Choose a ground-facing snap target while extending a line from either end.
 *
 * Raycast intersections are ordered by distance to the camera.  From an
 * overhead view that commonly puts a roof ahead of the road, so merely taking
 * the first height-continuous hit can extend a ground line onto the roof.  The
 * existing continuity limits still protect elevated lines; among their valid
 * candidates this deliberately chooses the lowest surface.
 */
export function selectGroundPreferredContinuousHit<T extends IPointCloudHit>(
    hits: readonly T[],
    reference: ISnapHeightReference,
): T | null {
    let selected: T | null = null;
    for (const hit of hits) {
        if (!isHeightContinuous(hit, reference)) continue;
        if (!selected || hit.point.z < selected.point.z) {
            selected = hit;
        }
    }
    return selected;
}

function isHeightContinuous<T extends IPointCloudHit>(
    hit: T,
    reference: ISnapHeightReference,
): boolean {
    const candidateZ = hit.point.z;
    if (Math.abs(candidateZ - reference.anchorZ) > MAX_ANCHOR_Z_DELTA_METERS) {
        return false;
    }
    return reference.neighborZs.every(
        (neighborZ) =>
            Math.abs(candidateZ - neighborZ) <=
            Math.abs(reference.anchorZ - neighborZ) +
                MAX_ADDITIONAL_NEIGHBOR_Z_DELTA_METERS,
    );
}
