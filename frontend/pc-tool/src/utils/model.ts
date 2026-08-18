import * as api from '../api';
// import Editor from '../common/Editor';
import { IObject } from 'pc-editor';

export function pollModelTrack(
    recordId: string,
    targetDataIds: string[],
    onComplete: (e: Record<string, IObject[]>) => void,
    onErr?: () => void,
): () => void {
    let stop = false;
    let hasErr = false;
    let timer: number | undefined;
    void poll();
    return clear;

    async function poll(): Promise<void> {
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
                timer = window.setTimeout(() => {
                    timer = undefined;
                    void poll();
                }, 1000);
            }
        }
    }

    function clear(): void {
        stop = true;
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timer = undefined;
        }
    }

    async function request(): Promise<Record<string, IObject[]> | undefined> {
        let request = api.getModelResult(targetDataIds, recordId).then((data) => {
            data = data.data || {};
            let resultList = data.modelDataResults || [];
            if (resultList.length === 0) return;

            let objectsMap = {} as Record<string, IObject[]>;
            let completed = 0;
            resultList.forEach((dataResult: any) => {
                let dataId = String(dataResult.dataId);
                let modelResult = dataResult.modelResult || {};
                if (modelResult.code && modelResult.code !== 'OK') {
                    throw new Error(modelResult.message || `Tracking failed for frame ${dataId}`);
                }

                let objects = (modelResult.objects || []) as IObject[];
                objects.forEach((e: any) => {
                    e.trackId = e.trackingId || e.trackId;
                });
                if (objects.length > 0) objectsMap[dataId] = objects;
                completed++;
            });

            if (completed < targetDataIds.length) return;
            return objectsMap;
        });
        return request;
    }
}
