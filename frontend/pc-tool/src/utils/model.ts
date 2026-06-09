import * as api from '../api';
// import Editor from '../common/Editor';
import { IObject } from 'pc-editor';

export function pollModelTrack(
    recordId: string,
    targetDataIds: string[],
    onComplete: (e: Record<string, IObject[]>) => void,
    onErr?: () => void,
) {
    let stop = false;
    let hasErr = false;
    poll();
    return clear;

    async function poll() {
        let result;

        try {
            result = await request();
        } catch (error: any) {
            hasErr = true;
        }

        if (stop) return;

        if (hasErr) {
            onErr && onErr();
        } else {
            if (result) onComplete(result);
            else {
                setTimeout(poll, 1000);
            }
        }
    }

    function clear() {
        stop = true;
    }

    async function request() {
        let request = api.getModelResult(targetDataIds, recordId).then((data) => {
            data = data.data || {};
            let resultList = data.modelDataResults || [];
            if (resultList.length === 0) return;

            let objectsMap = {} as Record<string, IObject[]>;
            let completed = 0;
            resultList.forEach((dataResult: any) => {
                let dataId = String(dataResult.dataId);
                let modelResult = dataResult.modelResult || {};
                if (modelResult.code && modelResult.code !== 'OK') return;

                let objects = (modelResult.objects || []) as IObject[];
                if (objects.length === 0) return;

                objects.forEach((e: any) => {
                    e.trackId = e.trackingId || e.trackId;
                });
                objectsMap[dataId] = objects;
                completed++;
            });

            if (completed < targetDataIds.length) return;
            return objectsMap;
        });
        return request;
    }
}
