import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";
import { getDesktopBridge } from "@/platform/bridge";
import type { UpdateStatus } from "@shared/updates";

const REPOSITORY_RAW = "https://raw.githubusercontent.com/wantoo123/unleashly/main";
const latestVersionUrl = `${REPOSITORY_RAW}/VERSION`;
const latestChangelogUrl = `${REPOSITORY_RAW}/CHANGELOG.md`;

function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

async function fetchChangelog() {
    const response = await fetch(latestChangelogUrl);
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? parseChangelog(text) : null;
}

export function useVersionCheck() {
    const { t } = useTranslation();
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const updates = getDesktopBridge()?.updates;
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

    const applyStatus = useCallback(
        (status: UpdateStatus) => {
            setUpdateStatus(status);
            if (status.phase === "not-available") {
                setLatestVersion(currentVersion);
            } else if (status.info?.version && (status.phase === "available" || status.phase === "downloading" || status.phase === "downloaded" || isNewerVersion(status.info.version, currentVersion))) {
                setLatestVersion(status.info.version);
            }
            if (status.phase === "checking") setChecking(true);
            if (["available", "not-available", "downloaded", "error", "disabled"].includes(status.phase)) setChecking(false);
        },
        [currentVersion],
    );

    useEffect(() => {
        if (!updates) return;
        let active = true;
        void updates
            .status()
            .then((status) => {
                if (active) applyStatus(status);
            })
            .catch(() => undefined);
        const unsubscribe = updates.onStatus((status) => {
            if (active) applyStatus(status);
        });
        return () => {
            active = false;
            unsubscribe();
        };
    }, [applyStatus, updates]);

    const checkLatestVersion = useCallback(async () => {
        if (updates) {
            try {
                applyStatus(await updates.status());
                return true;
            } catch {
                return false;
            }
        }
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = (await response.text()).trim();
            setLatestVersion(isNewerVersion(version, currentVersion) ? version : currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [applyStatus, currentVersion, updates]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                if (updates) {
                    const [status, remoteReleases] = await Promise.all([updates.check(), fetchChangelog().catch(() => null)]);
                    applyStatus(status);
                    if (remoteReleases?.length) setReleases(remoteReleases);
                    if (showMessage) {
                        if (status.phase === "available" && status.info) message.success(t("version.updateAvailableMessage", { version: status.info.version }));
                        else if (status.phase === "not-available") message.success(t("version.upToDate"));
                        else if (status.phase === "error") message.error(status.error || t("version.updateFailed"));
                        else if (status.phase === "disabled") message.info(t("version.desktopOnly"));
                        else if (status.phase === "downloading") message.info(t("version.downloading"));
                        else if (status.phase === "downloaded") message.success(t("version.downloaded"));
                    }
                    return status.phase !== "error";
                }

                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error(t("version.readFailed"));
                if (!changelogResponse.ok) throw new Error(t("version.changelogFailed"));
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(isNewerVersion(version.trim(), currentVersion) ? version.trim() : currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success(t("version.updated"));
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error(t("version.updateFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [applyStatus, currentVersion, localReleases, message, t, updates],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    const downloadUpdate = useCallback(async () => {
        if (!updates) return null;
        try {
            const status = await updates.download();
            applyStatus(status);
            return status;
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
            return null;
        }
    }, [applyStatus, message, updates]);

    const installUpdate = useCallback(() => {
        void updates?.install();
    }, [updates]);

    const phase = updateStatus?.phase;
    const hasNewVersion = updates ? phase === "available" || phase === "downloading" || phase === "downloaded" : isNewerVersion(latestVersion, currentVersion);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking: checking || phase === "checking",
        hasNewVersion,
        checkLatestRelease,
        isDesktopUpdate: Boolean(updates),
        updateStatus,
        updatePhase: phase,
        updateProgress: updateStatus?.progress,
        updateError: updateStatus?.error,
        isDownloading: phase === "downloading",
        isDownloaded: phase === "downloaded",
        downloadUpdate,
        installUpdate,
    };
}
