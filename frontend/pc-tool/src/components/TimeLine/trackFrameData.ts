interface ITrackFrameObject {
    userData?: {
        isProjection?: boolean;
    };
}

export function getPrimaryTrackFrameObject<T extends ITrackFrameObject>(
    objects: T[],
): T | undefined {
    return objects.find((object) => object.userData?.isProjection !== true) ?? objects[0];
}
