import { IAction, IPageHandler } from '../type';
import { IFrame } from 'pc-editor';
import { useInjectEditor } from '../state';
import modes from '../config/mode';
import useTool from '../hook/useTool';
import { BSError } from 'pc-editor';
import { getSceneIdByDataId } from '../api';

export function view(): IPageHandler {
    let editor = useInjectEditor();
    let { state } = editor;

    let {
        loadClasses,
        loadDataSetInfo,
        loadDateSetClassification,
        loadUserInfo,
        loadDataFromFrameSeries,
    } = useTool();

    async function init() {
        let { query } = editor.bsState;
        if (!query.datasetId || !query.dataId) {
            editor.showMsg('error', editor.lang('invalid-query'));
            return;
        }

        if (query.type === 'visibility' && !query.visibilityRunId) {
            const sceneId = await getSceneIdByDataId(String(query.dataId));
            if (!sceneId) {
                editor.showMsg('error', '无法确定当前帧所属场景，请从数据集场景页进入自动遮挡。');
                return;
            }
            window.location.replace(
                `/#/auto-occlusion?datasetId=${encodeURIComponent(String(query.datasetId))}`
                + `&dataId=${encodeURIComponent(sceneId)}&sceneId=${encodeURIComponent(sceneId)}`
                + `&frameDataId=${encodeURIComponent(String(query.dataId))}`
                + '&dataType=frame',
            );
            return;
        }

        const mode = query.type === 'visibility' ? modes.visibility : modes.view;
        editor.setMode(mode);

        editor.showLoading(true);
        try {
            await loadDataSetInfo();
            await loadUserInfo();
            await Promise.all([loadDateSetClassification(), loadClasses(), loadDataInfo()]);
            await editor.loadFrame(0, false);
        } catch (error: any) {
            editor.handleErr(new BSError('', editor.lang('load-error'), error));
        }
        editor.showLoading(false);
    }

    async function loadDataInfo() {
        const { query } = editor.bsState;

        const dataId = query.dataId;
        if (['frame', 'scene'].some((e) => new RegExp(e, 'i').test(query.dataType))) {
            // 连续帧
            editor.state.isSeriesFrame = true;
            editor.bsState.seriesFrameId = dataId;
            await loadDataFromFrameSeries(dataId);
        } else {
            createSingleData();
        }
    }

    function createSingleData() {
        let { query } = editor.bsState;

        let dataId = query.dataId;
        let data: IFrame = {
            id: dataId,
            datasetId: query.datasetId,
            teamId: '',
            pointsUrl: '',
            queryTime: '',
            loadState: '',
            needSave: false,
            classifications: [],
            dataStatus: 'VALID',
            annotationStatus: 'NOT_ANNOTATED',
            skipped: false,
        };

        editor.setFrames([data]);
    }

    function onAction(action: IAction) {}

    return {
        init,
        onAction,
    };
}
