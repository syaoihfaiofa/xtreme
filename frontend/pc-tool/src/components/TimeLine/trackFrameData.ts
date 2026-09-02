import { ObjectType } from 'pc-editor';

interface ITrackFrameObject {
    objectType?: ObjectType | string;
    objType?: ObjectType | string;
    type?: ObjectType | string;
    userData?: {
        isProjection?: boolean;
    };
}

export function getPrimaryTrackFrameObject<T extends ITrackFrameObject>(
    objects: T[],
): T | undefined {
    // Timeline state, including occlusion, belongs exclusively to the point-cloud
    // annotation. Image projections share a trackId but are display-only and may
    // retain an older copy of userData.
    return objects.find((object) => {
        const objectType = object.objectType || object.objType || object.type;
        return (
            objectType === ObjectType.TYPE_3D ||
            objectType === ObjectType.TYPE_3D_BOX ||
            objectType === ObjectType.TYPE_GROUND_POLYGON ||
            objectType === ObjectType.TYPE_GROUND_POLYLINE
        );
    });
}
