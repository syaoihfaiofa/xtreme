import * as THREE from 'three';
import { IObject, ObjectType } from 'pc-editor';

interface IKeypointLiftedCandidate extends IObject {
    sourceViewIndexes: number[];
    sourceKeypoints: number[][];
}

function isKeypointLiftedCandidate(candidate: IObject): candidate is IKeypointLiftedCandidate {
    const resultType: unknown = candidate.type;
    const objectType = candidate.objType || resultType;
    const sourceViewIndexes: unknown = candidate.sourceViewIndexes;
    const sourceKeypoints: unknown = candidate.sourceKeypoints;
    return (
        (objectType === ObjectType.TYPE_3D_BOX ||
            objectType === ObjectType.TYPE_GROUND_POLYLINE ||
            objectType === ObjectType.TYPE_GROUND_POLYGON) &&
        Array.isArray(sourceViewIndexes) &&
        Array.isArray(sourceKeypoints) &&
        sourceViewIndexes.length === sourceKeypoints.length &&
        sourceViewIndexes.every((viewIndex) => Number.isInteger(viewIndex) && viewIndex >= 0) &&
        sourceKeypoints.every(
            (keypoints) =>
                Array.isArray(keypoints) &&
                (objectType === ObjectType.TYPE_3D_BOX
                    ? keypoints.length === 8
                    : keypoints.length >= 4 && keypoints.length % 2 === 0) &&
                keypoints.every((value) => typeof value === 'number' && Number.isFinite(value)),
        )
    );
}

function toSourceAnnotation(
    candidate: IKeypointLiftedCandidate,
    viewIndex: number,
    keypoints: number[],
): IObject {
    const points: THREE.Vector2[] = [];
    for (let index = 0; index < keypoints.length; index += 2) {
        points.push(new THREE.Vector2(keypoints[index], keypoints[index + 1]));
    }
    return {
        objType: sourceObjectType(candidate),
        type: sourceObjectType(candidate),
        modelClass: candidate.modelClass,
        classType: candidate.classType || candidate.modelClass,
        confidence: candidate.confidence,
        // The 2D stitched overlay and its canonical 3D result deliberately
        // share a track id. This lets subsequent ground-polygon edits refresh
        // the prediction overlay in place instead of creating a second one.
        trackId: candidate.trackId,
        viewIndex,
        points,
        center3D: candidate.center3D,
        rotation3D: candidate.rotation3D,
        size3D: candidate.size3D,
    };
}

function sourceObjectType(candidate: IKeypointLiftedCandidate): ObjectType {
    const type = candidate.objType || candidate.type;
    if (type === ObjectType.TYPE_GROUND_POLYLINE) return ObjectType.TYPE_2D_GROUND_POLYLINE;
    if (type === ObjectType.TYPE_GROUND_POLYGON) return ObjectType.TYPE_2D_GROUND_POLYGON;
    return ObjectType.TYPE_2D_RECT;
}

export function expandKeypointLiftedCandidates(candidates: IObject[], stitchedViewIndex?: number): IObject[] {
    const objects: IObject[] = [];
    candidates.forEach((candidate, candidateIndex) => {
        // Model responses do not always carry persistent ids. Generate one
        // stable within this result set before conversion so its 3D object and
        // derived stitched projection can be linked by the normal projection
        // pipeline.
        const trackId = candidate.trackId || candidate.id ||
            `model-projection-${candidateIndex}-${candidate.modelClass || candidate.classType || 'object'}`;
        const linkedCandidate = { ...candidate, trackId };
        objects.push(linkedCandidate);
        if (!isKeypointLiftedCandidate(linkedCandidate)) return;

        linkedCandidate.sourceViewIndexes?.forEach((viewIndex, index) => {
            const targetViewIndex =
                (linkedCandidate.objType || linkedCandidate.type) === ObjectType.TYPE_GROUND_POLYGON &&
                stitchedViewIndex != null
                    ? stitchedViewIndex
                    : viewIndex;
            objects.push(toSourceAnnotation(linkedCandidate, targetViewIndex, linkedCandidate.sourceKeypoints[index]));
        });
    });
    return objects;
}
