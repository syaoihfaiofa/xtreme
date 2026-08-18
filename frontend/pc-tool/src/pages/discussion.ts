import { IAction, IPageHandler } from '../type';
import { IFrame } from 'pc-editor';
import { useInjectEditor } from '../state';
import modes from '../config/mode';
import useTool from '../hook/useTool';
import { BSError } from 'pc-editor';

export function discussion(): IPageHandler {
    const editor = useInjectEditor();
    const { state } = editor;
    const {
        loadClasses,
        loadDataSetInfo,
        loadDateSetClassification,
        loadUserInfo,
        loadDataFromFrameSeries,
    } = useTool();

    async function init() {
        const { query } = editor.bsState;
        if (!query.datasetId || !query.dataId) {
            editor.showMsg('error', editor.lang('invalid-query'));
            return;
        }

        editor.setMode(modes.discussion);
        state.config.showLabel = true;
        editor.showLoading(true);
        try {
            await loadDataSetInfo();
            await loadUserInfo();
            await Promise.all([loadDateSetClassification(), loadClasses(), loadDataInfo()]);
            await editor.loadFrame(0, false);
        } catch (error: any) {
            editor.handleErr(new BSError('', editor.lang('load-error'), error));
        } finally {
            editor.showLoading(false);
        }
    }

    async function loadDataInfo() {
        const { query } = editor.bsState;
        const dataId = query.dataId;
        if (['frame', 'scene'].some((value) => new RegExp(value, 'i').test(query.dataType))) {
            state.isSeriesFrame = true;
            editor.bsState.seriesFrameId = dataId;
            await loadDataFromFrameSeries(dataId);
        } else {
            const data: IFrame = {
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
    }

    function onAction(_action: IAction) {}

    return { init, onAction };
}
