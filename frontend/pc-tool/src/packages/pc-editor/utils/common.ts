import { IFrame, IFileConfig } from '../type';
import { IImgViewConfig, IUserData } from 'pc-editor';
import DataManager from '../common/DataManager';
import * as THREE from 'three';

export function isMatrixColumnMajor(elements: number[]) {
    let rightZero = elements[3] === 0 && elements[7] === 0 && elements[11] === 0;
    let bottomHasOne = !!elements[12] || !!elements[13] || !!elements[14];
    return rightZero && bottomHasOne;
}

export function translateCameraConfig(info: any) {
    let cameraExternal = info?.cameraExternal || info?.camera_external;
    let cameraInternal = info?.cameraInternal || info?.camera_internal;
    let cameraModel = info?.cameraModel || info?.camera_model || 'pinhole';
    let distortion = info?.distortion || info?.cameraDistortion || info?.camera_distortion;

    if (!info || !cameraExternal || cameraExternal.length !== 16) return null;

    // to rowMajor
    if (info.rowMajor === false || isMatrixColumnMajor(cameraExternal)) {
        let matrix = new THREE.Matrix4();
        matrix.elements = cameraExternal;
        matrix.transpose();
        cameraExternal = matrix.elements;
    }

    return { cameraExternal, cameraInternal, cameraModel, distortion };
}

function extractCameraIndex(key: string, info?: any): number {
    const keyMatch = key.match(/(\d+)\s*$/);
    if (keyMatch) {
        return parseInt(keyMatch[1], 10);
    }
    const cameraName = info?.cameraName || info?.camera_name || '';
    const nameMatch = cameraName.match(/(\d+)/);
    if (nameMatch) {
        return parseInt(nameMatch[1], 10);
    }
    return Number.MAX_SAFE_INTEGER;
}

export function normalizeCameraInfoList(cameraInfo: any[] | Record<string, any>): any[] {
    if (Array.isArray(cameraInfo)) {
        if (cameraInfo.length === 1 && Array.isArray(cameraInfo[0])) {
            return cameraInfo[0];
        }
        return cameraInfo;
    }
    return Object.entries(cameraInfo || {})
        .sort(([keyA, valueA], [keyB, valueB]) =>
            extractCameraIndex(keyA, valueA) - extractCameraIndex(keyB, valueB),
        )
        .map(([, value]) => value);
}

export function clamRange(v: number, min: number, max: number) {
    return Math.max(Math.min(max, v), min);
}

export function createViewConfig(fileConfig: IFileConfig[], cameraInfo: any[]) {
    let viewConfig = [] as IImgViewConfig[];
    let pointsUrl = '';
    const regLidar = new RegExp(/point(_?)cloud/i);
    const regImage = new RegExp(/camera(_?)image/i);
    fileConfig.forEach((e) => {
        if (regLidar.test(e.dirName)) {
            pointsUrl = e.url;
        } else if (regImage.test(e.dirName)) {
            const match = e.dirName.match(/[0-9]{1,5}$/);
            if (!match) return;
            const index = +match[0];
            viewConfig[index] = {
                cameraInternal: { fx: 0, fy: 0, cx: 0, cy: 0 },
                cameraExternal: [],
                cameraModel: 'pinhole',
                imgSize: [0, 0],
                imgUrl: e.url,
                name: e.name,
                imgObject: null as any,
            };
        }
    });
    viewConfig = viewConfig.filter((e) => !!e);
    for (let index = 0; index < viewConfig.length; index++) {
        const config = viewConfig[index];
        if (!config) continue;
        const info = cameraInfo[index];
        if (!info) continue;

        let translateInfo = translateCameraConfig(info);
        if (!translateInfo) continue;

        config.cameraExternal = translateInfo.cameraExternal;
        config.cameraInternal = translateInfo.cameraInternal;
        config.cameraModel = translateInfo.cameraModel;
        config.distortion = translateInfo.distortion;
        config.imgSize = [info.width, info.height];
    }

    // Keep camera views that have image URLs even without calibration (display-only).
    viewConfig = viewConfig.filter((e) => !!e.imgUrl);

    return { pointsUrl, config: viewConfig };
}

export function rand(start: number, end: number) {
    return (Math.random() * (end - start) + start) | 0;
}

export function empty(value: any) {
    return value === null || value === undefined || value === '';
}

export function queryStr(data: Record<string, any> = {}) {
    let queryArr = [] as string[];
    Object.keys(data).forEach((name) => {
        let value = data[name];
        if (Array.isArray(value)) {
            queryArr.push(`${name}=${value.join(',')}`);
        } else {
            queryArr.push(`${name}=${value}`);
        }
    });

    return queryArr.join('&');
}

export function getTrackObject(dataInfos: IFrame[], dataManager: DataManager) {
    let trackObjects = {} as Record<string, { id: string; name: string }[]>;
    let idMap = {} as Record<string, boolean>;

    let maxNum = 0;
    dataInfos.forEach((data) => {
        let objects = dataManager.getFrameObject(data.id) || [];
        objects.forEach((object) => {
            let userData = object.userData as IUserData;
            let trackName = userData.trackName;
            let trackId = userData.trackId;
            if (!trackName || !trackId) return;

            let trackNumber = parseInt(trackName);
            if (isNaN(trackNumber)) return;

            let id = `${trackName}####${trackId}`;
            if (idMap[id]) return;

            maxNum = Math.max(maxNum, trackNumber);
            if (!trackObjects[trackNumber]) {
                trackObjects[trackNumber] = [];
            }

            trackObjects[trackNumber].push({ id: trackId, name: trackName });
            idMap[id] = true;
        });
    });

    let list = [] as { id: string; name: string }[];

    [...Array(maxNum + 1)].forEach((e, index) => {
        let objects = trackObjects[index];
        if (objects) {
            list.push(...objects);
        }
    });

    return list;
}

export function formatNumDot(str: string | number, precision: number = 2): string {
    str = '' + str;
    let regex = /(?!^)(?=(\d{3})+(\.|$))/g;
    str.replace(regex, ',');

    if (precision) {
        return (+str).toFixed(precision);
    } else {
        return str;
    }
}

export function formatNumStr(str: string | number, precision: number = 2): string {
    str = '' + str;
    if (precision) {
        return (+str).toFixed(precision);
    } else {
        return str;
    }
}

export function pickAttrs(obj: any, attrs: string[]) {
    let newObj = {};
    attrs.forEach((attr) => {
        newObj[attr] = obj[attr];
    });
    return newObj;
}
