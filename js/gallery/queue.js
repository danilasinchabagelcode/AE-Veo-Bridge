(function (global) {
    "use strict";

    if (!global.VeoBridgeGalleryModules) {
        global.VeoBridgeGalleryModules = {};
    }

    function create() {
        function _safeArray(value) {
            return value && value instanceof Array ? value : [];
        }

        function _normalizeStatus(value) {
            var text = String(value || "").toLowerCase();
            if (!text) {
                return "unknown";
            }
            return text;
        }

        function summarizePendingJobs(state) {
            var jobs = _safeArray(state && state.pendingJobs);
            var byKind = {
                video: 0,
                image: 0,
                other: 0
            };
            var byStatus = {};
            var activeCount = 0;
            var i;
            var item;
            var kind;
            var status;

            for (i = 0; i < jobs.length; i += 1) {
                item = jobs[i] || {};
                kind = String(item.kind || "").toLowerCase();
                status = _normalizeStatus(item.status);

                if (kind === "video") {
                    byKind.video += 1;
                } else if (kind === "image") {
                    byKind.image += 1;
                } else {
                    byKind.other += 1;
                }

                if (!byStatus[status]) {
                    byStatus[status] = 0;
                }
                byStatus[status] += 1;

                if (status === "queued" || status === "uploading" || status === "polling" || status === "downloading" || status === "importing") {
                    activeCount += 1;
                }
            }

            return {
                total: jobs.length,
                active: activeCount,
                byKind: byKind,
                byStatus: byStatus
            };
        }

        function summarizeMedia(state) {
            var shots = _safeArray(state && state.shots);
            var videos = _safeArray(state && state.videos);
            var images = _safeArray(state && state.images);
            return {
                shotsCount: shots.length,
                videosCount: videos.length,
                imagesCount: images.length
            };
        }

        function buildDiagnosticsSummary(state) {
            return {
                pending: summarizePendingJobs(state),
                media: summarizeMedia(state)
            };
        }

        return {
            summarizePendingJobs: summarizePendingJobs,
            summarizeMedia: summarizeMedia,
            buildDiagnosticsSummary: buildDiagnosticsSummary
        };
    }

    global.VeoBridgeGalleryModules.queue = {
        create: create
    };
}(window));
