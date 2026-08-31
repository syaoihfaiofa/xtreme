import { get, post } from './base';
import { IClassType, AttrType, IResultSource, SourceType } from 'pc-editor';
import {
    IFrame,
    IFileConfig,
    IObject,
    IModel,
    IClassificationAttr,
    IClassification,
    IModelResult,
} from 'pc-editor';
import { utils } from 'pc-editor';
// import { empty, queryStr } from '../utils';
// import { traverseClassification2Arr } from '../utils/classification';
// import BSError from '../common/BSError';
import * as THREE from 'three';
import { IDataSetInfo } from '../type';

let { empty, queryStr, traverseClassification2Arr, traverseClass2Arr } = utils;

const EMPTY_OBJECT_RESULT = {
    objectsMap: {} as Record<string, IObject[]>,
    classificationMap: {} as Record<string, Record<string, string>>,
    queryTime: Date.now(),
};

function normalizeDataIds(dataIds: string[] | string | number | undefined): string[] {
    const raw = Array.isArray(dataIds) ? dataIds : [dataIds];
    return raw
        .map((id) => (id == null ? '' : String(id).trim()))
        .filter((id) => id.length > 0 && id !== 'undefined' && id !== 'null');
}

export async function getUrl(url: string) {
    return get(url, null, { headers: { 'x-request-type': 'resource' } });
}

export async function saveObject(config: any) {
    let url = '/api/annotate/data/save';
    let data = await post(url, config);
    data = data.data || [];
    let keyMap = {} as Record<string, Record<string, string>>;
    data.forEach((e: any) => {
        let dataId = e.dataId;
        keyMap[dataId] = keyMap[dataId] || {};
        keyMap[dataId][e.frontId] = e.id;
    });

    return keyMap;
}

export interface ISyncObjectResult {
    affectedDataIds: Array<string | number>;
    syncVersion: number;
}

export async function syncObject(
    dataId: string,
    trackId: string,
    classId?: string | number,
): Promise<ISyncObjectResult> {
    const params: { dataId: string; trackId: string; classId?: string | number } = { dataId, trackId };
    if (classId != null && classId !== '') params.classId = classId;
    const response = await post('/api/annotate/data/sync', null, { params });
    const result = response?.data || response || {};
    return {
        affectedDataIds: Array.isArray(result.affectedDataIds) ? result.affectedDataIds : [],
        syncVersion: Number(result.syncVersion) || Date.now(),
    };
}

export async function deleteTrack(dataId: string, trackId: string): Promise<void> {
    await post('/api/annotate/data/track/delete', null, { params: { dataId, trackId } });
}

export async function getSyncSegments(
    dataId: string,
    trackId: string,
): Promise<Record<string, number>> {
    const response = await get<{ data?: Record<string, number> }>(
        '/api/annotate/data/sync/segments',
        { dataId, trackId },
    );
    return response.data || {};
}

export async function reviewTrack(dataId: string, trackId: string, reviewedCorrect: boolean) {
    return await post('/api/annotate/data/review', null, {
        params: { dataId, trackId, reviewedCorrect },
    });
}

export async function getDataObjectBatch(dataIds: string[] | string | number) {
    const normalizedIds = normalizeDataIds(dataIds);
    if (normalizedIds.length === 0) {
        return { ...EMPTY_OBJECT_RESULT, queryTime: Date.now() };
    }
    const batchSize = 200;
    const pendingIds = [...normalizedIds];
    const requests: ReturnType<typeof getDataObject>[] = [];
    while (pendingIds.length > 0) {
        const batchIds = pendingIds.splice(0, batchSize);
        requests.push(getDataObject(batchIds));
    }
    return Promise.all(requests).then((res) => {
        return res.reduce(
            (map, item) => {
                Object.assign(map.objectsMap, item.objectsMap || {});
                Object.assign(map.classificationMap, item.classificationMap || {});
                return map;
            },
            { objectsMap: {}, classificationMap: {}, queryTime: Date.now() },
        );
    });
}

export async function getDataObject(dataIds: string[] | string | number) {
    const normalizedIds = normalizeDataIds(dataIds);
    if (normalizedIds.length === 0) {
        return { ...EMPTY_OBJECT_RESULT, queryTime: Date.now() };
    }

    let url = '/api/annotate/data/listByDataIds';
    let argsStr = queryStr({ dataIds: normalizedIds });
    let response = await get(`${url}?${argsStr}`);
    let data = response.data || [];
    let objectsMap = {} as Record<string, IObject[]>;
    let classificationMap = {} as Record<string, Record<string, string>>;
    data.forEach((e: any) => {
        const { dataId, objects, classificationValues } = e;
        objectsMap[String(dataId)] = (objects || [])
            .map((o: any) => {
                let { id, sourceId, sourceType, classId } = o;
                const classAttributes = o.classAttributes || {};
                const { meta, contour, ...rest } = classAttributes;
                try {
                    return utils.translateToObject(
                        Object.assign(
                            { backId: id, sourceId, sourceType, classId },
                            rest,
                            meta || {},
                            contour || {},
                        ),
                    );
                } catch (error) {
                    console.warn('skip invalid annotation object', { dataId, id, error });
                    return null;
                }
            })
            .filter((item): item is IObject => item != null);
        classificationMap[String(dataId)] = (classificationValues || []).reduce((map: any, c: any) => {
            const rawValues = c?.classificationAttributes?.values;
            const values = Array.isArray(rawValues) ? rawValues : [];
            return Object.assign(map, utils.saveToClassificationValue(values));
        }, {});
    });
    return {
        objectsMap,
        classificationMap,
        queryTime: response.queryDate,
    };
}

