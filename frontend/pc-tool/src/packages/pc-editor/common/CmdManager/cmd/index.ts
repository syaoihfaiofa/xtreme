import * as THREE from 'three';
import type { ITransform, AnnotateObject, Rect, Box2D } from 'pc-render';
import AddObject, { IAddObjectOption } from './AddObject';
import DeleteObject, { IDeleteObjectOption } from './DeleteObject';
import UpdateTransform from './UpdateTransform';
import Update2DRect from './Update2DRect';
import Update2DBox from './Update2DBox';
import SelectObject from './SelectObject';
import UpdateObjectDataBatch, { IUpdateObjectUserDataOption } from './UpdateObjectUserData';
import ToggleVisible, { IToggleVisibleOption } from './ToggleVisible';
import UpdateTransformBatch, { IUpdateTransformBatchOption } from './UpdateTransformBatch';
import UpdateTrackDataBatch, {
    ITrackOption,
    IUpdateTrackBatchOption,
} from './UpdateTrackDataBatch';
import UpdateTrackData from './UpdateTrackData';
import DeleteTrack, { IDeleteTrackOption } from './DeleteTrack';
import AddTrack, { IAddTrackOption } from './AddTrack';
import UpdateGroundPolygonPoints from './UpdateGroundPolygonPoints';
import UpdateGroundPolylinePoints from './UpdateGroundPolylinePoints';
import InsertGroundPolylinePoint from './InsertGroundPolylinePoint';
import UpdateGroundPolylineHeight from './UpdateGroundPolylineHeight';
import UpdateGroundPolylineSegmentVisibility from './UpdateGroundPolylineSegmentVisibility';
import UpdateGroundPolylineVisibilityRange from './UpdateGroundPolylineVisibilityRange';
export interface ICmdOption {
    'add-object': IAddObjectOption;
    'delete-object': IDeleteObjectOption;
    'select-object': AnnotateObject | AnnotateObject[] | undefined;
    'update-transform': {
        object: THREE.Object3D;
        transform: ITransform;
    };
    'update-ground-polygon-points': {
        object: import('pc-render').GroundPolygon;
        points: THREE.Vector3[];
    };
    'update-ground-polyline-points': {
        object: import('pc-render').GroundPolyline;
        points: THREE.Vector3[];
    };
    'insert-ground-polyline-point': {
        object: import('pc-render').GroundPolyline;
        segmentIndex: number;
        point: THREE.Vector3;
    };
    'update-ground-polyline-height': {
        object: import('pc-render').GroundPolyline;
        wallHeight: number;
    };
    'update-ground-polyline-segment-visibility': {
        object: import('pc-render').GroundPolyline;
        viewKey: string;
        segmentVisible: boolean[];
    };
    'update-ground-polyline-visibility-range': {
        object: import('pc-render').GroundPolyline;
        points: THREE.Vector3[];
        byView: Record<string, boolean[]>;
        forceVisibleByView: Record<string, boolean[]>;
    };
    'update-2d-rect': {
        object: Rect;
        option: { center: THREE.Vector2; size?: THREE.Vector2 };
    };
    'update-2d-box': {
        object: Box2D;
        option: {
            positions1?: Record<number, THREE.Vector2>;
            positions2?: Record<number, THREE.Vector2>;
        };
    };
    'update-object-user-data': IUpdateObjectUserDataOption;
    'toggle-visible': IToggleVisibleOption;
    'update-transform-batch': IUpdateTransformBatchOption;
    'update-track-data-batch': IUpdateTrackBatchOption;
    'update-track-data': ITrackOption;
    'delete-track': IDeleteTrackOption;
    'add-track': IAddTrackOption;
}

type Name = keyof ICmdOption;

const CMD: Record<Name, any> = {
    'add-object': AddObject,
    'select-object': SelectObject,
    'delete-object': DeleteObject,
    'update-transform': UpdateTransform,
    'update-ground-polygon-points': UpdateGroundPolygonPoints,
    'update-ground-polyline-points': UpdateGroundPolylinePoints,
    'insert-ground-polyline-point': InsertGroundPolylinePoint,
    'update-ground-polyline-height': UpdateGroundPolylineHeight,
    'update-ground-polyline-segment-visibility': UpdateGroundPolylineSegmentVisibility,
    'update-ground-polyline-visibility-range': UpdateGroundPolylineVisibilityRange,
    'update-2d-rect': Update2DRect,
    'update-2d-box': Update2DBox,
    'update-object-user-data': UpdateObjectDataBatch,
    'toggle-visible': ToggleVisible,
    'update-transform-batch': UpdateTransformBatch,
    'update-track-data-batch': UpdateTrackDataBatch,
    'update-track-data': UpdateTrackData,
    'delete-track': DeleteTrack,
    'add-track': AddTrack,
};

export default CMD;
