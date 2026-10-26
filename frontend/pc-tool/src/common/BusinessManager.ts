import {
    BusinessManager as BaseBusinessManager,
    IDataResource,
    IFrame,
    IObject,
    utils,
    IFileConfig,
    SourceType,
} from 'pc-editor';
import Editor from './Editor';
import * as api from '../api';
import { CAMERA_OCCLUSION_MASK_CONFIG } from '../config/cameraOcclusionMasks';

export default class BusinessManager extends BaseBusinessManager {
    editor: Editor;
    constructor(editor: Editor) {
        super(editor);
        this.editor = editor;
    }

    async loadFrameConfig(data: IFrame): Promise<IDataResource> {
        const regLidar = new RegExp(/point(_?)cloud/i);
        const regConfig = new RegExp(/camera(_?)config/i);
        this.editor.performanceMonitor.start('frame-metadata-request', String(data.id));
        let { configs: fileConfig, name } = await api.getDataFile(data.id + '');
        this.editor.performanceMonitor.end('frame-metadata-request', String(data.id), {
            fileCount: fileConfig.length,
        });
        // Keep the frame metadata available to UI helpers after lazy loading.
        // getInfoByRecordId normally fills this from getDataStatusByIds, while
        // this also covers callers that construct a frame directly.
        if (name) data.name = name;
        if (fileConfig.filter((e) => regLidar.test(e.dirName)).length === 0) {
            throw this.editor.lang('no-point-data');
        }
        let cameraConfig = fileConfig.find((e) => regConfig.test(e.dirName)) as IFileConfig;

        if (!cameraConfig) {
            const seriesFrameId = this.editor.bsState.seriesFrameId;
            if (seriesFrameId) {
                try {
                    const sceneFile = await api.getDataFile(String(seriesFrameId));
                    cameraConfig = sceneFile.configs.find((e) => regConfig.test(e.dirName)) as IFileConfig;
                } catch (error) {
                    console.warn('load scene camera config failed', error);
                }
            }
        }

        // no camera config
        let cameraInfo: any[] | Record<string, any> = [];
        if (cameraConfig) {
            try {
                this.editor.performanceMonitor.start('camera-config-request', String(data.id));
                cameraInfo = await api.getUrl(cameraConfig.url);
                this.editor.performanceMonitor.end('camera-config-request', String(data.id));
            } catch (error) {
                console.warn('load camera config json failed', error);
                cameraInfo = [];
            }
        }
        if (!Array.isArray(cameraInfo)) {
            cameraInfo = utils.normalizeCameraInfoList(cameraInfo || {});
        } else {
            cameraInfo = utils.normalizeCameraInfoList(cameraInfo);
        }

        return this.createFrameResourceConfig(fileConfig, name, cameraInfo as any[]);
    }

    async loadFrameConfigs(frames: IFrame[]): Promise<Record<string, IDataResource>> {
        const frameFiles = await api.getDataFileBatch(frames.map((frame) => String(frame.id)));
        const cameraConfig = Object.values(frameFiles)
            .flatMap((file) => file.configs)
            .find((file) => /camera(_?)config/i.test(file.dirName));
        let cameraInfo: any[] = [];
        if (cameraConfig) {
            const response = await api.getUrl(cameraConfig.url);
            cameraInfo = utils.normalizeCameraInfoList(
                Array.isArray(response) ? response : response || {},
            );
        }
        return frames.reduce((result: Record<string, IDataResource>, frame) => {
            const file = frameFiles[String(frame.id)];
            if (file) {
                result[String(frame.id)] = this.createFrameResourceConfig(
                    file.configs,
                    file.name,
                    cameraInfo,
                );
            }
            return result;
        }, {});
    }

    private createFrameResourceConfig(
        fileConfig: IFileConfig[],
        name: string,
        cameraInfo: any[],
    ): IDataResource {
        const pointConfig = fileConfig.find((file) => /point(_?)cloud/i.test(file.dirName));
        const info = utils.createViewConfig(fileConfig, cameraInfo);
        info.config.forEach((view, index) => {
            view.occlusionMask =
                CAMERA_OCCLUSION_MASK_CONFIG.views[String(index)]?.points || [];
        });
        return {
            pointsUrl: info.pointsUrl,
            previewPointsUrl: pointConfig?.previewUrl,
            pointCount: pointConfig?.pointCount,
            previewPointCount: pointConfig?.previewPointCount,
            pointsByteSize: pointConfig?.pointsByteSize,
            previewPointsByteSize: pointConfig?.previewPointsByteSize,
            chunkManifestUrl: pointConfig?.chunkManifestUrl,
            chunkCount: pointConfig?.chunkCount,
            pointsData: {},
            viewConfig: info.config,
            time: 0,
            name,
        };
    }

    async getFrameClassification(
        frame: IFrame | IFrame[],
    ): Promise<Record<string, Record<string, string>>> {
        let valueMap = await api.getDataClassificationBatch(
            Array.isArray(frame) ? frame.map((e) => e.id) : frame.id,
        );
        return valueMap;
    }

    async getFrameObject(frame: IFrame | IFrame[] | string | number): Promise<{
        objectsMap: Record<string, IObject[]>;
        classificationMap: Record<string, IObject[]>;
        queryTime: string;
    }> {
        let dataIds: string[] | string;
        if (Array.isArray(frame)) {
            if (frame.length === 0) {
                throw new Error('No frames to load annotation objects');
            }
            dataIds = frame.map((item) => {
                if (item.id == null || item.id === '') {
                    throw new Error('Frame id is missing in batch frame list');
                }
                return String(item.id);
            });
        } else if (typeof frame === 'string' || typeof frame === 'number') {
            dataIds = frame;
        } else {
            if (frame.id == null || frame.id === '') {
                throw new Error('Frame id is missing');
            }
            dataIds = frame.id;
        }
        const metricFrameId = Array.isArray(dataIds) ? String(dataIds[0]) : String(dataIds);
        this.editor.performanceMonitor.start('annotation-request', metricFrameId);
        let data = await api.getDataObjectBatch(dataIds);
        this.editor.performanceMonitor.end('annotation-request', metricFrameId, {
            frameCount: Array.isArray(dataIds) ? dataIds.length : 1,
        });
        return data;
    }
}