export async function getTrackFrameIds(
    dataIds: Array<string | number>,
    trackId: string,
): Promise<string[]> {
    const normalizedIds = normalizeDataIds(dataIds);
    if (!trackId || normalizedIds.length === 0) return [];
    const batchSize = 200;
    const requests: Array<Promise<Array<string | number>>> = [];
    for (let start = 0; start < normalizedIds.length; start += batchSize) {
        requests.push(
            get<any>(
                `/api/annotate/data/trackFrameIds?${queryStr({
                    dataIds: normalizedIds.slice(start, start + batchSize),
                    trackId,
                })}`,
            ).then((response) => (Array.isArray(response) ? response : response?.data || [])),
        );
    }
    const batches = await Promise.all(requests);
    return batches.flat().map((id) => String(id));
}

export async function getDataClassification(dataIds: string[] | string | number) {
    const normalizedIds = normalizeDataIds(dataIds);
    if (normalizedIds.length === 0) {
        return {};
    }

    let url = `/api/annotate/data/listByDataIds`;
    let argsStr = queryStr({ dataIds: normalizedIds });
    let data = await get(`${url}?${argsStr}`);
    // data = data.data || {};
    let dataAnnotations = data.data || [];

    let attrsMap = {} as Record<string, Record<string, string>>;
    dataAnnotations.forEach((e: any) => {
        let dataId = e.dataId;
        attrsMap[dataId] = attrsMap[dataId] || {};
        Object.assign(attrsMap[dataId], e.classificationAttributes || {});
    });
    return attrsMap;
}
export async function getDataClassificationBatch(dataIds: string[] | string | number) {
    const normalizedIds = normalizeDataIds(dataIds);
    if (normalizedIds.length === 0) {
        return {};
    }
    const batchSize = 200;
    const pendingIds = [...normalizedIds];
    const requests: Promise<any>[] = [];
    while (pendingIds.length > 0) {
      const batchIds = pendingIds.splice(0, batchSize);
      requests.push(getDataClassification(batchIds));
    }
    return Promise.all(requests).then((res) => {
      return res.reduce((map, item) => {
        return Object.assign(map, item);
      }, {});
    });
  }
export async function unlockRecord(recordId: string) {
    let url = `/api/data/unLock/${recordId}`;
    return await post(url);
}

export async function getDataStatus(dataIds: string[]) {
    const batchSize = 200;
    const requests: Promise<any>[] = [];
    let url = '/api/data/getDataStatusByIds';
    while (dataIds.length > 0) {
        const batchIds = dataIds.splice(0, batchSize);
        let argsStr = queryStr({ dataIds: batchIds });
        requests.push(get(`${url}?${argsStr}`));
    }
    return Promise.all(requests).then((res) => {
        const statusMap = {};
        res.forEach((re) => {
            re.data.forEach((item: any) => {
                statusMap[item.id] = item;
            });
        });
        return statusMap;
    });
}

export async function getInfoByRecordId(recordId: string) {
    let url = `/api/data/findDataAnnotationRecord/${recordId}`;
    let data = await get(url);
    data = data.data;
    // no data
    if (!data || !data.datas || data.datas.length === 0)
        return { dataInfos: [], isSeriesFrame: false, seriesFrameId: '' };

    let isSeriesFrame = ['FRAME_SERIES', 'SCENE'].includes(data.itemType);
    let modelRecordId = data.serialNo || '';
    const seriesFrameId = data.datas[0]?.sceneId ? String(data.datas[0].sceneId) : '';
    let model = undefined as IModelResult | undefined;
    if (modelRecordId) {
        model = {
            recordId: modelRecordId,
            id: '',
            version: '',
            state: '',
        };
    }

    let dataInfos: IFrame[] = [];
    (data.datas || []).forEach((config: any) => {
        dataInfos.push({
            // id: config.id,
            id: config.dataId + '',
            sceneId: config.sceneId != null ? String(config.sceneId) : undefined,
            datasetId: config.datasetId + '',
            teamId: config.teamId + '',
            // config: [],
            // viewConfig: [],
            pointsUrl: '',
            queryTime: '',
            loadState: '',
            model: model,
            needSave: false,
            classifications: [],
            dataStatus: 'VALID',
            annotationStatus: 'NOT_ANNOTATED',
            skipped: false,
        });
    });

    let ids = dataInfos.map((e) => e.id);
    let stateMap = await getDataStatus(ids);
    dataInfos.forEach((data) => {
        let status = stateMap[data.id];
        if (!status) return;
        data.dataStatus = status.status || 'VALID';
        data.annotationStatus = status.annotationStatus || 'NOT_ANNOTATED';
    });

    return { dataInfos, isSeriesFrame, seriesFrameId };
}

