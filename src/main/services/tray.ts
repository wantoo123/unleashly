import { app, Menu, nativeImage, Tray } from "electron";

import { log } from "./logger";

// 32x32 orange mark generated from the app logo. Embedded so the tray works in
// both development and packaged builds without relying on extraResources.
const TRAY_ICON =
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFG0lEQVR4nO1WzW9VRRT/nZk7c98rtUDa9xSUkGj5KrDQhLgysjHRlQtTtsZE2RgxWIggJo8SDKW1Gk2Mif+ACU1Yu3AjrsTEEASKWBOVRAptFVp9ffdj5pgzlweFtKUP8CPGWbyPe8/MOb9zfr9zBvh/3cNigJhB+DcEgr/VYS+0fDf2VJ9Pdldfmfus1aXuYk9AG1Lv+R3SGOTaqjb0gO+mHFGrG/gYFO2Aq++uvFguq83iMplxe0vvoZ+L8/JWzqOWnAvCgyDUO5elXo9qjdXegaEwm6uspzzw20V5T/3wf00JDkLL4alTe2xZPZzncJ7hjaVlKjWHicAIOVn6oqUacg0KB8F4e+UjWWpGiVF2DCI5g+FVRMQuf9IOT30thKQRuPubgc0gQdiYjQYEce7BwXkhQ4609AQ93KokaSlGTURpX+c2paOTLmcPujV4Zri4RDpJ/Aul4YnjfAxayHpfOcCsh7UuEIf/wW/xW8AIIQl0lGtrSzgb3tE9B8CCZAQu6evaYUv0VJKwIyqajgJIU+GECCrN2NsydScz9V1BCbU7Nyda1Lm8r4nNWpvOzJ6JDD2aZcziTPjgPTKhHhGVvORBGoEGe8Y1Y9QG2PGp4GQRWapFw6sVshNEto0eE4SKoJiRm7ISUn7IUPvkd1ACgXIHb2JamTTcoeD4DrKkRWUn649KNQOdJ+ABkZ080hTqO2OMWofHx3/NvqqMKa3W5nnIjgTmSYE94Ql79MoZ9EItJEu1qOwEvUPNxLTceXipOTN8VFLKez9IR8YnhOm5pwM6CsFJIch5IIoo4gSDdJOkS8/AsV7o3hF4vFndkjO+EdExh9RzFBE5xxdtu96Ec5cS9IRA88buysk4VtuSjB0BGgxnY9J55p8z7058tpAso/kC6C0i40bKw3FZRUkjMF+C9TqCch77qf9S/Ua5AJqNuM8xvmgiki4FL0SlYa7hc5wNRGxmaeES8HXZZXsqz8Yl9Ux6XXYMuNiSThr+pB268mnzPjDbV90pwbYNTX7pMj4uqD0jZCEJslQ9jd+rL0s5ZZIuWgJuyu4SdNpePWUNbUpy4VLQszOGdO7cdjM0eUKIla6pnCZFq80yXgNM1JN65zoNfZo9Il/MCGnRMrGmrE82omP6qsyTMLTmzUCtkF3WXtlp21RPIyucCyJBliV83A5NSpq5sab6ko1Vj7G0Ip3GPtlXGpr6Ls/5I1Mi4YuXfiGytGVdSSl+K8hy5FafdPusvzbdsaKs41FN1JULZQikJDkKudF+K+LJMVxd3pFG8ahSeJBlKCk0Ik9b0H75JySrV2Z5fp4IndKa+eb+1OW8tfT+xA+S5WZzUjdCGYGShzHiAzZWVYlcEAibTZmU8/wxDUxeEJuGivfbEj3kXHEfiAy1NbwfkHc08MuU9zgcxYoYkAxSuDMYKinQ0SDLczeBU0BfK5w33uhar7Q6Ax9IF2RnotDdpqxVm3BkfBJ7u7ozqG+JYbzgKsjjI0vKZe5pOzx5gj/ojrOfp08ZQxuT9Eb39NaSypzbLmVsTlgVDjhX3O8J6ogxJAc3e7dTUWj6h6TpSOpSpwaMoVga0xzysqSZQUP8WndMr48lRNjnRYhF12xOTfaOBrkGGy6xCBeaORzoW7Uh0ektOo3l48epMUhjqoGSmVXrMY9NksppUWSXX/4e/cgk1dde7Vrf0caUNA2bNvXLF+gTZLdL8h9ZNO8Aut1ozjhdyKYV21ZuzfjPrz8BDIaQdYSixvMAAAAASUVORK5CYII=";

type TrayActions = {
    showWindow: () => void;
    showTasks: () => void;
    quit: () => void;
};

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let running = 0;
let queued = 0;

function buildMenu() {
    const statusLabel = running ? `${running} 个任务运行中${queued ? `，${queued} 个等待中` : ""}` : queued ? `${queued} 个任务等待中` : "后台任务空闲";
    return Menu.buildFromTemplate([
        { label: statusLabel, enabled: false },
        { type: "separator" },
        { label: "打开任务中心", click: () => actions?.showTasks() },
        { label: "显示主窗口", click: () => actions?.showWindow() },
        { type: "separator" },
        { label: "退出 Unleashly", click: () => actions?.quit() },
    ]);
}

function refresh() {
    if (!tray) return;
    tray.setToolTip(`Unleashly${running ? ` · ${running} 个任务运行中` : ""}`);
    tray.setContextMenu(buildMenu());
}

export function createAppTray(nextActions: TrayActions) {
    actions = nextActions;
    if (tray) return tray;
    try {
        const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON}`);
        tray = new Tray(icon);
        tray.setToolTip("Unleashly");
        tray.setContextMenu(buildMenu());
        tray.on("click", () => actions?.showWindow());
        tray.on("double-click", () => actions?.showWindow());
        refresh();
        return tray;
    } catch (error) {
        log.warn("Failed to create tray icon", error);
        tray = null;
        return null;
    }
}

export function updateTrayTasks(nextRunning: number, nextQueued: number) {
    running = Math.max(0, nextRunning);
    queued = Math.max(0, nextQueued);
    refresh();
}

export function destroyAppTray() {
    if (!tray) return;
    tray.destroy();
    tray = null;
    actions = null;
}

export function quitFromTray() {
    app.quit();
}
