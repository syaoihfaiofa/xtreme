export type CacheCandidate = {
    index: number;
    distance: number;
    time: number;
    protected?: boolean;
    targeted?: boolean;
};

/** Returns the least useful entries first: farthest from navigation target, then oldest. */
export function orderEvictionCandidates(candidates: CacheCandidate[], keepTargeted: boolean = true) {
    return candidates
        .filter((candidate) => !candidate.protected && (!keepTargeted || !candidate.targeted))
        .sort((a, b) => b.distance - a.distance || a.time - b.time);
}

export function canEvict(candidate: CacheCandidate) {
    return !candidate.protected;
}

export function orderPrefetchIndices(indices: number[], fromIndex: number, direction: 1 | -1) {
    return [...indices].sort((a, b) => {
        const distance = Math.abs(a - fromIndex) - Math.abs(b - fromIndex);
        return distance || (direction > 0 ? b - a : a - b);
    });
}
