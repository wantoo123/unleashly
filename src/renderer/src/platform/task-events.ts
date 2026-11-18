import type { TaskDeltaEvent, TaskOpenEvent, TaskRecord } from "@shared/tasks";

import { getDesktopBridge } from "./bridge";

type TaskChangeListener = (task: TaskRecord) => void;
type TaskDeltaListener = (event: TaskDeltaEvent) => void;
type TaskOpenListener = (event: TaskOpenEvent) => void;

let installed = false;
const changeListeners = new Set<TaskChangeListener>();
const deltaListeners = new Set<TaskDeltaListener>();
const openListeners = new Set<TaskOpenListener>();

/** Install the IPC event bridge once; consumers subscribe through the sets below. */
export function installTaskEvents() {
    if (installed) return;
    const bridge = getDesktopBridge();
    if (!bridge?.tasks) return;
    installed = true;
    bridge.tasks.onChanged((task) => changeListeners.forEach((listener) => listener(task)));
    bridge.tasks.onDelta((event) => deltaListeners.forEach((listener) => listener(event)));
    bridge.tasks.onOpen((event) => openListeners.forEach((listener) => listener(event)));
}

export function subscribeTaskChanges(listener: TaskChangeListener) {
    installTaskEvents();
    changeListeners.add(listener);
    return () => {
        changeListeners.delete(listener);
    };
}

export function subscribeTaskDeltas(listener: TaskDeltaListener) {
    installTaskEvents();
    deltaListeners.add(listener);
    return () => {
        deltaListeners.delete(listener);
    };
}

export function subscribeTaskOpen(listener: TaskOpenListener) {
    installTaskEvents();
    openListeners.add(listener);
    return () => {
        openListeners.delete(listener);
    };
}