export async function saveDataClassification(config: any) {
    let url = `/api/annotate/data/save`;
    await post(url, config);
}

export async function getDataSetClassification(datasetId: string) {
    let url = `/api/datasetClassification/findAll/${datasetId}`;
    let data = await get(url);
    data = data.data || [];

    let classifications = traverseClassification2Arr(data);

    return classifications;
}

export async function getDataSetClass(datasetId: string) {
    let url = `/api/datasetClass/findAll/${datasetId}`;
    let data = await get(url);
    data = data.data || [];

    let classTypes = traverseClass2Arr(data);

    return classTypes;
}

export async function getDataFile(dataId: string) {
    let url = `/api/data/listByIds`;
    let data = await get(url, { dataIds: dataId });

    data = data.data || [];
    if (data.length === 0 || !data[0]?.content) {
        return { configs: [] as IFileConfig[], name: '' };
    }

    let configs = [] as IFileConfig[];
    data[0].content.forEach((config: any) => {
        let file = config.files?.[0];
        if (!file?.file) {
            return;
        }
        const pcdFile = file.file;
        // Binary remains the full-resolution URL. Preview is optional so both old data and older
        // converter responses continue to work without a separate API version.
        const fileUrl = pcdFile.binary || pcdFile;
        const pointCount = fileUrl.extraInfo?.pointCount;
        const previewPointCount = pcdFile.preview?.extraInfo?.pointCount;
        configs.push({
            dirName: config.name,
            name: file.name,
            url: fileUrl.url,
            previewUrl: pcdFile.preview?.url,
            pointCount: pointCount == null ? undefined : Number(pointCount),
            previewPointCount: previewPointCount == null ? undefined : Number(previewPointCount),
            pointsByteSize: fileUrl.size == null ? undefined : Number(fileUrl.size),
            previewPointsByteSize: pcdFile.preview?.size == null ? undefined : Number(pcdFile.preview.size),
            chunkManifestUrl: pcdFile.chunkManifest?.url,
            chunkCount: pcdFile.chunkManifest?.extraInfo?.chunkCount == null
                ? undefined : Number(pcdFile.chunkManifest.extraInfo.chunkCount),
        });
    });

    return { configs, name: data[0]?.name || '' };
}

export async function getUserInfo() {
    let url = `/api/user/logged`;
    let { data } = await get(url);
    return data;
}
export async function getDataSetInfo(datasetId: string): Promise<IDataSetInfo> {
    let url = `/api/dataset/info/${datasetId}`;
    let { data } = await get<{ data: IDataSetInfo }>(url);
    return data;
}

export async function annotateData(config: any) {
    let url = `/api/data/annotate`;
    let data = await post(url, config);
    return data;
}

export async function getLockRecord(datasetId: string) {
    let url = `/api/data/findLockRecordIdByDatasetId`;
    let data = await get(url, { datasetId });
    return data;
}
export async function getResultSources(dataId: string) {
    let url = `/api/data/getDataModelRunResult/${dataId}`;
    // let url = `/api/dataset/dataset/getDatasetAnnotateResult/${datasetId}`;
    let data = await get(url);

    const payload = data.data;
    if (!Array.isArray(payload)) {
        return [] as IResultSource[];
    }

    let sources = [] as IResultSource[];
    payload.forEach((item: any) => {
        let { modelId, modelName, runRecords = [] } = item;
        runRecords.forEach((e: any) => {
            sources.push({
                name: e.runNo,
                sourceId: e.id,
                modelId: modelId,
                modelName: modelName,
                sourceType: SourceType.MODEL,
            });
        });
    });
    return sources.filter((e) => e.sourceType !== SourceType.DATA_FLOW);
}
export async function getFrameSeriesData(datasetId: string, frameSeriesId: string) {
    const url = `/api/data/getDataIdBySceneIds`;
    const data = await get(url, {
        datasetId,
        sceneIds: frameSeriesId,
        // sortFiled: 'ID',
        // ascOrDesc: 'ASC',
    });

    const list = (data.data || {})[frameSeriesId] || [];
    // (list as any[]).reverse();
    if (list.length === 0) throw '';

    const dataList = [] as IFrame[];
    list.forEach((e: any) => {
        dataList.push({
            id: String(e),
            datasetId: datasetId,
            pointsUrl: '',
            queryTime: '',
            loadState: '',
            needSave: false,
            classifications: [],
            dataStatus: 'VALID',
            annotationStatus: 'NOT_ANNOTATED',
            skipped: false,
        });
    });
    return dataList;
    // return configs;
}
