export const INSTANCE_VISIBILITY_TYPES = [
    '3d-box',
    'polygon',
    'polyline',
    'irregular-wall',
] as const;

export type InstanceVisibilityType = typeof INSTANCE_VISIBILITY_TYPES[number];
export type InstanceVisibilityScope = 'current-frame' | 'all-frames';

export interface IInstanceVisibilityFilter {
    allFrames: InstanceVisibilityType[];
    frames: Record<string, InstanceVisibilityType[]>;
}

export function createInstanceVisibilityFilter(): IInstanceVisibilityFilter {
    return {
        allFrames: [],
        frames: {},
    };
}

export function getHiddenInstanceTypes(
    filter: IInstanceVisibilityFilter,
    frameId: string,
): InstanceVisibilityType[] {
    return [...new Set([...filter.allFrames, ...(filter.frames[frameId] || [])])];
}

export function getScopeHiddenInstanceTypes(
    filter: IInstanceVisibilityFilter,
    scope: InstanceVisibilityScope,
    frameId: string,
): InstanceVisibilityType[] {
    return scope === 'all-frames' ? filter.allFrames : filter.frames[frameId] || [];
}

export function setInstanceTypeHidden(
    filter: IInstanceVisibilityFilter,
    scope: InstanceVisibilityScope,
    frameId: string,
    type: InstanceVisibilityType,
    hidden: boolean,
): IInstanceVisibilityFilter {
    const types = getScopeHiddenInstanceTypes(filter, scope, frameId);
    const nextTypes = hidden
        ? types.includes(type)
            ? types
            : [...types, type]
        : types.filter((item) => item !== type);

    if (scope === 'all-frames') {
        return {
            allFrames: nextTypes,
            frames: filter.frames,
        };
    }

    return {
        allFrames: filter.allFrames,
        frames: {
            ...filter.frames,
            [frameId]: nextTypes,
        },
    };
}
