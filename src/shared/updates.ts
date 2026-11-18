export type UpdatePhase = "disabled" | "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";

export type UpdateInfoSummary = {
    version: string;
    releaseName?: string;
    releaseNotes?: string;
    releaseDate?: string;
};

export type UpdateProgress = {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
};

export type UpdateStatus = {
    phase: UpdatePhase;
    currentVersion: string;
    info?: UpdateInfoSummary;
    progress?: UpdateProgress;
    error?: string;
    message?: string;
    checkedAt?: string;
};

export const UPDATE_CHANNEL = "latest";
