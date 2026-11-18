import type { CSSProperties } from "react";
import { Button, Modal, Progress, Tag, Timeline } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@/lib/image-utils";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

function getTagColor(type: string) {
    if (type === "新增" || type === "Added") return "green";
    if (type === "修复" || type === "Fixed") return "red";
    if (type === "调整" || type === "Changed") return "blue";
    if (type === "文档" || type === "Docs") return "purple";
    return "default";
}

function releaseTypeLabel(type: string, t: TFunction) {
    const key = ({ 新增: "added", 修复: "fixed", 调整: "changed", 优化: "optimized", 文档: "docs" } as Record<string, string>)[type];
    return key ? t(`version.types.${key}`) : type;
}

type VersionReleaseModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { t } = useTranslation();
    const { open, setOpen, openReleaseModal, latestVersion, releases, checking, hasNewVersion, checkLatestRelease, isDesktopUpdate, updatePhase, updateProgress, updateError, isDownloading, isDownloaded, downloadUpdate, installUpdate } = useVersionCheck();
    const updateTag =
        updatePhase === "available" ? (
            <Tag color="green" className="m-0">
                {t("version.updateAvailable")}
            </Tag>
        ) : updatePhase === "downloading" ? (
            <Tag color="processing" className="m-0">
                {t("version.downloading")}
            </Tag>
        ) : updatePhase === "downloaded" ? (
            <Tag color="success" className="m-0">
                {t("version.downloaded")}
            </Tag>
        ) : updatePhase === "not-available" ? (
            <Tag className="m-0">{t("version.upToDate")}</Tag>
        ) : updatePhase === "error" ? (
            <Tag color="error" className="m-0">
                {t("version.updateError")}
            </Tag>
        ) : updatePhase === "disabled" ? (
            <Tag className="m-0">{t("version.desktopOnly")}</Tag>
        ) : null;

    return (
        <>
            <button
                type="button"
                className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"}
                style={style}
                onClick={openReleaseModal}
                title={t("version.viewUpdates")}
            >
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title={t("version.title")} open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.currentVersion")}</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">{t("version.latestVersion")}</div>
                            <button
                                type="button"
                                className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline dark:text-stone-500 dark:hover:text-stone-300"
                                onClick={() => void checkLatestRelease(true)}
                            >
                                {t(checking ? "version.checking" : "version.checkUpdates")}
                            </button>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</span>
                            {updateTag}
                        </div>
                    </div>
                </div>
                {isDesktopUpdate ? (
                    <div className="mb-5 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-950/60">
                        {updatePhase === "available" ? (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t("version.updateAvailableHint", { version: latestVersion })}</div>
                                    <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{t("version.downloadHint")}</div>
                                </div>
                                <Button type="primary" onClick={() => void downloadUpdate()}>
                                    {t("version.download")}
                                </Button>
                            </div>
                        ) : isDownloading ? (
                            <div>
                                <div className="flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                                    <span>{t("version.downloading")}</span>
                                    <span>
                                        {Math.round(updateProgress?.percent || 0)}%{updateProgress?.bytesPerSecond ? ` · ${formatBytes(updateProgress.bytesPerSecond)}/s` : ""}
                                    </span>
                                </div>
                                <Progress className="!mb-0 mt-2" percent={Math.round(updateProgress?.percent || 0)} showInfo={false} />
                            </div>
                        ) : isDownloaded ? (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t("version.downloadedHint")}</div>
                                    <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{t("version.installHint")}</div>
                                </div>
                                <Button type="primary" onClick={installUpdate}>
                                    {t("version.restartInstall")}
                                </Button>
                            </div>
                        ) : updatePhase === "error" ? (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="min-w-0 text-xs text-red-600 dark:text-red-300">{updateError || t("version.updateFailed")}</div>
                                <Button size="small" onClick={() => void checkLatestRelease(true)}>
                                    {t("version.retry")}
                                </Button>
                            </div>
                        ) : updatePhase === "disabled" ? (
                            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("version.desktopOnlyHint")}</div>
                        ) : updatePhase === "not-available" ? (
                            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("version.upToDateHint")}</div>
                        ) : null}
                    </div>
                ) : null}
                <div className="max-h-[56vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version === "Unreleased" ? t("version.unreleased") : release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">{t("version.latest")}</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>{t("version.current")}</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {releaseTypeLabel(item.type, t)}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </Modal>
        </>
    );
}
