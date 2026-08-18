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

export default class BusinessManager extends BaseBusinessManager {
    editor: Editor;
    constructor(editor: Editor) {
        super(editor);
        this.editor = editor;
    }

    async loadFrameConfig(data: IFrame): Promise<IDataResource> {
        const regLidar = new RegExp(/point(_?)cloud/i);
        const regConfig = new RegExp(/camera(_?)config/i);
        let { configs: fileConfig, name } = await api.getDataFile(data.id + '');
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
                cameraInfo = await api.getUrl(cameraConfig.url);
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

        let info = utils.createViewConfig(fileConfig, cameraInfo as any[]);
        let config: IDataResource = {
            pointsUrl: info.pointsUrl,
            pointsData: {},
            viewConfig: info.config,
            time: 0,
            name: name,
        };
        return config;

        // return {} as IDataResource;
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
        let data = await api.getDataObjectBatch(dataIds);
        return data;
    }
}
