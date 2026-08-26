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
    return (
        hits.find((hit) => {
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
        }) ?? null
    );
}
