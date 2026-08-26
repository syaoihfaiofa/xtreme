import { useInjectEditor } from '../state';
import * as api from '../api';
import { BSError, IFrame } from 'pc-editor';
import * as THREE from 'three';

export default function useTool() {
    let editor = useInjectEditor();
    let { bsState, state } = editor;

    async function loadClasses() {
        try {
            let config = await api.getDataSetClass(bsState.datasetId);
            // test
            // if (config.length > 0) {
            //     config[0].constraint = true;
            //     config[0].size3D = new THREE.Vector3(4, 4, 4);
            // }
            editor.setClassTypes(config);
        } catch (error) {
            throw new BSError('', editor.lang('load-class-error'), error);
        }
    }

    async function loadModels() {
        try {
            let models = await api.getModelList(bsState.datasetType);
            editor.state.models = models;
        } catch (error) {
            console.warn('load models error', error);
            editor.state.models = [];
        }
    }

    async function loadDateSetClassification() {
        try {
            let classifications = await api.getDataSetClassification(bsState.datasetId);
            editor.state.classifications = classifications;
        } catch (error) {
            throw new BSError('', editor.lang('load-dataset-classification-error'), error);
        }
    }

    async function loadRecord() {
        try {
            let { dataInfos, isSeriesFrame, seriesFrameId } = await api.getInfoByRecordId(
                bsState.recordId,
            );
            const sceneIds = collectSceneIds(dataInfos);
            const isSceneRecord = isSeriesFrame || sceneIds.length > 0;
            state.isSeriesFrame = isSceneRecord;

            if (isSceneRecord) {
                const targetSceneId = resolveTargetSceneId(
                    bsState.query,
                    dataInfos,
                    seriesFrameId,
                    sceneIds,
                );
                if (!targetSceneId) {
                    throw new BSError('', editor.lang('load-record-error'));
                }
                const datasetId = dataInfos[0]?.datasetId || bsState.datasetId;
                if (!datasetId) {
                    throw new BSError('', editor.lang('load-record-error'));
                }
                dataInfos = await loadSceneFrames(datasetId, targetSceneId, dataInfos);
                seriesFrameId = targetSceneId;
            } else {
                const requestedId = bsState.query.dataId ? String(bsState.query.dataId) : '';
                if (requestedId) {
                    dataInfos = dataInfos.filter((data) => data.id === requestedId);
                }
            }

            bsState.seriesFrameId = seriesFrameId;
            if (dataInfos.length === 0) {
                throw '';
            }

            editor.setFrames(dataInfos);
            bsState.datasetId = dataInfos[0].datasetId + '';
        } catch (error) {
            throw new BSError('', editor.lang('load-record-error'), error);
        }
    }

    function collectSceneIds(frames: IFrame[]): string[] {
        const sceneIds: string[] = [];
        const seen = new Set<string>();
        frames.forEach((frame) => {
            const sceneId = frame.sceneId;
            if (!sceneId || seen.has(sceneId)) return;
            seen.add(sceneId);
            sceneIds.push(sceneId);
        });
        return sceneIds;
    }

    function resolveTargetSceneId(
        query: Record<string, unknown>,
        frames: IFrame[],
        fallbackSceneId: string,
        sceneIds: string[],
    ): string {
        const fromQuery = query.dataId || query.sceneId;
        if (fromQuery) return String(fromQuery);
        if (sceneIds.length === 1) return sceneIds[0];
        if (sceneIds.length > 1) {
            const lastFrame = frames[frames.length - 1];
            if (lastFrame?.sceneId) return lastFrame.sceneId;
            return sceneIds[sceneIds.length - 1];
        }
        return fallbackSceneId;
    }

    async function loadSceneFrames(
        datasetId: string,
        sceneId: string,
        recordFrames: IFrame[],
    ): Promise<IFrame[]> {
        const sceneFrames = await api.getFrameSeriesData(datasetId, sceneId);
        const infoMap = new Map(recordFrames.map((frame) => [frame.id, frame]));
        return sceneFrames.map((frame) => {
            const info = infoMap.get(frame.id);
            return {
                ...frame,
                ...(info || {}),
                sceneId,
                datasetId,
            };
        });
    }

    async function loadUserInfo() {
        try {
            const data = await api.getUserInfo();
            Object.assign(editor.bsState.user, {
                id: data.id,
                nickname: data.nickname,
                username: data.username,
            });
        } catch (error) {
            throw new BSError('', 'load user info error', error);
        }
    }

    async function loadDataSetInfo() {
        try {
            let datasetId = editor.bsState.datasetId;
            let data = await api.getDataSetInfo(datasetId);
            bsState.datasetName = data.name;
            bsState.datasetType = data.type;
            bsState.syncMode = !!data.syncMode;
            bsState.inferenceMode = !!data.inferenceMode;
            bsState.inferenceConfig = data.inferenceConfig || null;
        } catch (error) {
            throw new BSError('', 'load data-set info error', error);
        }
    }
    async function loadDataFromFrameSeries(frameSeriesId: string) {
        try {
            const { datasetId } = editor.bsState;
            const frames = await api.getFrameSeriesData(datasetId, frameSeriesId);
            if (frames.length === 0) throw new BSError('', 'load scene error');
            // state.frames = frames;
            editor.setFrames(frames);
        } catch (error) {
            throw error instanceof BSError ? error : new BSError('', 'load scene error', error);
        }
    }

    return {
        loadUserInfo,
        loadModels,
        loadClasses,
        loadDataSetInfo,
        loadRecord,
        loadDateSetClassification,
        loadDataFromFrameSeries,
    };
}
