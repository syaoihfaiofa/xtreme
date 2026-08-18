import * as pageHandler from '../pages';
import { useInjectEditor } from '../state';
import { setToken } from '../api/base';
import Event from '../config/event';
import * as _ from 'lodash';
import { onBeforeUnmount } from 'vue';

import useQuery from './useQuery';
import useToken from './useToken';

export type IHandlerType = keyof typeof pageHandler;

export default function UseFlow() {
    let editor = useInjectEditor();
    let { bsState } = editor;
    let query = useQuery();
    let token = useToken();
    let eventsInitialized = false;

    // datasetId=30093&dataId=352734&type=readOnly

    let handler = pageHandler[getMode(query)]();
    let queryKey = getQueryKey(query);
    const beforeUnloadHandler = (event: BeforeUnloadEvent): void => {
        if (editor.needSave()) {
            event.preventDefault();
            event.returnValue = editor.lang('msg-not-save');
        }
    };
    const flowActionHandler = (data: any): void => {
        handler.onAction(data.data);
    };
    const locationChangeHandler = (): void => {
        void reloadForLocationChange();
    };

    onBeforeUnmount(() => {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
        window.removeEventListener('popstate', locationChangeHandler);
        window.removeEventListener('hashchange', locationChangeHandler);
        editor.removeEventListener(Event.FLOW_ACTION, flowActionHandler);
    });
    // let handler = pageHandler.dev();

    async function init() {
        iniQuery();

        if (!token) {
            editor.showMsg('error', editor.lang('not-login'));
            return;
        }
        setToken(token);

        if (!eventsInitialized) {
            initFlowEvent();
            handleUnload();
            handleLocationChange();
            eventsInitialized = true;
        }

        await handler.init();
    }

    function handleUnload() {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    }

    function handleLocationChange() {
        window.addEventListener('popstate', locationChangeHandler);
        window.addEventListener('hashchange', locationChangeHandler);
    }

    async function reloadForLocationChange(): Promise<void> {
        const nextQuery = useQuery();
        const nextQueryKey = getQueryKey(nextQuery);
        if (nextQueryKey === queryKey) return;

        query = nextQuery;
        queryKey = nextQueryKey;
        handler = pageHandler[getMode(query)]();
        editor.clear();
        editor.reset();
        editor.trackManager.clear();
        editor.cmdManager.reset();
        editor.setCurrentTrack(undefined, '');
        editor.state.isSeriesFrame = false;
        editor.bsState.seriesFrameId = undefined;

        await init();
    }

    function initFlowEvent() {
        editor.addEventListener(Event.FLOW_ACTION, flowActionHandler);
    }

    function iniQuery() {
        Object.keys(bsState.query).forEach((key) => delete bsState.query[key]);
        Object.assign(bsState.query, query || {});
        bsState.recordId = (query.recordId as string) || '';
        bsState.datasetId = (query.datasetId as string) || '';
    }

    return {
        init,
    };
}

function getMode(query: Record<string, any>): IHandlerType {
    let mode = 'execute' as IHandlerType;
    if (query.type === 'readOnly') {
        mode = 'view';
    } else if (query.type === 'discussion') {
        mode = 'discussion';
    }

    return mode;
}

function getQueryKey(query: Record<string, any>): string {
    return JSON.stringify({
        datasetId: query.datasetId || '',
        recordId: query.recordId || '',
        dataId: query.dataId || '',
        dataType: query.dataType || '',
        type: query.type || '',
    });
}
