import { IObject } from '../type';

export function sameAnnotationClass(
    a?: { classId?: unknown; classType?: string; name?: string },
    b?: { classId?: unknown; classType?: string; name?: string },
): boolean {
    if (!a || !b) return false;
    if (a.classId != null && a.classId !== '' && b.classId != null && b.classId !== '') {
        return String(a.classId) === String(b.classId);
    }
    const aType = a.classType || a.name;
    const bType = b.classType || b.name;
    return !!aType && !!bType && aType === bType;
}

export function lookupByFrameId<T>(
    map: Record<string, T> | undefined,
    frameId: string | number,
): T | undefined {
    if (!map || frameId == null || frameId === '') return undefined;
    if (map[frameId as string] !== undefined) return map[frameId as string];
    if (map[String(frameId)] !== undefined) return map[String(frameId)];
    const asNumber = Number(frameId);
    if (!Number.isNaN(asNumber) && map[asNumber as unknown as string] !== undefined) {
        return map[asNumber as unknown as string];
    }
    return undefined;
}

export function objectsMapForFrame<T>(
    objectsMap: Record<string, T[]> | undefined,
    frameId: string | number,
): T[] {
    return lookupByFrameId(objectsMap, frameId) || [];
}

export function getTrackFromObject(info: Record<string, IObject[]>) {
    let globalTrack = {} as Record<string, Partial<IObject>>;
    // let frameTrack = {} as Record<string, Record<string, Partial<IObject>>>;

    Object.keys(info).forEach((frameId) => {
        let objects = info[frameId] || [];

        // frameTrack[frameId] = frameTrack[frameId] || {};

        objects.forEach((obj) => {
            let trackId = obj.trackId as string;

            if (!globalTrack[trackId]) {
                globalTrack[trackId] = {
                    trackName: obj.trackName,
                    trackId: obj.trackId,
                    classType: obj.classType,
                    classId: obj.classId,
                    resultType: obj.resultType,
                };
            } else {
                const global = globalTrack[trackId];
                if (!obj.trackName) obj.trackName = global.trackName;
                if (!obj.resultType) obj.resultType = global.resultType;
            }
        });
    });

    return { globalTrack };
}
