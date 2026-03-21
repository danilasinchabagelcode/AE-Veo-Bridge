(function () {
    "use strict";

    var STORAGE_KEY_API_KEY = "veobridge.apiKey";
    var STORAGE_KEY_MODEL = "veobridge.modelId";
    var STORAGE_KEY_PROMPT = "veobridge.prompt";
    var STORAGE_KEY_ASPECT_RATIO = "veobridge.aspectRatio";
    var STORAGE_KEY_VIDEO_MODE = "veobridge.videoMode";
    var STORAGE_KEY_GEN_TYPE = "veobridge.genType";
    var STORAGE_KEY_IMAGE_PROMPT = "veobridge.imagePrompt";
    var STORAGE_KEY_GALLERY_TAB = "veobridge.galleryTab";

    var UI_MAX_REFERENCE_IMAGES = 4;
    var UI_MAX_VIDEO_REFERENCE_IMAGES = 3;
    var VIDEO_MODE_FRAMES = "frames";
    var VIDEO_MODE_REFERENCE = "reference";
    var GEN_TYPE_VIDEO = "video";
    var GEN_TYPE_IMAGE = "image";

    var path = null;
    var fs = null;
    var os = null;
    var childProcess = null;
    var cs = null;

    var isVideoGenerating = false;
    var isImageGenerating = false;
    var isResumingPendingJobs = false;
    var videoCapabilities = {
        checked: false,
        textToVideo: false,
        inlineData: false,
        reason: ""
    };
    var videoCapabilitiesSignature = "";
    var capabilitiesProbePromise = null;
    var hostPaths = null;
    var activeTab = "video";
    var isVideoMetaDetailsExpanded = false;
    var isImageMetaDetailsExpanded = false;
    var layoutSaveTimer = null;
    var windowSizeSaveTimer = null;
    var windowSizePollTimer = null;
    var pendingVideoResumeTimer = null;
    var pendingJobsLeaseHeartbeatTimer = null;
    var pendingJobsStaleTimer = null;
    var pendingVideoInjectedJobIds = [];
    var pendingImageQueue = [];
    var undoDeleteStack = [];
    var lastKnownWindowWidth = 0;
    var lastKnownWindowHeight = 0;
    var pendingJobsRunnerId = "runner_" + String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 1000000));
    var lastVideosListRenderKey = null;
    var lastImagesListRenderKey = null;
    var activeGenerationType = GEN_TYPE_VIDEO;
    var shotPickerContext = null;
    var mediaPreviewKind = "";
    var mediaPreviewId = "";
    var isCapturingPreviewFrame = false;
    var isVideoFlowOptionsOpen = false;
    var isImageFlowOptionsOpen = false;
    var videoLayout = {
        colRatio: 0.54,
        leftTopRatio: 0.42,
        rightTopRatio: 0.68
    };
    var imageLayout = {
        colRatio: 0.54,
        leftTopRatio: 0.34,
        leftMidRatio: 0.28,
        rightTopRatio: 0.7
    };
    var ACTIVE_VIDEO_JOB_STATUSES = {
        queued: true,
        uploading: true,
        polling: true,
        downloading: true,
        importing: true
    };
    var PENDING_JOBS_LEASE_TTL_MS = 9000;
    var PENDING_JOBS_LEASE_HEARTBEAT_MS = 2500;
    var CARD_HIGH_LOAD_MESSAGE = "Generation was interrupted due to high load.";
    var CARD_INTERRUPTED_MESSAGE = "Generation was interrupted because the app was closed before completion.";
    var PENDING_IMAGE_JOB_STALE_MS = 25000;
    var PENDING_VIDEO_JOB_STALE_ACTIVE_MS = 180000;
    var PENDING_VIDEO_JOB_STALE_POLLING_MS = 1200000;
    var PENDING_VIDEO_JOB_STALE_POLLING_WITH_OPERATION_MS = 2700000;
    var PENDING_JOBS_STALE_SCAN_MS = 5000;
    var smoothProgressByJobId = {};
    var smoothProgressTimer = null;
    var SMOOTH_PROGRESS_SLOWDOWN_MULTIPLIER = 4;
    var SMOOTH_PROGRESS_TICK_MS = 40 * SMOOTH_PROGRESS_SLOWDOWN_MULTIPLIER;
    var SMOOTH_PROGRESS_SYNTH_MAX_PERCENT = 90;
    var UNDO_DELETE_STACK_LIMIT = 10;
    var galleryModulesRoot = window.VeoBridgeGalleryModules || {};
    var stateAdapter = null;
    var queueAdapter = null;
    var renderAdapter = null;
    var actionsAdapter = null;
    var galleryReadyDispatched = false;

    function smoothProgressSyntheticDelayMs(percent) {
        var baseDelay;
        if (percent < 50) {
            baseDelay = 140;
        } else if (percent < 60) {
            baseDelay = 190;
        } else if (percent < 70) {
            baseDelay = 260;
        } else if (percent < 78) {
            baseDelay = 340;
        } else if (percent < 84) {
            baseDelay = 440;
        } else if (percent < 88) {
            baseDelay = 580;
        } else {
            baseDelay = 780;
        }
        return baseDelay * SMOOTH_PROGRESS_SLOWDOWN_MULTIPLIER;
    }

    function getById(id) {
        return document.getElementById(id);
    }

    function getActionsAdapter() {
        if (!actionsAdapter && galleryModulesRoot.actions && typeof galleryModulesRoot.actions.create === "function") {
            try {
                actionsAdapter = galleryModulesRoot.actions.create({
                    getById: getById,
                    setStatus: setStatus,
                    stateAdapter: getStateAdapter(),
                    queueAdapter: getQueueAdapter(),
                    getLoadedSettings: getLoadedSettingsSafe,
                    getHostPaths: function () {
                        return hostPaths;
                    },
                    revealPathInExplorer: revealPathInExplorer
                });
            } catch (createError) {
                actionsAdapter = null;
            }
        }
        return actionsAdapter;
    }

    function logDiagnostics(level, message, payload) {
        var adapter = getActionsAdapter();
        if (!adapter || typeof adapter.appendLog !== "function") {
            return;
        }
        adapter.appendLog(level, message, payload || null);
    }

    function getStateAdapter() {
        if (!stateAdapter && galleryModulesRoot.stateAdapter && typeof galleryModulesRoot.stateAdapter.create === "function") {
            try {
                stateAdapter = galleryModulesRoot.stateAdapter.create({
                    stateApi: window.VeoBridgeState,
                    logger: logDiagnostics
                });
            } catch (stateAdapterError) {
                stateAdapter = null;
            }
        }
        return stateAdapter;
    }

    function getQueueAdapter() {
        if (!queueAdapter && galleryModulesRoot.queue && typeof galleryModulesRoot.queue.create === "function") {
            try {
                queueAdapter = galleryModulesRoot.queue.create();
            } catch (queueAdapterError) {
                queueAdapter = null;
            }
        }
        return queueAdapter;
    }

    function getRenderAdapter() {
        if (!renderAdapter && galleryModulesRoot.render && typeof galleryModulesRoot.render.create === "function") {
            try {
                renderAdapter = galleryModulesRoot.render.create({
                    getById: getById,
                    logger: logDiagnostics
                });
            } catch (renderAdapterError) {
                renderAdapter = null;
            }
        }
        return renderAdapter;
    }

    function stateAdapterUpdate(patch) {
        var adapter = getStateAdapter();
        if (adapter && typeof adapter.updateState === "function") {
            return adapter.updateState(patch || {});
        }
        if (window.VeoBridgeState && typeof window.VeoBridgeState.updateState === "function") {
            return window.VeoBridgeState.updateState(patch || {});
        }
        throw new Error("VeoBridgeState.updateState is unavailable.");
    }

    function setStatus(text, isError) {
        var el = getById("galleryStatus");
        var adapter = getRenderAdapter();
        if (!el) {
            return;
        }
        if (adapter && typeof adapter.setLine === "function") {
            adapter.setLine("galleryStatus", text, !!isError, "status-line");
            return;
        }
        el.textContent = text;
        el.className = isError ? "status-line is-error" : "status-line";
        logDiagnostics(isError ? "error" : "info", "gallery.status", { text: String(text || "") });
    }

    function setGenerationStatus(text, isError) {
        var el = getById("generationStatus");
        var adapter = getRenderAdapter();
        if (!el) {
            return;
        }
        if (adapter && typeof adapter.setLine === "function") {
            adapter.setLine("generationStatus", text, !!isError, "inline-status");
            return;
        }
        el.textContent = text;
        el.className = isError ? "inline-status is-error" : "inline-status";
        logDiagnostics(isError ? "error" : "info", "gallery.generationStatus", { text: String(text || "") });
    }

    function setImageGenerationStatus(text, isError) {
        var el = getById("imageGenerationStatus");
        var adapter = getRenderAdapter();
        if (!el) {
            if (activeGenerationType === GEN_TYPE_IMAGE) {
                setGenerationStatus(text, isError);
            }
            return;
        }
        if (adapter && typeof adapter.setLine === "function") {
            adapter.setLine("imageGenerationStatus", text, !!isError, "inline-status");
        } else {
            el.textContent = text;
            el.className = isError ? "inline-status is-error" : "inline-status";
            logDiagnostics(isError ? "error" : "info", "gallery.imageGenerationStatus", { text: String(text || "") });
        }
        if (activeGenerationType === GEN_TYPE_IMAGE) {
            setGenerationStatus(text, isError);
        }
    }

    function ensureCs() {
        if (!cs && window.CSInterfaceLite) {
            cs = new window.CSInterfaceLite();
        }
        return cs;
    }

    function dispatchGalleryReadyEvent() {
        var bridge = ensureCs();
        var event = null;

        if (galleryReadyDispatched) {
            return;
        }
        if (!bridge || typeof bridge.dispatchEvent !== "function") {
            return;
        }
        if (typeof window.CSEvent !== "function") {
            return;
        }

        try {
            event = new window.CSEvent("veobridge.gallery.ready", "APPLICATION");
            event.data = JSON.stringify({
                ready: true,
                timestamp: new Date().getTime()
            });
            bridge.dispatchEvent(event);
            galleryReadyDispatched = true;
        } catch (dispatchError) {
            galleryReadyDispatched = false;
        }
    }

    function parseHostResult(raw) {
        if (typeof raw !== "string") {
            return null;
        }
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    function callHost(script, callback) {
        var bridge = ensureCs();
        if (!bridge || typeof bridge.evalScript !== "function") {
            callback(new Error("CSInterface is unavailable"), null);
            return;
        }

        bridge.evalScript(script, function (raw) {
            var parsed = parseHostResult(raw);
            var message;

            if (!parsed) {
                message = String(raw || "");
                callback(new Error("Host script failed: " + (message || "Empty response")), null);
                return;
            }

            if (!parsed.ok) {
                message = parsed.error || "Host error";
                if (parsed.code) {
                    message += " [" + parsed.code + "]";
                }
                if (parsed.path) {
                    message += " Path: " + String(parsed.path);
                }
                if (parsed.details) {
                    message += " " + String(parsed.details);
                }
                callback(new Error(message), parsed);
                return;
            }

            callback(null, parsed);
        });
    }

    function toHostStringLiteral(value) {
        return "\"" + String(value)
            .replace(/\\/g, "\\\\")
            .replace(/\"/g, "\\\"")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n") + "\"";
    }

    function toFileUrl(filePath) {
        var raw = String(filePath || "");
        var normalized = raw.replace(/\\/g, "/");
        if (normalized.charAt(0) !== "/") {
            normalized = "/" + normalized;
        }
        return "file://" + encodeURI(normalized);
    }

    function baseName(filePath) {
        var normalized = String(filePath || "").replace(/\\/g, "/");
        var parts = normalized.split("/");
        return parts.length ? parts[parts.length - 1] : normalized;
    }

    function trimText(value) {
        return String(value || "").replace(/^\s+|\s+$/g, "");
    }

    function normalizeAspectRatio(value) {
        return value === "9:16" ? "9:16" : "16:9";
    }

    function guessVideoAspectRatioFromShot(shot) {
        var width = shot && typeof shot.width === "number" ? shot.width : parseFloat(shot && shot.width);
        var height = shot && typeof shot.height === "number" ? shot.height : parseFloat(shot && shot.height);

        if (!(width > 0) || !(height > 0)) {
            return "";
        }
        return height > width ? "9:16" : "16:9";
    }

    function normalizeVideoMode(value) {
        var mode = trimText(value);
        if (mode === "image" || mode === "interpolation") {
            return VIDEO_MODE_FRAMES;
        }
        if (mode === VIDEO_MODE_FRAMES || mode === VIDEO_MODE_REFERENCE) {
            return mode;
        }
        return VIDEO_MODE_FRAMES;
    }

    function normalizeGenerationType(value) {
        var type = trimText(value).toLowerCase();
        if (type === GEN_TYPE_IMAGE) {
            return GEN_TYPE_IMAGE;
        }
        return GEN_TYPE_VIDEO;
    }

    function normalizeImageAspectRatio(value) {
        var v = trimText(value);
        if (v === "16:9" || v === "9:16") {
            return v;
        }
        return "1:1";
    }

    function normalizeImageSize(value) {
        var v = trimText(value).toUpperCase();
        if (v === "2K" || v === "4K") {
            return v;
        }
        return "1K";
    }

    function clampNumber(value, min, max, fallback) {
        var num = typeof value === "number" ? value : parseFloat(value);
        if (!isFinite(num)) {
            num = fallback;
        }
        if (num < min) {
            num = min;
        }
        if (num > max) {
            num = max;
        }
        return num;
    }

    function fileExists(filePath) {
        if (!filePath) {
            return false;
        }
        if (!fs || typeof fs.existsSync !== "function") {
            return true;
        }
        try {
            return !!fs.existsSync(filePath);
        } catch (error) {
            return false;
        }
    }

    function isSupportedImagePath(filePath) {
        var lower = String(filePath || "").toLowerCase();
        return /\.(png|jpg|jpeg|webp)$/.test(lower);
    }

    function guessImageMimeType(filePath) {
        var lower = String(filePath || "").toLowerCase();
        if (/\.jpe?g$/.test(lower)) {
            return "image/jpeg";
        }
        if (/\.webp$/.test(lower)) {
            return "image/webp";
        }
        return "image/png";
    }

    function normalizePathForCompare(filePath) {
        return String(filePath || "").replace(/\\/g, "/").toLowerCase();
    }

    function ensureDirRecursive(dirPath) {
        var parent;

        if (!dirPath || !fs || !path) {
            return false;
        }

        try {
            if (fs.existsSync(dirPath)) {
                return true;
            }
        } catch (existsError) {
            return false;
        }

        parent = path.dirname(dirPath);
        if (parent && parent !== dirPath) {
            if (!ensureDirRecursive(parent)) {
                return false;
            }
        }

        try {
            fs.mkdirSync(dirPath);
            return true;
        } catch (mkdirError) {
            try {
                return fs.existsSync(dirPath);
            } catch (checkError) {
                return false;
            }
        }
    }

    function resolveLibraryVideosDir() {
        var targetDir = path.join(resolveUserDataBridgeDir(), "videos");

        if (!path || !targetDir) {
            return "";
        }
        if (!ensureDirRecursive(targetDir)) {
            return "";
        }

        return targetDir;
    }

    function resolveLibraryImagesDir() {
        var targetDir = path.join(resolveUserDataBridgeDir(), "images");

        if (!path || !targetDir) {
            return "";
        }
        if (!ensureDirRecursive(targetDir)) {
            return "";
        }

        return targetDir;
    }

    function resolveProjectVideosDir() {
        var targetDir;

        if (!path || !hostPaths || !hostPaths.projectBridgeDir || !hostPaths.projectSaved) {
            return "";
        }

        targetDir = path.join(hostPaths.projectBridgeDir, "videos");
        if (!ensureDirRecursive(targetDir)) {
            return "";
        }

        return targetDir;
    }

    function resolveProjectImagesDir() {
        var targetDir;

        if (!path || !hostPaths || !hostPaths.projectBridgeDir || !hostPaths.projectSaved) {
            return "";
        }

        targetDir = path.join(hostPaths.projectBridgeDir, "images");
        if (!ensureDirRecursive(targetDir)) {
            return "";
        }

        return targetDir;
    }

    function resolveFramesCaptureDir(mediaPath) {
        var targetDir = "";

        if (!path) {
            return "";
        }

        if (hostPaths && hostPaths.framesDir) {
            targetDir = hostPaths.framesDir;
        }
        if (!targetDir) {
            targetDir = path.join(resolveUserDataBridgeDir(), "frames");
        }

        if (!targetDir || !ensureDirRecursive(targetDir)) {
            return "";
        }
        return targetDir;
    }

    function resolveUserDataBridgeDir() {
        var platform;
        var homeDir;
        var baseDir;

        if (!path || !os || typeof process === "undefined" || !process || !process.env) {
            return "";
        }

        platform = process.platform || "";
        if (platform === "win32") {
            baseDir = process.env.APPDATA || "";
            if (!baseDir) {
                baseDir = path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
            }
        } else if (platform === "darwin") {
            homeDir = os.homedir ? os.homedir() : (process.env.HOME || "");
            if (!homeDir) {
                return "";
            }
            baseDir = path.join(homeDir, "Library", "Application Support");
        } else {
            baseDir = process.env.XDG_DATA_HOME || "";
            if (!baseDir) {
                homeDir = os.homedir ? os.homedir() : (process.env.HOME || "");
                if (!homeDir) {
                    return "";
                }
                baseDir = path.join(homeDir, ".local", "share");
            }
        }

        if (!baseDir) {
            return "";
        }
        return path.join(baseDir, "VeoBridge");
    }

    function getManagedBridgeRoots() {
        var roots = [];
        var seen = {};
        var libraryBridge = hostPaths && hostPaths.bridgeDir ? trimText(hostPaths.bridgeDir) : "";
        var userBridge = resolveUserDataBridgeDir();
        var key;

        function pushRoot(rootPath) {
            var cleaned = trimText(rootPath || "");
            if (!cleaned) {
                return;
            }
            key = normalizePathForCompare(cleaned);
            if (!key || seen[key]) {
                return;
            }
            seen[key] = true;
            roots.push(cleaned);
        }

        pushRoot(libraryBridge);
        pushRoot(userBridge);
        return roots;
    }

    function isPathInsideDir(filePath, dirPath) {
        var normalizedFile;
        var normalizedDir;
        if (!filePath || !dirPath || !path) {
            return false;
        }
        normalizedFile = normalizePathForCompare(path.resolve(filePath));
        normalizedDir = normalizePathForCompare(path.resolve(dirPath));
        if (!normalizedFile || !normalizedDir) {
            return false;
        }
        if (normalizedFile === normalizedDir) {
            return true;
        }
        return normalizedFile.indexOf(normalizedDir + "/") === 0;
    }

    function isManagedMediaPath(filePath) {
        var roots = getManagedBridgeRoots();
        var i;
        if (!filePath || !path) {
            return false;
        }
        if (!/\.(png|jpg|jpeg|webp|mp4)$/i.test(String(filePath || ""))) {
            return false;
        }
        for (i = 0; i < roots.length; i += 1) {
            if (isPathInsideDir(filePath, roots[i])) {
                return true;
            }
        }
        return false;
    }

    function buildTrashPathForFile(filePath) {
        var roots = getManagedBridgeRoots();
        var selectedRoot = "";
        var trashDir;
        var ext;
        var stem;
        var candidateName;
        var candidatePath;
        var i;
        var attempt;

        if (!filePath || !path || !fs) {
            return null;
        }

        for (i = 0; i < roots.length; i += 1) {
            if (isPathInsideDir(filePath, roots[i])) {
                selectedRoot = roots[i];
                break;
            }
        }

        if (!selectedRoot) {
            selectedRoot = roots.length ? roots[0] : "";
        }
        if (!selectedRoot) {
            return null;
        }

        trashDir = path.join(selectedRoot, ".trash");
        if (!ensureDirRecursive(trashDir)) {
            return null;
        }

        ext = path.extname(filePath) || "";
        stem = path.basename(filePath, ext);
        candidateName = stem + "__" + String(new Date().getTime()) + ext;
        candidatePath = path.join(trashDir, candidateName);
        attempt = 0;
        while (fileExists(candidatePath) && attempt < 50) {
            attempt += 1;
            candidateName = stem + "__" + String(new Date().getTime()) + "_" + String(attempt) + ext;
            candidatePath = path.join(trashDir, candidateName);
        }

        return {
            root: selectedRoot,
            trashDir: trashDir,
            trashPath: candidatePath
        };
    }

    function moveFileWithRenameOrCopy(sourcePath, targetPath) {
        try {
            fs.renameSync(sourcePath, targetPath);
            return true;
        } catch (renameError) {
            try {
                fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
                fs.unlinkSync(sourcePath);
                return true;
            } catch (copyFallbackError) {
                return false;
            }
        }
    }

    function copyFileToPath(sourcePath, targetPath) {
        try {
            fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
            return true;
        } catch (copyError) {
            return false;
        }
    }

    function moveFileToTrash(filePath) {
        var plan;
        if (!filePath) {
            return { ok: false, moved: false, reason: "NO_PATH" };
        }
        if (!fileExists(filePath)) {
            return { ok: true, moved: false, reason: "MISSING" };
        }
        if (!isManagedMediaPath(filePath)) {
            return { ok: false, moved: false, reason: "OUTSIDE_MANAGED_DIR" };
        }
        if (!fs || !path) {
            return { ok: false, moved: false, reason: "FS_UNAVAILABLE" };
        }
        plan = buildTrashPathForFile(filePath);
        if (!plan || !plan.trashPath) {
            return { ok: false, moved: false, reason: "TRASH_UNAVAILABLE" };
        }
        if (!moveFileWithRenameOrCopy(filePath, plan.trashPath)) {
            return { ok: false, moved: false, reason: "MOVE_FAILED" };
        }
        return {
            ok: true,
            moved: true,
            originalPath: filePath,
            trashPath: plan.trashPath
        };
    }

    function restoreFileFromTrash(entry) {
        var originalPath = entry && entry.originalPath ? entry.originalPath : "";
        var trashPath = entry && entry.trashPath ? entry.trashPath : "";

        if (!originalPath || !trashPath || !path || !fs) {
            return false;
        }
        if (!fileExists(trashPath)) {
            return false;
        }
        if (fileExists(originalPath)) {
            return true;
        }
        if (!ensureDirRecursive(path.dirname(originalPath))) {
            return false;
        }
        return moveFileWithRenameOrCopy(trashPath, originalPath);
    }

    function collectReferencedPathSet(state) {
        var result = {};
        var i;
        var jobs;
        var refs;
        var key;

        function addPath(filePath) {
            var normalized = normalizePathForCompare(filePath);
            if (!normalized) {
                return;
            }
            result[normalized] = true;
        }

        refs = state.shots || [];
        for (i = 0; i < refs.length; i += 1) {
            addPath(refs[i] && refs[i].path);
        }
        refs = state.videos || [];
        for (i = 0; i < refs.length; i += 1) {
            addPath(refs[i] && refs[i].path);
        }
        refs = state.images || [];
        for (i = 0; i < refs.length; i += 1) {
            addPath(refs[i] && refs[i].path);
        }
        refs = state.refs || [];
        for (i = 0; i < refs.length; i += 1) {
            addPath(refs[i] && refs[i].path);
        }
        refs = getVideoRefs(state);
        for (i = 0; i < refs.length; i += 1) {
            addPath(refs[i] && refs[i].path);
        }

        jobs = getPendingJobs(state);
        for (i = 0; i < jobs.length; i += 1) {
            addPath(jobs[i] && jobs[i].startShotPath);
            addPath(jobs[i] && jobs[i].endShotPath);
            addPath(jobs[i] && jobs[i].downloadedPath);
            refs = jobs[i] && jobs[i].references && jobs[i].references instanceof Array ? jobs[i].references : [];
            for (key = 0; key < refs.length; key += 1) {
                addPath(refs[key] && refs[key].path);
            }
        }
        return result;
    }

    function shouldDeletePathForNextState(filePath, nextState) {
        var normalized;
        var refs;
        if (!filePath || !fileExists(filePath) || !isManagedMediaPath(filePath)) {
            return false;
        }
        normalized = normalizePathForCompare(filePath);
        refs = collectReferencedPathSet(nextState);
        return !refs[normalized];
    }

    function cloneDeleteFileEntries(entries) {
        var source = entries && entries instanceof Array ? entries : [];
        var out = [];
        var i;
        for (i = 0; i < source.length; i += 1) {
            if (!source[i] || !source[i].originalPath || !source[i].trashPath) {
                continue;
            }
            out.push({
                originalPath: source[i].originalPath,
                trashPath: source[i].trashPath
            });
        }
        return out;
    }

    function isPathInTrashDir(filePath, rootDir) {
        var trashDir;
        if (!filePath || !rootDir || !path) {
            return false;
        }
        trashDir = path.join(rootDir, ".trash");
        return isPathInsideDir(filePath, trashDir);
    }

    function collectManagedMediaFiles(options) {
        var opts = options || {};
        var includeTrash = !!opts.includeTrash;
        var roots = getManagedBridgeRoots();
        var files = [];
        var seen = {};
        var stack;
        var currentDir;
        var entries;
        var entryName;
        var fullPath;
        var normalized;
        var stats;
        var i;
        var j;

        if (!fs || !path) {
            return files;
        }

        for (i = 0; i < roots.length; i += 1) {
            if (!roots[i] || !fileExists(roots[i])) {
                continue;
            }

            stack = [roots[i]];
            while (stack.length) {
                currentDir = stack.pop();
                try {
                    entries = fs.readdirSync(currentDir);
                } catch (readError) {
                    continue;
                }

                for (j = 0; j < entries.length; j += 1) {
                    entryName = entries[j];
                    fullPath = path.join(currentDir, entryName);
                    try {
                        stats = fs.statSync(fullPath);
                    } catch (statError) {
                        continue;
                    }

                    if (stats && stats.isDirectory && stats.isDirectory()) {
                        if (!includeTrash && isPathInTrashDir(fullPath, roots[i])) {
                            continue;
                        }
                        stack.push(fullPath);
                        continue;
                    }

                    if (!isManagedMediaPath(fullPath)) {
                        continue;
                    }
                    if (!includeTrash && isPathInTrashDir(fullPath, roots[i])) {
                        continue;
                    }

                    normalized = normalizePathForCompare(fullPath);
                    if (!normalized || seen[normalized]) {
                        continue;
                    }
                    seen[normalized] = true;
                    files.push(fullPath);
                }
            }
        }

        return files;
    }

    function removeFilePermanently(filePath) {
        if (!filePath || !fs) {
            return false;
        }
        try {
            fs.unlinkSync(filePath);
            return true;
        } catch (error) {
            return false;
        }
    }

    function removeEmptyParentDirs(startDir, stopDir) {
        var current = startDir;
        var normalizedStop;
        var normalizedCurrent;
        var entries;

        if (!current || !stopDir || !path || !fs) {
            return;
        }
        normalizedStop = normalizePathForCompare(path.resolve(stopDir));
        while (current && current !== path.dirname(current)) {
            normalizedCurrent = normalizePathForCompare(path.resolve(current));
            if (!normalizedCurrent || normalizedCurrent === normalizedStop) {
                break;
            }
            try {
                entries = fs.readdirSync(current);
            } catch (error) {
                break;
            }
            if (entries && entries.length) {
                break;
            }
            try {
                fs.rmdirSync(current);
            } catch (removeError) {
                break;
            }
            current = path.dirname(current);
        }
    }

    function removeDirectoryRecursive(targetDir) {
        var deletedFiles = 0;
        var failedFiles = 0;
        var entries;
        var i;
        var fullPath;
        var stats;
        var nested;

        if (!targetDir || !fs || !path || !fileExists(targetDir)) {
            return {
                deletedFiles: 0,
                failedFiles: 0
            };
        }

        try {
            entries = fs.readdirSync(targetDir);
        } catch (readError) {
            return {
                deletedFiles: 0,
                failedFiles: 1
            };
        }

        for (i = 0; i < entries.length; i += 1) {
            fullPath = path.join(targetDir, entries[i]);
            try {
                stats = fs.statSync(fullPath);
            } catch (statError) {
                failedFiles += 1;
                continue;
            }

            if (stats && stats.isDirectory && stats.isDirectory()) {
                nested = removeDirectoryRecursive(fullPath);
                deletedFiles += nested.deletedFiles;
                failedFiles += nested.failedFiles;
                continue;
            }

            if (removeFilePermanently(fullPath)) {
                deletedFiles += 1;
            } else {
                failedFiles += 1;
            }
        }

        try {
            fs.rmdirSync(targetDir);
        } catch (rmdirError) {
            // keep failure soft; files are primary concern
        }

        return {
            deletedFiles: deletedFiles,
            failedFiles: failedFiles
        };
    }

    function pruneStateForCleanup(state) {
        var shots = state.shots || [];
        var videos = state.videos || [];
        var images = state.images || [];
        var refs = state.refs || [];
        var videoRefs = getVideoRefs(state);
        var nextShots = [];
        var nextVideos = [];
        var nextImages = [];
        var nextRefs = [];
        var nextVideoRefs = [];
        var stats = {
            removedShots: 0,
            removedVideos: 0,
            removedImages: 0,
            removedRefs: 0,
            removedVideoRefs: 0
        };
        var validShotIds = {};
        var validVideoIds = {};
        var validImageIds = {};
        var nextSelectedShotId = null;
        var nextStartShotId = null;
        var nextEndShotId = null;
        var nextSelectedVideoId = null;
        var nextSelectedImageId = null;
        var i;
        var item;

        for (i = 0; i < shots.length; i += 1) {
            item = shots[i];
            if (!item || !item.id || !item.path || !fileExists(item.path)) {
                stats.removedShots += 1;
                continue;
            }
            nextShots.push(item);
            validShotIds[item.id] = true;
        }

        for (i = 0; i < videos.length; i += 1) {
            item = videos[i];
            if (!item || !item.id || !item.path || !fileExists(item.path)) {
                stats.removedVideos += 1;
                continue;
            }
            nextVideos.push(item);
            validVideoIds[item.id] = true;
        }

        for (i = 0; i < images.length; i += 1) {
            item = images[i];
            if (!item || !item.id || !item.path || !fileExists(item.path)) {
                stats.removedImages += 1;
                continue;
            }
            nextImages.push(item);
            validImageIds[item.id] = true;
        }

        for (i = 0; i < refs.length; i += 1) {
            item = refs[i];
            if (!item || !item.path || !fileExists(item.path)) {
                stats.removedRefs += 1;
                continue;
            }
            nextRefs.push(item);
        }

        for (i = 0; i < videoRefs.length; i += 1) {
            item = videoRefs[i];
            if (!item || !item.path || !fileExists(item.path)) {
                stats.removedVideoRefs += 1;
                continue;
            }
            nextVideoRefs.push(item);
        }

        if (state.selectedShotId && validShotIds[state.selectedShotId]) {
            nextSelectedShotId = state.selectedShotId;
        } else if (nextShots.length) {
            nextSelectedShotId = nextShots[nextShots.length - 1].id;
        }

        if (state.startShotId && validShotIds[state.startShotId]) {
            nextStartShotId = state.startShotId;
        }
        if (state.endShotId && validShotIds[state.endShotId]) {
            nextEndShotId = state.endShotId;
        }

        if (state.selectedVideoId && validVideoIds[state.selectedVideoId]) {
            nextSelectedVideoId = state.selectedVideoId;
        } else if (nextVideos.length) {
            nextSelectedVideoId = nextVideos[0].id;
        }

        if (state.selectedImageId && validImageIds[state.selectedImageId]) {
            nextSelectedImageId = state.selectedImageId;
        } else if (nextImages.length) {
            nextSelectedImageId = nextImages[0].id;
        }

        return {
            patch: {
                shots: nextShots,
                selectedShotId: nextSelectedShotId,
                startShotId: nextStartShotId,
                endShotId: nextEndShotId,
                refs: nextRefs,
                videoRefs: nextVideoRefs,
                videos: nextVideos,
                selectedVideoId: nextSelectedVideoId,
                images: nextImages,
                selectedImageId: nextSelectedImageId
            },
            stats: stats
        };
    }

    function cleanupOrphanFilesForState(cleanState) {
        var mediaFiles = collectManagedMediaFiles({ includeTrash: false });
        var refs = collectReferencedPathSet(cleanState);
        var deleted = 0;
        var failed = 0;
        var i;
        var filePath;
        var normalized;
        var roots;
        var root;
        var rootIndex;

        for (i = 0; i < mediaFiles.length; i += 1) {
            filePath = mediaFiles[i];
            normalized = normalizePathForCompare(filePath);
            if (refs[normalized]) {
                continue;
            }
            if (removeFilePermanently(filePath)) {
                deleted += 1;
                roots = getManagedBridgeRoots();
                for (rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
                    root = roots[rootIndex];
                    if (isPathInsideDir(filePath, root) && !isPathInTrashDir(filePath, root)) {
                        removeEmptyParentDirs(path.dirname(filePath), root);
                        break;
                    }
                }
            } else {
                failed += 1;
            }
        }

        return {
            deleted: deleted,
            failed: failed
        };
    }

    function cleanupTrashDirs() {
        var roots = getManagedBridgeRoots();
        var deleted = 0;
        var failed = 0;
        var i;
        var trashDir;
        var result;

        for (i = 0; i < roots.length; i += 1) {
            if (!roots[i]) {
                continue;
            }
            trashDir = path.join(roots[i], ".trash");
            if (!fileExists(trashDir)) {
                continue;
            }
            result = removeDirectoryRecursive(trashDir);
            deleted += result.deletedFiles;
            failed += result.failedFiles;
        }

        return {
            deleted: deleted,
            failed: failed
        };
    }

    function openCleanupConfirmModal() {
        var modal = getById("cleanupConfirmModal");
        if (isVideoGenerating || isImageGenerating || isResumingPendingJobs) {
            setStatus("Cleanup is blocked while generation is running.", true);
            return;
        }
        if (!modal) {
            runCleanup();
            return;
        }
        modal.hidden = false;
    }

    function closeCleanupConfirmModal() {
        var modal = getById("cleanupConfirmModal");
        if (!modal) {
            return;
        }
        modal.hidden = true;
    }

    function runCleanup() {
        var state = getState();
        var pruneResult;
        var cleanState;
        var orphanResult;
        var trashResult;
        var pruneStats;
        var parts = [];
        var hadErrors = false;

        if (isVideoGenerating || isImageGenerating || isResumingPendingJobs) {
            setStatus("Cleanup is blocked while generation is running.", true);
            return;
        }
        if (!fs || !path) {
            setStatus("Cleanup is unavailable in this environment.", true);
            return;
        }
        closeCleanupConfirmModal();

        pruneResult = pruneStateForCleanup(state);
        pruneStats = pruneResult.stats;
        cleanState = {
            shots: pruneResult.patch.shots || [],
            selectedShotId: pruneResult.patch.selectedShotId || null,
            startShotId: pruneResult.patch.startShotId || null,
            endShotId: pruneResult.patch.endShotId || null,
            refs: pruneResult.patch.refs || [],
            videoRefs: pruneResult.patch.videoRefs || [],
            videos: pruneResult.patch.videos || [],
            selectedVideoId: pruneResult.patch.selectedVideoId || null,
            images: pruneResult.patch.images || [],
            selectedImageId: pruneResult.patch.selectedImageId || null,
            pendingJobs: getPendingJobs(state)
        };

        orphanResult = cleanupOrphanFilesForState(cleanState);
        trashResult = cleanupTrashDirs();

        undoDeleteStack = [];
        updateUndoDeleteButtonState();

        stateAdapterUpdate(pruneResult.patch);

        parts.push("State cleaned");
        parts.push("shots -" + String(pruneStats.removedShots));
        parts.push("videos -" + String(pruneStats.removedVideos));
        parts.push("images -" + String(pruneStats.removedImages));
        parts.push("refs -" + String(pruneStats.removedRefs));
        parts.push("video refs -" + String(pruneStats.removedVideoRefs));
        parts.push("orphan files deleted " + String(orphanResult.deleted));
        parts.push("trash files deleted " + String(trashResult.deleted));

        if (orphanResult.failed > 0 || trashResult.failed > 0) {
            hadErrors = true;
            parts.push("failed deletions " + String(orphanResult.failed + trashResult.failed));
        }

        setStatus(parts.join(" | "), hadErrors);
    }

    function resolveErrorMessage(reason) {
        if (!reason) {
            return "Unknown error.";
        }
        if (reason.message) {
            return String(reason.message);
        }
        return String(reason);
    }

    function isIgnorableResizeObserverError(message) {
        var text = String(message || "");
        return /ResizeObserver loop limit exceeded/i.test(text) ||
            /ResizeObserver loop completed with undelivered notifications/i.test(text);
    }

    function isIgnorableMediaPlayError(message) {
        var text = String(message || "");
        return /play\(\) request was interrupted by a call to pause\(\)/i.test(text) ||
            /The operation was aborted/i.test(text);
    }

    function formatError(error) {
        if (!error) {
            return "Unknown error.";
        }
        if (error.userMessage) {
            return String(error.userMessage);
        }
        if (error.message) {
            return String(error.message);
        }
        return String(error);
    }

    function normalizeProgressPercent(value) {
        var num = parseFloat(value);
        if (!isFinite(num)) {
            return null;
        }
        if (num < 0) {
            num = 0;
        }
        if (num > 100) {
            num = 100;
        }
        return Math.round(num);
    }

    function stageToProgressPercent(stage) {
        var text = trimText(stage).toLowerCase();
        if (text.indexOf("upload") === 0) {
            return 8;
        }
        if (text.indexOf("poll") === 0 || text.indexOf("generat") === 0) {
            return 42;
        }
        if (text.indexOf("download") === 0) {
            return 86;
        }
        if (text.indexOf("import") === 0) {
            return 96;
        }
        return null;
    }

    function stopSmoothProgressTicker() {
        if (smoothProgressTimer && typeof window.clearInterval === "function") {
            window.clearInterval(smoothProgressTimer);
        }
        smoothProgressTimer = null;
    }

    function collectRenderedProgressChips() {
        var cards;
        var i;
        var card;
        var jobId;
        var chip;
        var map = {};

        if (!document || typeof document.querySelectorAll !== "function") {
            return map;
        }

        cards = document.querySelectorAll(".flow-group-item[data-media-id]");
        for (i = 0; i < cards.length; i += 1) {
            card = cards[i];
            if (!card || typeof card.getAttribute !== "function") {
                continue;
            }
            jobId = card.getAttribute("data-media-id");
            if (!jobId) {
                continue;
            }
            chip = typeof card.querySelector === "function" ? card.querySelector(".state-chip") : null;
            if (!chip) {
                continue;
            }
            map[jobId] = chip;
        }
        return map;
    }

    function updateSmoothProgressChips(changedMap) {
        var chipsByJobId;
        var jobId;
        var entry;
        var label;

        chipsByJobId = collectRenderedProgressChips();
        for (jobId in changedMap) {
            if (!Object.prototype.hasOwnProperty.call(changedMap, jobId)) {
                continue;
            }
            entry = smoothProgressByJobId[jobId];
            if (!entry || !chipsByJobId[jobId]) {
                continue;
            }
            label = String(entry.display) + "%";
            if (chipsByJobId[jobId].textContent !== label) {
                chipsByJobId[jobId].textContent = label;
            }
        }
    }

    function startSmoothProgressTicker() {
        if (smoothProgressTimer || typeof window.setInterval !== "function") {
            return;
        }
        smoothProgressTimer = window.setInterval(function () {
            var changed = false;
            var nowMs = new Date().getTime();
            var changedJobIds = {};
            var hasWork = false;
            var jobId;
            var entry;

            for (jobId in smoothProgressByJobId) {
                if (!Object.prototype.hasOwnProperty.call(smoothProgressByJobId, jobId)) {
                    continue;
                }
                entry = smoothProgressByJobId[jobId];
                if (!entry) {
                    delete smoothProgressByJobId[jobId];
                    continue;
                }
                if (entry.display < entry.target) {
                    var step = 1;
                    if (entry.fastFinish) {
                        if ((entry.target - entry.display) > 20) {
                            step = 6;
                        } else if ((entry.target - entry.display) > 10) {
                            step = 4;
                        } else {
                            step = 3;
                        }
                    }
                    entry.display += step;
                    if (entry.display > entry.target) {
                        entry.display = entry.target;
                    }
                    changed = true;
                    changedJobIds[jobId] = true;
                } else if (entry.display > entry.target) {
                    entry.display = entry.target;
                    changed = true;
                    changedJobIds[jobId] = true;
                } else if (entry.canSynthesize && entry.target < entry.synthMax) {
                    var synthDelay = smoothProgressSyntheticDelayMs(entry.target);
                    if (!entry.lastSyntheticBumpAt || (nowMs - entry.lastSyntheticBumpAt) >= synthDelay) {
                        entry.target += 1;
                        if (entry.target > entry.synthMax) {
                            entry.target = entry.synthMax;
                        }
                        entry.lastSyntheticBumpAt = nowMs;
                    }
                }
                if (entry.display < entry.target) {
                    hasWork = true;
                } else if (entry.canSynthesize && entry.target < entry.synthMax) {
                    hasWork = true;
                }
            }

            if (changed) {
                updateSmoothProgressChips(changedJobIds);
            }
            if (!hasWork) {
                stopSmoothProgressTicker();
            }
        }, SMOOTH_PROGRESS_TICK_MS);
    }

    function dropSmoothProgressJob(jobId) {
        if (!jobId) {
            return;
        }
        delete smoothProgressByJobId[jobId];
    }

    function cleanupSmoothProgressJobs(activeJobMap) {
        var hasActive = false;
        var jobId;
        var entry;
        for (jobId in smoothProgressByJobId) {
            if (!Object.prototype.hasOwnProperty.call(smoothProgressByJobId, jobId)) {
                continue;
            }
            if (!activeJobMap || !activeJobMap[jobId]) {
                delete smoothProgressByJobId[jobId];
                continue;
            }
            entry = smoothProgressByJobId[jobId];
            if (!entry) {
                continue;
            }
            if (entry.display < entry.target || (entry.canSynthesize && entry.target < entry.synthMax)) {
                hasActive = true;
            }
        }
        if (!hasActive) {
            stopSmoothProgressTicker();
        }
    }

    function smoothProgressForJob(jobId, targetProgress, stateClass, activeJobMap, stageHint, hasExactProgress) {
        var target = normalizeProgressPercent(targetProgress);
        var entry;
        var normalizedStage = trimText(stageHint || "").toLowerCase();

        if (stateClass !== "generating" || target === null || target < 1 || target > 99) {
            dropSmoothProgressJob(jobId);
            return target;
        }
        if (!jobId) {
            return target;
        }
        if (activeJobMap) {
            activeJobMap[jobId] = true;
        }

        entry = smoothProgressByJobId[jobId];
        if (!entry) {
            entry = {
                display: target > 1 ? 1 : target,
                target: target,
                canSynthesize: false,
                lastSyntheticBumpAt: 0,
                fastFinish: false,
                synthMax: SMOOTH_PROGRESS_SYNTH_MAX_PERCENT
            };
            smoothProgressByJobId[jobId] = entry;
        } else {
            if (!isFinite(entry.display) || entry.display < 1) {
                entry.display = 1;
            }
            if (!isFinite(entry.target) || entry.target < 1) {
                entry.target = entry.display;
            }
            if (target < entry.target) {
                target = entry.target;
            }
            entry.target = target;
            if (entry.display > entry.target) {
                entry.display = entry.target;
            }
        }

        entry.canSynthesize = !hasExactProgress && (
            normalizedStage === "polling" ||
            normalizedStage.indexOf("poll") === 0 ||
            normalizedStage === "generating" ||
            normalizedStage.indexOf("generat") === 0
        );
        entry.fastFinish = (
            normalizedStage.indexOf("download") === 0 ||
            normalizedStage.indexOf("import") === 0 ||
            target >= 96
        );

        if (entry.display < entry.target || (entry.canSynthesize && entry.target < entry.synthMax)) {
            startSmoothProgressTicker();
        }
        return entry.display;
    }

    function isHighLoadErrorMessage(message) {
        var text = String(message || "");
        return /HTTP\s*429/i.test(text) ||
            /rate limit/i.test(text) ||
            /quota/i.test(text) ||
            /resource exhausted/i.test(text) ||
            /high load/i.test(text) ||
            /overload/i.test(text) ||
            /capacity/i.test(text) ||
            /temporarily unavailable/i.test(text);
    }

    function toCardErrorMessage(errorLike) {
        var text = formatError(errorLike);
        if (isHighLoadErrorMessage(text)) {
            return CARD_HIGH_LOAD_MESSAGE;
        }
        return text;
    }

    function playInlineVideoPreview(videoEl) {
        var playPromise;
        if (!videoEl || typeof videoEl.play !== "function") {
            return;
        }
        try {
            videoEl.muted = true;
            videoEl.defaultMuted = true;
            videoEl.playsInline = true;
            playPromise = videoEl.play();
            if (playPromise && typeof playPromise.then === "function") {
                playPromise.then(function () {
                    // no-op
                }, function (error) {
                    var message = formatError(error);
                    if (!isIgnorableMediaPlayError(message) && global.console && typeof global.console.warn === "function") {
                        global.console.warn("[VeoBridge] video preview play failed: " + message);
                    }
                });
            }
        } catch (error2) {
            if (global.console && typeof global.console.warn === "function") {
                global.console.warn("[VeoBridge] video preview play exception: " + formatError(error2));
            }
        }
    }

    function stopInlineVideoPreview(videoEl) {
        if (!videoEl) {
            return;
        }
        try {
            if (typeof videoEl.pause === "function") {
                videoEl.pause();
            }
        } catch (pauseError) {
            // ignore
        }
        try {
            if (videoEl.readyState > 0) {
                videoEl.currentTime = 0;
            }
        } catch (seekError) {
            // ignore
        }
    }

    function pauseAllInlineVideoPreviews(exceptVideoEl) {
        var list = getById("videosList");
        var previews;
        var i;
        if (!list || typeof list.querySelectorAll !== "function") {
            return;
        }
        previews = list.querySelectorAll(".flow-group-thumb .video-thumb");
        if (!previews || !previews.length) {
            return;
        }
        for (i = 0; i < previews.length; i += 1) {
            if (previews[i] === exceptVideoEl) {
                continue;
            }
            stopInlineVideoPreview(previews[i]);
        }
    }

    function truncateText(value, maxLength) {
        var text = String(value || "");
        var limit = typeof maxLength === "number" && maxLength > 0 ? maxLength : 120;
        if (text.length <= limit) {
            return text;
        }
        return text.substring(0, limit) + "...";
    }

    function escapeHtml(text) {
        var str = String(text || "");
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatDate(isoString) {
        var date;
        if (!isoString) {
            return "-";
        }

        try {
            date = new Date(isoString);
            if (date && !isNaN(date.getTime())) {
                return date.toLocaleString();
            }
        } catch (error) {
            return String(isoString);
        }

        return String(isoString);
    }

    function formatDateOnly(isoString) {
        var date;
        if (!isoString) {
            return "-";
        }
        try {
            date = new Date(isoString);
            if (date && !isNaN(date.getTime())) {
                return date.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric"
                });
            }
        } catch (error) {
            return String(isoString);
        }
        return String(isoString);
    }

    function parseSampleCount(rawValue) {
        var num = parseInt(rawValue, 10);
        if (!isFinite(num) || num < 1 || num > 4) {
            return 2;
        }
        return num;
    }

    function normalizeVideoLayout(candidate) {
        var input = candidate || {};
        return {
            colRatio: clampNumber(input.colRatio, 0.32, 0.76, 0.54),
            leftTopRatio: clampNumber(input.leftTopRatio, 0.24, 0.72, 0.42),
            rightTopRatio: clampNumber(input.rightTopRatio, 0.12, 0.86, 0.68)
        };
    }

    function normalizeImageLayout(candidate) {
        var input = candidate || {};
        var leftTop = clampNumber(input.leftTopRatio, 0.18, 0.65, 0.34);
        var leftMid = clampNumber(input.leftMidRatio, 0.14, 0.62, 0.28);
        var maxMid = 0.82 - leftTop;

        if (leftMid > maxMid) {
            leftMid = maxMid;
        }
        if (leftMid < 0.14) {
            leftMid = 0.14;
        }

        return {
            colRatio: clampNumber(input.colRatio, 0.32, 0.76, 0.54),
            leftTopRatio: leftTop,
            leftMidRatio: leftMid,
            rightTopRatio: clampNumber(input.rightTopRatio, 0.35, 0.86, 0.7)
        };
    }

    function applyVideoLayout() {
        var panel = getById("panelVideo");
        if (!panel || !panel.style) {
            return;
        }
        panel.style.setProperty("--video-col-ratio", (videoLayout.colRatio * 100).toFixed(2) + "%");
        panel.style.setProperty("--video-left-top-ratio", (videoLayout.leftTopRatio * 100).toFixed(2) + "%");
        panel.style.setProperty("--video-right-top-ratio", (videoLayout.rightTopRatio * 100).toFixed(2) + "%");
    }

    function applyImageLayout() {
        var panel = getById("panelImage");
        if (!panel || !panel.style) {
            return;
        }

        panel.style.setProperty("--image-col-ratio", (imageLayout.colRatio * 100).toFixed(2) + "%");
        panel.style.setProperty("--image-left-top-ratio", (imageLayout.leftTopRatio * 100).toFixed(2) + "%");
        panel.style.setProperty("--image-left-mid-ratio", (imageLayout.leftMidRatio * 100).toFixed(2) + "%");
        panel.style.setProperty("--image-right-top-ratio", (imageLayout.rightTopRatio * 100).toFixed(2) + "%");
    }

    function getLoadedSettingsSafe() {
        if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.loadSettings === "function") {
            try {
                return window.VeoBridgeSettings.loadSettings() || null;
            } catch (error) {
                return null;
            }
        }
        return null;
    }

    function saveLayoutsDebounced() {
        if (layoutSaveTimer && typeof window.clearTimeout === "function") {
            window.clearTimeout(layoutSaveTimer);
            layoutSaveTimer = null;
        }

        if (typeof window.setTimeout !== "function") {
            return;
        }

        layoutSaveTimer = window.setTimeout(function () {
            layoutSaveTimer = null;
            if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function") {
                try {
                    window.VeoBridgeSettings.saveSettings({
                        layout: {
                            gallery: {
                                video: normalizeVideoLayout(videoLayout),
                                image: normalizeImageLayout(imageLayout)
                            }
                        }
                    });
                } catch (error) {
                    // ignore settings save errors
                }
            }
        }, 120);
    }

    function loadLayouts() {
        var settings = getLoadedSettingsSafe();
        var videoFromSettings = null;
        var imageFromSettings = null;

        if (settings && settings.layout && settings.layout.gallery) {
            if (settings.layout.gallery.video) {
                videoFromSettings = settings.layout.gallery.video;
            }
            if (settings.layout.gallery.image) {
                imageFromSettings = settings.layout.gallery.image;
            }
        }

        videoLayout = normalizeVideoLayout(videoFromSettings || videoLayout);
        imageLayout = normalizeImageLayout(imageFromSettings || imageLayout);
        applyVideoLayout();
        applyImageLayout();
    }

    function saveWindowSizeNow() {
        var width;
        var height;

        if (!(window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function")) {
            return;
        }

        width = window.innerWidth || window.outerWidth || 0;
        height = window.innerHeight || window.outerHeight || 0;
        if (width < 300 || height < 220) {
            return;
        }

        try {
            window.VeoBridgeSettings.saveSettings({
                window: {
                    gallery: {
                        width: width,
                        height: height
                    }
                }
            });
            lastKnownWindowWidth = width;
            lastKnownWindowHeight = height;
        } catch (error) {
            // ignore settings save errors
        }
    }

    function saveWindowSizeDebounced() {
        if (windowSizeSaveTimer && typeof window.clearTimeout === "function") {
            window.clearTimeout(windowSizeSaveTimer);
            windowSizeSaveTimer = null;
        }

        if (typeof window.setTimeout !== "function") {
            return;
        }

        windowSizeSaveTimer = window.setTimeout(function () {
            windowSizeSaveTimer = null;
            saveWindowSizeNow();
        }, 160);
    }

    function applySavedWindowSizeOnLoad() {
        var settings = getLoadedSettingsSafe();
        var width = 0;
        var height = 0;
        var bridge = ensureCs();

        if (!(settings && settings.window && settings.window.gallery)) {
            return;
        }

        width = parseInt(settings.window.gallery.width, 10) || 0;
        height = parseInt(settings.window.gallery.height, 10) || 0;
        width = clampNumber(width, 860, 2800, 1180);
        height = clampNumber(height, 620, 1800, 820);

        try {
            if (bridge && typeof bridge.resizeContent === "function") {
                bridge.resizeContent(width, height);
            }
        } catch (resizeContentError) {
            // ignore and continue with resizeTo fallback
        }

        try {
            if (typeof window.resizeTo === "function") {
                window.resizeTo(width, height);
            }
            lastKnownWindowWidth = width;
            lastKnownWindowHeight = height;
            if (typeof window.setTimeout === "function") {
                window.setTimeout(function () {
                    try {
                        if (bridge && typeof bridge.resizeContent === "function") {
                            bridge.resizeContent(width, height);
                        }
                        if (typeof window.resizeTo === "function") {
                            window.resizeTo(width, height);
                        }
                    } catch (error2) {
                        // ignore
                    }
                }, 120);
                window.setTimeout(function () {
                    try {
                        if (bridge && typeof bridge.resizeContent === "function") {
                            bridge.resizeContent(width, height);
                        }
                    } catch (error3) {
                        // ignore
                    }
                }, 320);
            }
        } catch (error) {
            // ignore
        }
    }

    function getCurrentWindowSize() {
        return {
            width: window.innerWidth || window.outerWidth || 0,
            height: window.innerHeight || window.outerHeight || 0
        };
    }

    function startWindowSizeWatcher() {
        var current;
        if (windowSizePollTimer || typeof window.setInterval !== "function") {
            return;
        }

        current = getCurrentWindowSize();
        lastKnownWindowWidth = current.width;
        lastKnownWindowHeight = current.height;

        windowSizePollTimer = window.setInterval(function () {
            var next = getCurrentWindowSize();
            if (Math.abs(next.width - lastKnownWindowWidth) >= 2 || Math.abs(next.height - lastKnownWindowHeight) >= 2) {
                lastKnownWindowWidth = next.width;
                lastKnownWindowHeight = next.height;
                saveWindowSizeNow();
            }
        }, 450);
    }

    function stopWindowSizeWatcher() {
        if (windowSizePollTimer && typeof window.clearInterval === "function") {
            window.clearInterval(windowSizePollTimer);
            windowSizePollTimer = null;
        }
    }

    function getApiKeyFromStorage() {
        var apiKey = "";

        try {
            apiKey = trimText(window.localStorage.getItem(STORAGE_KEY_API_KEY) || "");
        } catch (storageError) {
            apiKey = "";
        }

        var shared = getLoadedSettingsSafe();
        if (shared && shared.apiKey) {
            apiKey = trimText(shared.apiKey);
        }

        return apiKey;
    }

    function getState() {
        var adapter = getStateAdapter();
        if (adapter && typeof adapter.getState === "function") {
            return adapter.getState();
        }
        return window.VeoBridgeState.getState();
    }

    function cloneJson(value, fallback) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return typeof fallback === "undefined" ? null : fallback;
        }
    }

    function buildUndoDeleteSnapshot(state) {
        var source = state || getState();
        return {
            shots: cloneJson(source.shots || [], []),
            selectedShotId: source.selectedShotId || null,
            startShotId: source.startShotId || null,
            endShotId: source.endShotId || null,
            refs: cloneJson(source.refs || [], []),
            videoRefs: cloneJson(getVideoRefs(source) || [], []),
            videos: cloneJson(source.videos || [], []),
            selectedVideoId: source.selectedVideoId || null,
            images: cloneJson(source.images || [], []),
            selectedImageId: source.selectedImageId || null,
            pendingJobs: cloneJson(getPendingJobs(source) || [], [])
        };
    }

    function updateUndoDeleteButtonState() {
        var btn = getById("btnUndoDelete");
        if (!btn) {
            return;
        }
        btn.disabled = undoDeleteStack.length < 1;
        btn.title = undoDeleteStack.length < 1 ? "Nothing to undo" : "Undo last delete";
    }

    function pushUndoDeleteAction(label, snapshot, deletedFiles) {
        var normalizedLabel = trimText(label || "Delete");
        var normalizedSnapshot = cloneJson(snapshot, null);
        var normalizedDeletedFiles = cloneDeleteFileEntries(deletedFiles);
        if (!normalizedSnapshot) {
            return;
        }
        undoDeleteStack.push({
            label: normalizedLabel,
            snapshot: normalizedSnapshot,
            deletedFiles: normalizedDeletedFiles
        });
        if (undoDeleteStack.length > UNDO_DELETE_STACK_LIMIT) {
            undoDeleteStack = undoDeleteStack.slice(undoDeleteStack.length - UNDO_DELETE_STACK_LIMIT);
        }
        updateUndoDeleteButtonState();
    }

    function undoLastDeleteAction() {
        var entry;
        var deletedFiles;
        var restored = 0;
        var missing = 0;
        var i;
        if (!undoDeleteStack.length) {
            setStatus("Nothing to undo.", false);
            updateUndoDeleteButtonState();
            return;
        }
        entry = undoDeleteStack.pop();
        updateUndoDeleteButtonState();
        if (!entry || !entry.snapshot) {
            setStatus("Undo failed: snapshot is missing.", true);
            return;
        }
        deletedFiles = entry.deletedFiles && entry.deletedFiles instanceof Array ? entry.deletedFiles : [];
        for (i = 0; i < deletedFiles.length; i += 1) {
            if (restoreFileFromTrash(deletedFiles[i])) {
                restored += 1;
            } else if (deletedFiles[i] && deletedFiles[i].originalPath) {
                missing += 1;
            }
        }
        stateAdapterUpdate(entry.snapshot);
        if (missing > 0) {
            setStatus("Undo complete with warnings: restored " + restored + " file(s), " + missing + " file(s) could not be restored.", true);
            return;
        }
        if (restored > 0) {
            setStatus("Undo complete: " + (entry.label || "Delete") + ". Restored " + restored + " file(s).", false);
            return;
        }
        setStatus("Undo complete: " + (entry.label || "Delete"), false);
    }

    function closeFlowOptions() {
        var videoOptions = getById("videoFlowOptions");

        isVideoFlowOptionsOpen = false;
        isImageFlowOptionsOpen = false;

        if (videoOptions && videoOptions.classList) {
            videoOptions.classList.remove("is-open");
            videoOptions.hidden = true;
        }
    }

    function openFlowOptions() {
        var videoOptions = getById("videoFlowOptions");

        closeFlowOptions();
        isVideoFlowOptionsOpen = true;
        if (videoOptions && videoOptions.classList) {
            videoOptions.hidden = false;
            videoOptions.classList.add("is-open");
        }
    }

    function toggleFlowOptions() {
        if (isVideoFlowOptionsOpen) {
            closeFlowOptions();
        } else {
            openFlowOptions();
        }
    }

    function openShotPicker(target) {
        var videoOverlay = getById("videoPickerOverlay");
        var imageOverlay = getById("imagePickerOverlay");
        var isVideoTarget = false;
        var isImageTarget = false;

        closeFlowOptions();
        shotPickerContext = target || null;
        isVideoTarget = (
            target === "videoStart" ||
            target === "videoEnd" ||
            target === "videoRef" ||
            parseRefSlotIndex(target, "videoRefSlot") !== null
        );
        isImageTarget = (
            target === "imageRef" ||
            parseRefSlotIndex(target, "imageRefSlot") !== null
        );
        if (videoOverlay) {
            videoOverlay.hidden = !isVideoTarget;
        }
        if (imageOverlay) {
            imageOverlay.hidden = !isImageTarget;
        }
    }

    function closeShotPicker() {
        var videoOverlay = getById("videoPickerOverlay");
        var imageOverlay = getById("imagePickerOverlay");

        shotPickerContext = null;
        if (videoOverlay) {
            videoOverlay.hidden = true;
        }
        if (imageOverlay) {
            imageOverlay.hidden = true;
        }
    }

    function parseRefSlotIndex(contextValue, prefix) {
        var raw = trimText(contextValue || "");
        var marker = prefix + ":";
        var indexValue;
        var slotIndex;

        if (raw.indexOf(marker) !== 0) {
            return null;
        }

        indexValue = raw.substring(marker.length);
        slotIndex = parseInt(indexValue, 10);
        if (!isFinite(slotIndex) || slotIndex < 0) {
            return null;
        }

        return slotIndex;
    }

    function openMediaPreview(kind, mediaId) {
        mediaPreviewKind = kind === "image" ? "image" : (kind === "video" ? "video" : "");
        mediaPreviewId = mediaId ? String(mediaId) : "";
        closeMediaPreviewImportMenu();
        renderMediaPreviewOverlay(getState());
    }

    function closeMediaPreviewImportMenu() {
        var menu = getById("mediaPreviewImportMenu");
        if (menu) {
            menu.hidden = true;
        }
    }

    function toggleMediaPreviewImportMenu() {
        var menu = getById("mediaPreviewImportMenu");
        if (!menu) {
            return;
        }
        menu.hidden = !menu.hidden;
    }

    function closeMediaPreview() {
        var overlay = getById("mediaPreviewOverlay");
        var videoEl = getById("mediaPreviewVideo");
        var imageEl = getById("mediaPreviewImage");
        if (videoEl) {
            stopInlineVideoPreview(videoEl);
            videoEl.removeAttribute("src");
            videoEl.removeAttribute("data-current-path");
            videoEl.hidden = true;
        }
        if (imageEl) {
            imageEl.removeAttribute("src");
            imageEl.removeAttribute("data-current-path");
            imageEl.hidden = true;
        }
        if (overlay) {
            overlay.hidden = true;
        }
        closeMediaPreviewImportMenu();
        mediaPreviewKind = "";
        mediaPreviewId = "";
    }

    function applyPickedShotById(shotId) {
        var videoRefSlotIndex;
        var imageRefSlotIndex;

        if (!shotId) {
            return false;
        }

        videoRefSlotIndex = parseRefSlotIndex(shotPickerContext, "videoRefSlot");
        if (videoRefSlotIndex !== null) {
            stateAdapterUpdate({
                selectedShotId: shotId
            });
            addShotToVideoRefsById(shotId, videoRefSlotIndex);
            closeShotPicker();
            return true;
        }

        imageRefSlotIndex = parseRefSlotIndex(shotPickerContext, "imageRefSlot");
        if (imageRefSlotIndex !== null) {
            stateAdapterUpdate({
                selectedShotId: shotId
            });
            addShotToRefsById(shotId, imageRefSlotIndex);
            closeShotPicker();
            return true;
        }

        if (shotPickerContext === "videoStart") {
            stateAdapterUpdate({
                selectedShotId: shotId,
                startShotId: shotId
            });
            maybeAutoApplyVideoAspectRatioFromShotId(shotId);
            setStatus("Start frame set.", false);
            closeShotPicker();
            return true;
        }
        if (shotPickerContext === "videoEnd") {
            stateAdapterUpdate({
                selectedShotId: shotId,
                endShotId: shotId
            });
            maybeAutoApplyVideoAspectRatioFromShotId(shotId);
            setStatus("End frame set.", false);
            closeShotPicker();
            return true;
        }
        if (shotPickerContext === "videoRef") {
            stateAdapterUpdate({
                selectedShotId: shotId
            });
            addShotToVideoRefsById(shotId);
            closeShotPicker();
            return true;
        }
        if (shotPickerContext === "imageRef") {
            stateAdapterUpdate({
                selectedShotId: shotId
            });
            addShotToRefsById(shotId);
            closeShotPicker();
            return true;
        }
        return false;
    }

    function getPendingJobs(state) {
        var source = state && state.pendingJobs && state.pendingJobs instanceof Array ? state.pendingJobs : [];
        return source;
    }

    function getPendingJobsLease(state) {
        if (!state || !state.pendingJobsLease || typeof state.pendingJobsLease !== "object") {
            return null;
        }
        return state.pendingJobsLease;
    }

    function isPendingJobsLeaseActive(lease) {
        var nowMs = new Date().getTime();
        var expiresAt = lease && typeof lease.expiresAt === "number" ? lease.expiresAt : parseInt(lease && lease.expiresAt, 10);
        if (!lease || !lease.ownerId) {
            return false;
        }
        if (!isFinite(expiresAt)) {
            return false;
        }
        return expiresAt > nowMs;
    }

    function isPendingJobsLeaseOwnedByCurrentWindow(lease) {
        return !!(lease && lease.ownerId && lease.ownerId === pendingJobsRunnerId);
    }

    function writePendingJobsLease(lease) {
        stateAdapterUpdate({
            pendingJobsLease: lease || null
        });
    }

    function acquirePendingJobsLease() {
        var state = getState();
        var lease = getPendingJobsLease(state);
        var nowMs = new Date().getTime();
        var nextLease;
        var verifiedLease;

        if (isPendingJobsLeaseActive(lease) && !isPendingJobsLeaseOwnedByCurrentWindow(lease)) {
            return false;
        }

        nextLease = {
            ownerId: pendingJobsRunnerId,
            expiresAt: nowMs + PENDING_JOBS_LEASE_TTL_MS,
            updatedAt: (new Date(nowMs)).toISOString()
        };

        writePendingJobsLease(nextLease);
        verifiedLease = getPendingJobsLease(getState());
        return !!(verifiedLease && verifiedLease.ownerId === pendingJobsRunnerId && isPendingJobsLeaseActive(verifiedLease));
    }

    function refreshPendingJobsLease() {
        var state = getState();
        var lease = getPendingJobsLease(state);
        var nowMs = new Date().getTime();

        if (isPendingJobsLeaseActive(lease) && !isPendingJobsLeaseOwnedByCurrentWindow(lease)) {
            return false;
        }

        writePendingJobsLease({
            ownerId: pendingJobsRunnerId,
            expiresAt: nowMs + PENDING_JOBS_LEASE_TTL_MS,
            updatedAt: (new Date(nowMs)).toISOString()
        });
        return true;
    }

    function releasePendingJobsLease() {
        var state = getState();
        var lease = getPendingJobsLease(state);
        if (!lease || !lease.ownerId || lease.ownerId !== pendingJobsRunnerId) {
            return;
        }
        writePendingJobsLease(null);
    }

    function startPendingJobsLeaseHeartbeat() {
        if (pendingJobsLeaseHeartbeatTimer && typeof window.clearInterval === "function") {
            window.clearInterval(pendingJobsLeaseHeartbeatTimer);
            pendingJobsLeaseHeartbeatTimer = null;
        }
        if (typeof window.setInterval !== "function") {
            return;
        }
        pendingJobsLeaseHeartbeatTimer = window.setInterval(function () {
            if (!isVideoGenerating) {
                return;
            }
            if (!refreshPendingJobsLease()) {
                setGenerationStatus("Pending jobs lock lost to another window. Wait for current operation to finish.", true);
            }
        }, PENDING_JOBS_LEASE_HEARTBEAT_MS);
    }

    function stopPendingJobsLeaseHeartbeat() {
        if (pendingJobsLeaseHeartbeatTimer && typeof window.clearInterval === "function") {
            window.clearInterval(pendingJobsLeaseHeartbeatTimer);
            pendingJobsLeaseHeartbeatTimer = null;
        }
    }

    function normalizeVideoJobStatus(value) {
        var status = trimText(value).toLowerCase();
        if (ACTIVE_VIDEO_JOB_STATUSES[status]) {
            return status;
        }
        if (status === "done" || status === "failed" || status === "cancelled") {
            return status;
        }
        return "queued";
    }

    function trimPendingJobs(jobs) {
        var list = jobs && jobs instanceof Array ? jobs : [];
        var active = [];
        var terminal = [];
        var maxTerminal = 60;
        var i;
        var item;

        for (i = 0; i < list.length; i += 1) {
            item = list[i];
            if (!item || !item.id) {
                continue;
            }
            if (ACTIVE_VIDEO_JOB_STATUSES[normalizeVideoJobStatus(item.status)]) {
                active.push(item);
            } else {
                terminal.push(item);
            }
        }

        terminal.sort(function (a, b) {
            var av = a && a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            var bv = b && b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return bv - av;
        });
        if (terminal.length > maxTerminal) {
            terminal = terminal.slice(0, maxTerminal);
        }
        return active.concat(terminal);
    }

    function mutatePendingJobs(mutator) {
        var state = getState();
        var jobs = getPendingJobs(state).slice(0);
        var next = mutator && typeof mutator === "function" ? mutator(jobs) : jobs;
        if (!(next instanceof Array)) {
            next = jobs;
        }
        next = trimPendingJobs(next);
        stateAdapterUpdate({ pendingJobs: next });
        return next;
    }

    function upsertPendingJob(job) {
        mutatePendingJobs(function (jobs) {
            var next = jobs.slice(0);
            var i;
            var replaced = false;
            for (i = 0; i < next.length; i += 1) {
                if (next[i] && next[i].id === job.id) {
                    next[i] = job;
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                next.push(job);
            }
            return next;
        });
    }

    function patchPendingJob(jobId, patch) {
        if (!jobId) {
            return;
        }
        mutatePendingJobs(function (jobs) {
            var next = jobs.slice(0);
            var i;
            var item;
            for (i = 0; i < next.length; i += 1) {
                item = next[i];
                if (!item || item.id !== jobId) {
                    continue;
                }
                next[i] = {
                    id: item.id,
                    kind: item.kind,
                    batchId: item.batchId,
                    status: item.status,
                    sampleIndex: item.sampleIndex,
                    sampleCount: item.sampleCount,
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                    prompt: item.prompt,
                    modelId: item.modelId,
                    aspectRatio: item.aspectRatio,
                    imageSize: item.imageSize,
                    uiMode: item.uiMode,
                    apiMode: item.apiMode,
                    durationSeconds: item.durationSeconds,
                    resolution: item.resolution,
                    videosDir: item.videosDir,
                    startShotId: item.startShotId,
                    endShotId: item.endShotId,
                    startShotPath: item.startShotPath,
                    endShotPath: item.endShotPath,
                    startShotCompName: item.startShotCompName,
                    endShotCompName: item.endShotCompName,
                    startShotFrame: item.startShotFrame,
                    endShotFrame: item.endShotFrame,
                    references: item.references || [],
                    referenceIds: item.referenceIds || [],
                    operationName: item.operationName,
                    operationUrl: item.operationUrl,
                    requestMode: item.requestMode,
                    fallbackReason: item.fallbackReason,
                    downloadedPath: item.downloadedPath,
                    progressPercent: item.progressPercent,
                    lastStage: item.lastStage,
                    error: item.error
                };
                if (patch && typeof patch === "object") {
                    var key;
                    for (key in patch) {
                        if (patch.hasOwnProperty(key)) {
                            next[i][key] = patch[key];
                        }
                    }
                }
                next[i].updatedAt = (new Date()).toISOString();
                break;
            }
            return next;
        });
    }

    function removePendingJob(jobId) {
        if (!jobId) {
            return;
        }
        mutatePendingJobs(function (jobs) {
            var next = [];
            var i;
            for (i = 0; i < jobs.length; i += 1) {
                if (!jobs[i] || jobs[i].id === jobId) {
                    continue;
                }
                next.push(jobs[i]);
            }
            return next;
        });
    }

    function findPendingJobById(state, jobId) {
        var jobs = getPendingJobs(state);
        var i;
        for (i = 0; i < jobs.length; i += 1) {
            if (jobs[i] && jobs[i].id === jobId) {
                return jobs[i];
            }
        }
        return null;
    }

    function isActiveVideoJob(job) {
        return !!(job && job.kind === "video" && ACTIVE_VIDEO_JOB_STATUSES[normalizeVideoJobStatus(job.status)]);
    }

    function isActiveImageJob(job) {
        return !!(job && job.kind === "image" && ACTIVE_VIDEO_JOB_STATUSES[normalizeVideoJobStatus(job.status)]);
    }

    function isActivePendingJob(job) {
        return isActiveVideoJob(job) || isActiveImageJob(job);
    }

    function queueInjectedVideoJobIds(jobIds) {
        var incoming = jobIds && jobIds instanceof Array ? jobIds : [];
        var seen = {};
        var i;
        var id;
        var next = [];

        for (i = 0; i < pendingVideoInjectedJobIds.length; i += 1) {
            id = trimText(pendingVideoInjectedJobIds[i] || "");
            if (!id || seen[id]) {
                continue;
            }
            seen[id] = true;
            next.push(id);
        }

        for (i = 0; i < incoming.length; i += 1) {
            id = trimText(incoming[i] || "");
            if (!id || seen[id]) {
                continue;
            }
            seen[id] = true;
            next.push(id);
        }

        pendingVideoInjectedJobIds = next;
    }

    function drainInjectedVideoJobIds() {
        var list = pendingVideoInjectedJobIds.slice(0);
        pendingVideoInjectedJobIds = [];
        return list;
    }

    function getPendingJobUpdatedMs(job) {
        var updatedAtMs = toEpochMs(job && job.updatedAt ? job.updatedAt : "");
        if (updatedAtMs > 0) {
            return updatedAtMs;
        }
        return toEpochMs(job && job.createdAt ? job.createdAt : "");
    }

    function getPendingJobStaleThresholdMs(job) {
        var status = normalizeVideoJobStatus(job && job.status);
        if (job && job.kind === "image") {
            return PENDING_IMAGE_JOB_STALE_MS;
        }
        if (status === "polling") {
            if (job && (trimText(job.operationName) || trimText(job.operationUrl))) {
                return PENDING_VIDEO_JOB_STALE_POLLING_WITH_OPERATION_MS;
            }
            return PENDING_VIDEO_JOB_STALE_POLLING_MS;
        }
        return PENDING_VIDEO_JOB_STALE_ACTIVE_MS;
    }

    function markStalePendingJobs(options) {
        var opts = options || {};
        var state = opts.state || getState();
        var lease = getPendingJobsLease(state);
        var jobs = getPendingJobs(state);
        var nextJobs;
        var nowMs = new Date().getTime();
        var staleMap = {};
        var staleCount = 0;
        var hasStaleCandidates = false;
        var changed = false;
        var i;
        var item;
        var itemUpdatedAtMs;
        var staleThresholdMs;

        if (isVideoGenerating || isImageGenerating || isResumingPendingJobs) {
            return {
                changed: false,
                count: 0
            };
        }

        if (isPendingJobsLeaseActive(lease) && !isPendingJobsLeaseOwnedByCurrentWindow(lease)) {
            return {
                changed: false,
                count: 0
            };
        }

        for (i = 0; i < jobs.length; i += 1) {
            item = jobs[i];
            if (!item || !item.id || !isActivePendingJob(item)) {
                continue;
            }
            itemUpdatedAtMs = getPendingJobUpdatedMs(item);
            staleThresholdMs = getPendingJobStaleThresholdMs(item);
            if (!isFinite(itemUpdatedAtMs) || itemUpdatedAtMs <= 0) {
                staleMap[item.id] = true;
                hasStaleCandidates = true;
                continue;
            }
            if (!isFinite(staleThresholdMs) || staleThresholdMs < 1000) {
                staleThresholdMs = 1000;
            }
            if ((nowMs - itemUpdatedAtMs) >= staleThresholdMs) {
                staleMap[item.id] = true;
                hasStaleCandidates = true;
            }
        }

        if (!hasStaleCandidates) {
            return {
                changed: false,
                count: 0
            };
        }

        nextJobs = jobs.slice(0);
        for (i = 0; i < nextJobs.length; i += 1) {
            item = nextJobs[i];
            if (!item || !item.id || !staleMap[item.id]) {
                continue;
            }
            if (!isActivePendingJob(item)) {
                continue;
            }
            nextJobs[i] = {
                id: item.id,
                kind: item.kind,
                batchId: item.batchId,
                status: "failed",
                sampleIndex: item.sampleIndex,
                sampleCount: item.sampleCount,
                createdAt: item.createdAt,
                updatedAt: (new Date()).toISOString(),
                prompt: item.prompt,
                modelId: item.modelId,
                aspectRatio: item.aspectRatio,
                imageSize: item.imageSize,
                uiMode: item.uiMode,
                apiMode: item.apiMode,
                durationSeconds: item.durationSeconds,
                resolution: item.resolution,
                videosDir: item.videosDir,
                startShotId: item.startShotId,
                endShotId: item.endShotId,
                startShotPath: item.startShotPath,
                endShotPath: item.endShotPath,
                startShotCompName: item.startShotCompName,
                endShotCompName: item.endShotCompName,
                startShotFrame: item.startShotFrame,
                endShotFrame: item.endShotFrame,
                references: item.references || [],
                referenceIds: item.referenceIds || [],
                operationName: item.operationName,
                operationUrl: item.operationUrl,
                requestMode: item.requestMode,
                fallbackReason: item.fallbackReason,
                downloadedPath: item.downloadedPath,
                progressPercent: 0,
                lastStage: "Interrupted",
                error: CARD_INTERRUPTED_MESSAGE
            };
            staleCount += 1;
            changed = true;
        }

        if (changed) {
            stateAdapterUpdate({
                pendingJobs: trimPendingJobs(nextJobs)
            });
        }

        if (staleCount > 0 && opts.notify !== false) {
            setStatus("Detected interrupted jobs. Marked " + staleCount + " pending item(s) as failed.", true);
        }

        return {
            changed: changed,
            count: staleCount
        };
    }

    function startPendingJobsStaleWatcher() {
        if (pendingJobsStaleTimer || typeof window.setInterval !== "function") {
            return;
        }
        pendingJobsStaleTimer = window.setInterval(function () {
            markStalePendingJobs({
                notify: true
            });
        }, PENDING_JOBS_STALE_SCAN_MS);
    }

    function stopPendingJobsStaleWatcher() {
        if (pendingJobsStaleTimer && typeof window.clearInterval === "function") {
            window.clearInterval(pendingJobsStaleTimer);
            pendingJobsStaleTimer = null;
        }
    }

    function mapVideoStageToJobStatus(stage) {
        var text = trimText(stage).toLowerCase();
        if (text.indexOf("poll") === 0) {
            return "polling";
        }
        if (text.indexOf("generat") === 0) {
            return "polling";
        }
        if (text.indexOf("download") === 0) {
            return "downloading";
        }
        if (text.indexOf("import") === 0) {
            return "importing";
        }
        if (text.indexOf("upload") === 0) {
            return "uploading";
        }
        return "uploading";
    }

    function getVideoGenSettings(state) {
        var source = state && state.videoGenSettings ? state.videoGenSettings : {};
        return {
            mode: normalizeVideoMode(source.mode),
            model: trimText(source.model || (window.VeoApi ? window.VeoApi.DEFAULT_MODEL_ID : "veo-3.1-generate-preview")) || "veo-3.1-generate-preview",
            aspectRatio: normalizeAspectRatio(source.aspectRatio || "16:9"),
            durationSeconds: parseInt(source.durationSeconds, 10) || 8,
            resolution: String(source.resolution || "720p").toLowerCase()
        };
    }

    function getVideoRefs(state) {
        return state && state.videoRefs && state.videoRefs instanceof Array ? state.videoRefs : [];
    }

    function findShotById(shots, id) {
        var i;
        if (!shots || !id) {
            return null;
        }
        for (i = 0; i < shots.length; i += 1) {
            if (shots[i] && shots[i].id === id) {
                return shots[i];
            }
        }
        return null;
    }

    function findVideoById(videos, id) {
        var i;
        if (!videos || !id) {
            return null;
        }
        for (i = 0; i < videos.length; i += 1) {
            if (videos[i] && videos[i].id === id) {
                return videos[i];
            }
        }
        return null;
    }

    function findImageById(images, id) {
        var i;
        if (!images || !id) {
            return null;
        }
        for (i = 0; i < images.length; i += 1) {
            if (images[i] && images[i].id === id) {
                return images[i];
            }
        }
        return null;
    }

    function makeId(prefix) {
        return prefix + "_" + String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 100000));
    }

    function formatShotLabel(shot) {
        var head;
        var frame;

        if (!shot) {
            return "Not selected";
        }

        head = shot.compName || baseName(shot.path) || "Shot";
        frame = shot.frame != null ? shot.frame : "-";
        return head + " | frame " + frame;
    }

    function formatImageLabel(image) {
        if (!image) {
            return "Not selected";
        }
        return baseName(image.path || "") + " | " + (image.aspectRatio || "-") + " | " + formatDate(image.createdAt);
    }

    function readImageDimensions(filePath) {
        return new Promise(function (resolve, reject) {
            var img;

            if (!filePath) {
                reject(new Error("Image path is required."));
                return;
            }

            if (typeof Image === "undefined") {
                reject(new Error("Image API is unavailable."));
                return;
            }

            img = new Image();
            img.onload = function () {
                resolve({
                    width: img.naturalWidth || img.width || null,
                    height: img.naturalHeight || img.height || null
                });
            };
            img.onerror = function () {
                reject(new Error("Failed to load image: " + filePath));
            };
            img.src = toFileUrl(filePath);
        });
    }

    function fileBaseNameWithoutExt(filePath) {
        var name = baseName(filePath || "");
        var dotIndex = name.lastIndexOf(".");
        if (dotIndex > 0) {
            return name.substring(0, dotIndex);
        }
        return name || "video";
    }

    function sanitizeFileStem(stem) {
        return String(stem || "video")
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "") || "video";
    }

    function dataUrlToBase64(dataUrl) {
        var raw = String(dataUrl || "");
        var comma = raw.indexOf(",");
        if (comma < 0) {
            return "";
        }
        return raw.substring(comma + 1);
    }

    function writePngDataUrlToFile(targetPath, dataUrl) {
        var base64Payload = dataUrlToBase64(dataUrl);

        if (!fs || !targetPath || !base64Payload) {
            return false;
        }

        try {
            if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
                fs.writeFileSync(targetPath, Buffer.from(base64Payload, "base64"));
            } else {
                fs.writeFileSync(targetPath, base64Payload, "base64");
            }
            return true;
        } catch (writeError) {
            return false;
        }
    }

    function captureCurrentPreviewVideoFrame() {
        var state;
        var videoRecord;
        var videoEl;
        var captureBtn;
        var frameDir;
        var framePath;
        var fileName;
        var nowIso;
        var frameTime;
        var canvas;
        var context2d;
        var pngDataUrl = "";
        var appended = false;

        function finishCapture(shotData, isError, statusText) {
            var nextState;
            var shots;
            var finalError = !!isError;
            var finalStatus = statusText || "";

            if (!isError && shotData) {
                try {
                    nextState = getState();
                    shots = nextState.shots ? nextState.shots.slice(0) : [];
                    shots.push(shotData);
                    stateAdapterUpdate({
                        shots: shots,
                        selectedShotId: shotData.id
                    });
                    appended = true;
                } catch (stateError) {
                    finalError = true;
                    finalStatus = "Frame was captured, but failed to update Captured Frames state.";
                }
            }

            isCapturingPreviewFrame = false;
            if (captureBtn) {
                captureBtn.disabled = false;
            }
            if (finalStatus) {
                setStatus(finalStatus, finalError);
            }
            if (!appended) {
                renderMediaPreviewOverlay(getState());
            }
        }

        if (isCapturingPreviewFrame) {
            setStatus("Frame capture is already running.", true);
            return;
        }

        if (mediaPreviewKind !== "video" || !mediaPreviewId) {
            setStatus("Open a video preview first.", true);
            return;
        }

        state = getState();
        videoRecord = findVideoById(state.videos || [], mediaPreviewId);
        videoEl = getById("mediaPreviewVideo");
        captureBtn = getById("btnMediaPreviewCapture");

        if (!videoRecord || !videoRecord.path) {
            setStatus("Selected video is unavailable.", true);
            return;
        }
        if (!fileExists(videoRecord.path)) {
            setStatus("Video file is missing on disk.", true);
            return;
        }
        if (!videoEl || videoEl.hidden) {
            setStatus("Video preview is not ready.", true);
            return;
        }
        if ((videoEl.readyState || 0) < 2) {
            setStatus("Video frame is not ready yet. Pause or seek and try again.", true);
            return;
        }
        if (!(videoEl.videoWidth > 0) || !(videoEl.videoHeight > 0)) {
            setStatus("Unable to read current frame dimensions.", true);
            return;
        }

        frameDir = resolveFramesCaptureDir(videoRecord.path);
        if (!frameDir) {
            setStatus("Unable to prepare Frames folder for capture.", true);
            return;
        }

        fileName = "";
        if (window.VeoApi && typeof window.VeoApi.buildMediaFileName === "function") {
            try {
                fileName = window.VeoApi.buildMediaFileName({
                    prompt: videoRecord.prompt || fileBaseNameWithoutExt(videoRecord.path),
                    mediaType: "image",
                    mode: "frame",
                    aspectRatio: videoRecord.aspectRatio || "16:9",
                    sampleIndex: videoRecord.sampleIndex || 1,
                    sampleCount: videoRecord.sampleCount || 1,
                    modelId: videoRecord.model || "",
                    ext: ".png"
                });
            } catch (nameError) {
                fileName = "";
            }
        }
        if (!fileName) {
            fileName = sanitizeFileStem(fileBaseNameWithoutExt(videoRecord.path)) + "_frame_" + String(new Date().getTime()) + ".png";
        }

        framePath = path.join(frameDir, fileName);

        canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        context2d = canvas.getContext("2d");
        if (!context2d || typeof context2d.drawImage !== "function") {
            setStatus("Canvas capture is unavailable in this environment.", true);
            return;
        }

        isCapturingPreviewFrame = true;
        if (captureBtn) {
            captureBtn.disabled = true;
        }

        try {
            context2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            pngDataUrl = canvas.toDataURL("image/png");
        } catch (captureError) {
            finishCapture(null, true, "Failed to capture current frame from video preview.");
            return;
        }

        if (!writePngDataUrlToFile(framePath, pngDataUrl) || !fileExists(framePath)) {
            finishCapture(null, true, "Failed to save captured frame to disk.");
            return;
        }

        nowIso = (new Date()).toISOString();
        frameTime = typeof videoEl.currentTime === "number" && isFinite(videoEl.currentTime)
            ? Math.round(videoEl.currentTime * 1000) / 1000
            : null;
        setStatus("Saving captured frame...", false);

        readImageDimensions(framePath).then(function (size) {
            var shot = {
                id: makeId("shot"),
                path: framePath,
                compName: fileBaseNameWithoutExt(videoRecord.path) || "Generated Video",
                frame: frameTime,
                createdAt: nowIso,
                width: size && size.width ? size.width : videoEl.videoWidth,
                height: size && size.height ? size.height : videoEl.videoHeight
            };
            finishCapture(shot, false, "Captured frame added to Captured Frames.");
        }, function () {
            var shot = {
                id: makeId("shot"),
                path: framePath,
                compName: fileBaseNameWithoutExt(videoRecord.path) || "Generated Video",
                frame: frameTime,
                createdAt: nowIso,
                width: videoEl.videoWidth || null,
                height: videoEl.videoHeight || null
            };
            finishCapture(shot, false, "Captured frame added to Captured Frames.");
        });
    }

    function renderSummaryCard(shot, wrapId, imageId, labelId, emptyText) {
        var wrap = getById(wrapId);
        var image = getById(imageId);
        var label = getById(labelId);
        var placeholder = wrap ? wrap.getElementsByTagName("span")[0] : null;

        if (!wrap || !image || !label) {
            return;
        }

        label.textContent = formatShotLabel(shot);

        if (shot && shot.path) {
            image.src = toFileUrl(shot.path);
            image.hidden = false;
            wrap.className = "frame-thumb";
            if (placeholder) {
                placeholder.hidden = true;
            }
        } else {
            image.hidden = true;
            image.removeAttribute("src");
            wrap.className = "frame-thumb frame-thumb-empty";
            if (placeholder) {
                placeholder.hidden = false;
                placeholder.textContent = emptyText;
            }
        }
    }

    function scrollIntoViewSafe(element) {
        if (!element || typeof element.scrollIntoView !== "function") {
            return;
        }

        try {
            element.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
                inline: "center"
            });
        } catch (error) {
            element.scrollIntoView(false);
        }
    }

    function updateCarouselDensity() {
        var configs = [
            { id: "shotsList", minItemHeight: 296, maxRows: 4, itemSelector: ".shot-item", minItemWidth: 272, maxItemWidth: 336 },
            { id: "videosList", minItemHeight: 148, maxRows: 4 },
            { id: "videoRefsList", minItemHeight: 190, maxRows: 3, itemSelector: ".ref-item", minItemWidth: 132, maxItemWidth: 156 },
            { id: "imageShotsList", minItemHeight: 296, maxRows: 4, itemSelector: ".shot-item", minItemWidth: 272, maxItemWidth: 336 },
            { id: "imagesList", minItemHeight: 148, maxRows: 4 },
            { id: "refsList", minItemHeight: 190, maxRows: 4, itemSelector: ".ref-item", minItemWidth: 132, maxItemWidth: 156 }
        ];
        var i;
        var cfg;
        var list;
        var height;
        var rows;
        var itemCount;
        var colsNeeded;
        var widthCandidate;
        var availableWidth;
        var gap = 10;

        for (i = 0; i < configs.length; i += 1) {
            cfg = configs[i];
            list = getById(cfg.id);
            if (!list || !list.style) {
                continue;
            }

            if (list.className && String(list.className).indexOf("items-grid-scroll") >= 0) {
                list.style.removeProperty("--carousel-rows");
                list.style.removeProperty("--item-width");
                continue;
            }

            height = list.clientHeight || 0;
            if (height <= 0) {
                list.style.setProperty("--carousel-rows", "1");
                continue;
            }

            rows = Math.floor((height + gap) / (cfg.minItemHeight + gap));
            if (rows < 1) {
                rows = 1;
            }
            if (cfg.maxRows && rows > cfg.maxRows) {
                rows = cfg.maxRows;
            }

            list.style.setProperty("--carousel-rows", String(rows));

            if (cfg.itemSelector && cfg.minItemWidth && cfg.maxItemWidth && list.querySelectorAll) {
                itemCount = list.querySelectorAll(cfg.itemSelector).length;
                if (itemCount > 0) {
                    colsNeeded = Math.ceil(itemCount / rows);
                    if (colsNeeded < 1) {
                        colsNeeded = 1;
                    }
                    availableWidth = list.clientWidth || 0;
                    if (availableWidth > 0) {
                        widthCandidate = Math.floor((availableWidth - ((colsNeeded - 1) * gap)) / colsNeeded);
                        if (widthCandidate < cfg.minItemWidth) {
                            widthCandidate = cfg.minItemWidth;
                        }
                        if (widthCandidate > cfg.maxItemWidth) {
                            widthCandidate = cfg.maxItemWidth;
                        }
                        list.style.setProperty("--item-width", String(widthCandidate) + "px");
                    } else {
                        list.style.removeProperty("--item-width");
                    }
                } else {
                    list.style.removeProperty("--item-width");
                }
            } else {
                list.style.removeProperty("--item-width");
            }
        }
    }

    function appendShotHoverActions(thumbWrap, shotId) {
        var actionsWrap;
        var revealBtn;
        var deleteBtn;

        if (!thumbWrap || !shotId) {
            return;
        }

        actionsWrap = document.createElement("div");
        actionsWrap.className = "shot-card-actions";

        revealBtn = document.createElement("button");
        revealBtn.type = "button";
        revealBtn.className = "shot-card-action-btn";
        revealBtn.textContent = "Reveal";
        revealBtn.title = "Reveal in file manager";
        revealBtn.addEventListener("click", function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            if (event && typeof event.stopPropagation === "function") {
                event.stopPropagation();
            }
            revealSelectedShot(shotId);
        });
        actionsWrap.appendChild(revealBtn);

        deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "shot-card-action-btn is-danger";
        deleteBtn.textContent = "Delete";
        deleteBtn.title = "Delete frame";
        deleteBtn.addEventListener("click", function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            if (event && typeof event.stopPropagation === "function") {
                event.stopPropagation();
            }
            deleteSelectedShot(shotId);
        });
        actionsWrap.appendChild(deleteBtn);

        thumbWrap.appendChild(actionsWrap);
    }

    function renderShotsList(state) {
        var list = getById("shotsList");
        var shots = state.shots ? state.shots.slice(0).reverse() : [];
        var i;
        var shot;
        var item;
        var thumbWrap;
        var thumb;
        var badge;
        var caption;
        var selectedEl = null;

        if (!list) {
            return;
        }

        list.innerHTML = "";
        if (!shots.length) {
            item = document.createElement("div");
            item.className = "muted-note";
            item.textContent = "No captured frames yet.";
            list.appendChild(item);
            return;
        }

        for (i = 0; i < shots.length; i += 1) {
            shot = shots[i];

            item = document.createElement("div");
            item.className = "shot-item is-draggable" + (shot.id === state.selectedShotId ? " is-selected" : "");
            item.setAttribute("data-shot-id", shot.id);
            item.setAttribute("role", "button");
            item.setAttribute("tabindex", "0");
            item.setAttribute("draggable", "true");
            if (shot.id === state.selectedShotId) {
                selectedEl = item;
            }

            thumbWrap = document.createElement("div");
            thumbWrap.className = "shot-thumb-wrap";

            thumb = document.createElement("img");
            thumb.className = "shot-thumb";
            thumb.alt = shot.compName || shot.id || "shot";
            if (shot.path) {
                thumb.src = toFileUrl(shot.path);
            }
            thumbWrap.appendChild(thumb);

            if (state.startShotId && shot.id === state.startShotId) {
                badge = document.createElement("span");
                badge.className = "shot-badge start";
                badge.textContent = "Start";
                thumbWrap.appendChild(badge);
            }

            if (state.endShotId && shot.id === state.endShotId) {
                badge = document.createElement("span");
                badge.className = "shot-badge end";
                badge.textContent = "End";
                thumbWrap.appendChild(badge);
            }

            appendShotHoverActions(thumbWrap, shot.id);

            item.appendChild(thumbWrap);

            caption = document.createElement("div");
            caption.className = "shot-caption";
            caption.textContent = (shot.compName || baseName(shot.path) || "Shot") + " | frame " + (shot.frame != null ? shot.frame : "-");
            item.appendChild(caption);

            item.addEventListener("click", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : null;
                if (!shotId) {
                    return;
                }
                if (applyPickedShotById(shotId)) {
                    return;
                }
                stateAdapterUpdate({ selectedShotId: shotId });
            });

            item.addEventListener("keydown", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : null;
                if (!shotId) {
                    return;
                }
                if (event.key === "Enter" || event.key === " ") {
                    if (typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    stateAdapterUpdate({ selectedShotId: shotId });
                }
            });

            item.addEventListener("dragstart", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : "";
                var dt = event.dataTransfer;
                if (!shotId || !dt) {
                    return;
                }
                try {
                    dt.effectAllowed = "copy";
                    dt.setData("application/x-veobridge-shot-id", shotId);
                    dt.setData("text/plain", shotId);
                } catch (error) {
                    // ignore DnD data errors in older CEP
                }
            });

            list.appendChild(item);
        }

        if (selectedEl) {
            scrollIntoViewSafe(selectedEl);
        }
    }

    function renderImageShotsList(state) {
        var list = getById("imageShotsList");
        var shots = state.shots ? state.shots.slice(0).reverse() : [];
        var i;
        var shot;
        var item;
        var thumbWrap;
        var thumb;
        var badge;
        var caption;
        var selectedEl = null;

        if (!list) {
            return;
        }

        list.innerHTML = "";
        if (!shots.length) {
            item = document.createElement("div");
            item.className = "muted-note";
            item.textContent = "No captured frames yet.";
            list.appendChild(item);
            return;
        }

        for (i = 0; i < shots.length; i += 1) {
            shot = shots[i];

            item = document.createElement("div");
            item.className = "shot-item is-draggable" + (shot.id === state.selectedShotId ? " is-selected" : "");
            item.setAttribute("data-shot-id", shot.id);
            item.setAttribute("role", "button");
            item.setAttribute("tabindex", "0");
            item.setAttribute("draggable", "true");
            if (shot.id === state.selectedShotId) {
                selectedEl = item;
            }

            thumbWrap = document.createElement("div");
            thumbWrap.className = "shot-thumb-wrap";

            thumb = document.createElement("img");
            thumb.className = "shot-thumb";
            thumb.alt = shot.compName || shot.id || "shot";
            if (shot.path) {
                thumb.src = toFileUrl(shot.path);
            }
            thumbWrap.appendChild(thumb);

            if (state.startShotId && shot.id === state.startShotId) {
                badge = document.createElement("span");
                badge.className = "shot-badge start";
                badge.textContent = "Start";
                thumbWrap.appendChild(badge);
            }

            if (state.endShotId && shot.id === state.endShotId) {
                badge = document.createElement("span");
                badge.className = "shot-badge end";
                badge.textContent = "End";
                thumbWrap.appendChild(badge);
            }

            appendShotHoverActions(thumbWrap, shot.id);

            item.appendChild(thumbWrap);

            caption = document.createElement("div");
            caption.className = "shot-caption";
            caption.textContent = (shot.compName || baseName(shot.path) || "Shot") + " | frame " + (shot.frame != null ? shot.frame : "-");
            item.appendChild(caption);

            item.addEventListener("click", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : null;
                if (!shotId) {
                    return;
                }
                if (applyPickedShotById(shotId)) {
                    return;
                }
                stateAdapterUpdate({ selectedShotId: shotId });
            });

            item.addEventListener("keydown", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : null;
                if (!shotId) {
                    return;
                }
                if (event.key === "Enter" || event.key === " ") {
                    if (typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    stateAdapterUpdate({ selectedShotId: shotId });
                }
            });

            item.addEventListener("dragstart", function (event) {
                var target = event.currentTarget;
                var shotId = target ? target.getAttribute("data-shot-id") : "";
                var dt = event.dataTransfer;
                if (!shotId || !dt) {
                    return;
                }
                try {
                    dt.effectAllowed = "copy";
                    dt.setData("application/x-veobridge-shot-id", shotId);
                    dt.setData("text/plain", shotId);
                } catch (error) {
                    // ignore DnD data errors in older CEP
                }
            });

            list.appendChild(item);
        }

        if (selectedEl) {
            scrollIntoViewSafe(selectedEl);
        }
    }

    function requestModeLabel(value) {
        if (value === "text") {
            return "Text";
        }
        if (value === "image") {
            return "Image";
        }
        if (value === "interpolation") {
            return "Frames";
        }
        if (value === "reference" || value === "reference_fallback_parameters") {
            return "Reference";
        }
        if (value === "text_only_fallback") {
            return "Text fallback";
        }
        return value || "Video";
    }

    function toEpochMs(value) {
        var ms = new Date(value || "").getTime();
        if (!isFinite(ms)) {
            return 0;
        }
        return ms;
    }

    function getVideoJobStateLabel(status, lastStage) {
        var normalized = normalizeVideoJobStatus(status);
        if (normalized === "failed") {
            if (trimText(lastStage).toLowerCase() === "interrupted") {
                return "Interrupted";
            }
            return "Error";
        }
        if (normalized === "cancelled") {
            return "Cancelled";
        }
        if (normalized === "queued") {
            return "Idle";
        }
        if (normalized === "uploading") {
            return "Uploading";
        }
        if (normalized === "polling") {
            return "Generating";
        }
        if (normalized === "downloading") {
            return "Downloading";
        }
        if (normalized === "importing") {
            return "Importing";
        }
        if (lastStage) {
            return trimText(lastStage);
        }
        return "Generating";
    }

    function getVideoJobStateClass(status) {
        var normalized = normalizeVideoJobStatus(status);
        if (normalized === "failed" || normalized === "cancelled") {
            return "error";
        }
        if (normalized === "queued") {
            return "idle";
        }
        return "generating";
    }

    function statusRank(stateClass) {
        if (stateClass === "error") {
            return 5;
        }
        if (stateClass === "generating") {
            return 4;
        }
        if (stateClass === "idle") {
            return 3;
        }
        if (stateClass === "missing") {
            return 2;
        }
        return 1;
    }

    function getAspectClass(aspectRatio) {
        var ratio = trimText(aspectRatio || "").toLowerCase();
        if (ratio === "9:16") {
            return "is-portrait";
        }
        if (ratio === "1:1") {
            return "is-square";
        }
        return "is-landscape";
    }

    function collectUnifiedMediaGroups(state) {
        var groups = [];
        var map = {};
        var activeProgressJobIds = {};
        var jobs = getPendingJobs(state);
        var videos = state.videos || [];
        var images = state.images || [];
        var i;
        var j;
        var key;
        var item;
        var group;
        var createdAt;
        var isMissing;
        var expectedCount;
        var activeJobCount;
        var slots;
        var fallbackItems;
        var filledItems;
        var slotStateClass;
        var slotStateLabel;
        var slotIndex;
        var rawIndex;

        function ensureGroup(groupKey, kind, createdIso) {
            var next;
            if (map[groupKey]) {
                return map[groupKey];
            }
            next = {
                key: groupKey,
                kind: kind,
                prompt: "",
                model: "",
                modeLabel: kind === "video" ? "Frames" : "Image",
                aspectRatio: "",
                imageSize: "",
                sampleCount: 1,
                refsCount: 0,
                sourceMode: kind === "video" ? VIDEO_MODE_FRAMES : "image",
                startShotId: null,
                endShotId: null,
                startShotPath: "",
                endShotPath: "",
                referenceIds: [],
                referencePaths: [],
                createdAt: createdIso || "",
                timeMs: toEpochMs(createdIso || ""),
                items: [],
                pendingJobsCount: 0,
                activePendingJobsCount: 0,
                hasPendingJobs: false,
                stateClass: "done",
                stateLabel: "Done",
                error: ""
            };
            map[groupKey] = next;
            groups.push(next);
            return next;
        }

        function applyState(nextGroup, nextClass, nextLabel, nextError) {
            var currentRank = statusRank(nextGroup.stateClass);
            var nextRank = statusRank(nextClass);
            if (nextRank >= currentRank) {
                nextGroup.stateClass = nextClass;
                nextGroup.stateLabel = nextLabel;
                nextGroup.error = nextError || "";
            }
        }

        function normalizeExpectedCount(value, fallback) {
            var num = parseInt(value, 10);
            if (!isFinite(num) || num < 1) {
                num = parseInt(fallback, 10);
            }
            if (!isFinite(num) || num < 1) {
                num = 1;
            }
            if (num > 8) {
                num = 8;
            }
            return num;
        }

        for (i = 0; i < jobs.length; i += 1) {
            item = jobs[i];
            if (!item || (item.kind !== "video" && item.kind !== "image")) {
                continue;
            }
            if (normalizeVideoJobStatus(item.status) === "done") {
                continue;
            }

            if (item.kind === "video") {
                var videoJobStateClass = getVideoJobStateClass(item.status);
                var videoJobLabel = getVideoJobStateLabel(item.status, item.lastStage);
                var videoJobError = trimText(item.error || "");
                var exactVideoProgress = normalizeProgressPercent(item.progressPercent);
                var videoProgress = exactVideoProgress;
                var videoStageHint = item.lastStage || item.status || "";
                var videoStageFallback = stageToProgressPercent(videoStageHint);
                var isVideoProgressExact = exactVideoProgress !== null;
                if (isVideoProgressExact && videoStageFallback !== null && exactVideoProgress === videoStageFallback) {
                    isVideoProgressExact = false;
                }
                if (videoProgress === null) {
                    videoProgress = videoStageFallback;
                }
                videoProgress = smoothProgressForJob(item.id, videoProgress, videoJobStateClass, activeProgressJobIds, videoStageHint, isVideoProgressExact);
                if (isHighLoadErrorMessage(videoJobError)) {
                    videoJobError = CARD_HIGH_LOAD_MESSAGE;
                }
                if (videoJobStateClass === "error") {
                    if (!videoJobLabel) {
                        videoJobLabel = "Error";
                    }
                } else if (videoJobStateClass === "generating" && videoProgress !== null && videoProgress >= 1 && videoProgress <= 99) {
                    videoJobLabel = String(videoProgress) + "%";
                }
                key = "video:" + (item.batchId || item.id);
                createdAt = item.createdAt || item.updatedAt || "";
                group = ensureGroup(key, "video", createdAt);
                group.prompt = group.prompt || trimText(item.prompt || "");
                group.model = group.model || trimText(item.modelId || "");
                group.modeLabel = requestModeLabel(item.apiMode || item.uiMode || "");
                group.aspectRatio = group.aspectRatio || normalizeAspectRatio(item.aspectRatio || "16:9");
                group.sampleCount = item.sampleCount || group.sampleCount || 1;
                group.sourceMode = normalizeVideoMode(item.uiMode || (item.apiMode === "reference" ? VIDEO_MODE_REFERENCE : VIDEO_MODE_FRAMES));
                if (!group.startShotId && item.startShotId) {
                    group.startShotId = item.startShotId;
                }
                if (!group.endShotId && item.endShotId) {
                    group.endShotId = item.endShotId;
                }
                if (!group.startShotPath && item.startShotPath) {
                    group.startShotPath = item.startShotPath;
                }
                if (!group.endShotPath && item.endShotPath) {
                    group.endShotPath = item.endShotPath;
                }
                if (item.referenceIds && item.referenceIds instanceof Array) {
                    group.refsCount = item.referenceIds.length;
                    if (!group.referenceIds.length) {
                        group.referenceIds = item.referenceIds.slice(0);
                    }
                }
                if (item.references && item.references instanceof Array && !group.referencePaths.length) {
                    for (j = 0; j < item.references.length; j += 1) {
                        if (item.references[j] && item.references[j].path) {
                            group.referencePaths.push(item.references[j].path);
                        }
                    }
                }
                group.pendingJobsCount += 1;
                if (ACTIVE_VIDEO_JOB_STATUSES[normalizeVideoJobStatus(item.status)]) {
                    group.activePendingJobsCount += 1;
                }

                createdAt = item.updatedAt || item.createdAt || "";
                group.items.push({
                    kind: "video-job",
                    id: item.id,
                    sampleIndex: item.sampleIndex || 0,
                    sampleCount: item.sampleCount || group.sampleCount || 1,
                    createdAt: createdAt,
                    timeMs: toEpochMs(createdAt),
                    status: normalizeVideoJobStatus(item.status),
                    stateLabel: videoJobLabel,
                    stateClass: videoJobStateClass,
                    error: videoJobError,
                    progressPercent: videoProgress,
                    aspectRatio: normalizeAspectRatio(item.aspectRatio || group.aspectRatio || "16:9"),
                    previewPath: item.startShotPath || item.endShotPath || ((item.references && item.references[0] && item.references[0].path) ? item.references[0].path : "")
                });
                applyState(group, videoJobStateClass, videoJobLabel, videoJobError);
                continue;
            }

            var imageJobStateClass = getVideoJobStateClass(item.status);
            var imageJobLabel = getVideoJobStateLabel(item.status, item.lastStage);
            var imageJobError = trimText(item.error || "");
            var exactImageProgress = normalizeProgressPercent(item.progressPercent);
            var imageProgress = exactImageProgress;
            var imageStageHint = item.lastStage || item.status || "";
            var imageStageFallback = stageToProgressPercent(imageStageHint);
            var isImageProgressExact = exactImageProgress !== null;
            if (isImageProgressExact && imageStageFallback !== null && exactImageProgress === imageStageFallback) {
                isImageProgressExact = false;
            }
            if (imageProgress === null) {
                imageProgress = imageStageFallback;
            }
            imageProgress = smoothProgressForJob(item.id, imageProgress, imageJobStateClass, activeProgressJobIds, imageStageHint, isImageProgressExact);
            if (isHighLoadErrorMessage(imageJobError)) {
                imageJobError = CARD_HIGH_LOAD_MESSAGE;
            }
            if (imageJobStateClass === "error") {
                if (!imageJobLabel) {
                    imageJobLabel = "Error";
                }
            } else if (imageJobStateClass === "generating" && imageProgress !== null && imageProgress >= 1 && imageProgress <= 99) {
                imageJobLabel = String(imageProgress) + "%";
            }
            key = "image:" + (item.batchId || item.id);
            createdAt = item.createdAt || item.updatedAt || "";
            group = ensureGroup(key, "image", createdAt);
            group.prompt = group.prompt || trimText(item.prompt || "");
            group.model = group.model || trimText(item.modelId || "");
            group.modeLabel = "Image";
            group.aspectRatio = group.aspectRatio || normalizeImageAspectRatio(item.aspectRatio || "1:1");
            group.imageSize = group.imageSize || normalizeImageSize(item.imageSize || "1K");
            group.sampleCount = item.sampleCount || group.sampleCount || 1;
            group.sourceMode = "image";
            if (item.references && item.references instanceof Array && !group.referencePaths.length) {
                for (j = 0; j < item.references.length; j += 1) {
                    if (item.references[j] && item.references[j].path) {
                        group.referencePaths.push(item.references[j].path);
                    }
                }
            }
            group.pendingJobsCount += 1;
            if (ACTIVE_VIDEO_JOB_STATUSES[normalizeVideoJobStatus(item.status)]) {
                group.activePendingJobsCount += 1;
            }

            createdAt = item.updatedAt || item.createdAt || "";
            group.items.push({
                kind: "image-job",
                id: item.id,
                sampleIndex: item.sampleIndex || 0,
                sampleCount: item.sampleCount || group.sampleCount || 1,
                createdAt: createdAt,
                timeMs: toEpochMs(createdAt),
                status: normalizeVideoJobStatus(item.status),
                stateLabel: imageJobLabel,
                stateClass: imageJobStateClass,
                error: imageJobError,
                progressPercent: imageProgress,
                aspectRatio: normalizeImageAspectRatio(item.aspectRatio || group.aspectRatio || "1:1"),
                previewPath: (item.references && item.references[0] && item.references[0].path) ? item.references[0].path : ""
            });
            applyState(group, imageJobStateClass, imageJobLabel, imageJobError);
        }

        for (i = 0; i < videos.length; i += 1) {
            item = videos[i] || {};
            key = "video:" + (item.batchId || item.id);
            createdAt = item.createdAt || "";
            group = ensureGroup(key, "video", createdAt);
            group.prompt = group.prompt || trimText(item.prompt || "");
            group.model = group.model || trimText(item.model || "");
            group.modeLabel = requestModeLabel(item.requestMode || item.mode || "");
            group.aspectRatio = group.aspectRatio || normalizeAspectRatio(item.aspectRatio || "16:9");
            group.sampleCount = item.sampleCount || group.sampleCount || 1;
            group.sourceMode = normalizeVideoMode(item.mode || (item.requestMode === "reference" ? VIDEO_MODE_REFERENCE : VIDEO_MODE_FRAMES));
            if (!group.startShotId && item.startShotId) {
                group.startShotId = item.startShotId;
            }
            if (!group.endShotId && item.endShotId) {
                group.endShotId = item.endShotId;
            }
            if (!group.startShotPath && item.startShotPath) {
                group.startShotPath = item.startShotPath;
            }
            if (!group.endShotPath && item.endShotPath) {
                group.endShotPath = item.endShotPath;
            }
            if (item.refIds && item.refIds instanceof Array) {
                group.refsCount = item.refIds.length;
                if (!group.referenceIds.length) {
                    group.referenceIds = item.refIds.slice(0);
                }
            }
            if (item.refPaths && item.refPaths instanceof Array && !group.referencePaths.length) {
                for (j = 0; j < item.refPaths.length; j += 1) {
                    if (item.refPaths[j]) {
                        group.referencePaths.push(item.refPaths[j]);
                    }
                }
            }

            isMissing = item.path ? !fileExists(item.path) : true;
            group.items.push({
                kind: "video",
                id: item.id,
                sampleIndex: item.sampleIndex || 0,
                sampleCount: item.sampleCount || group.sampleCount || 1,
                createdAt: createdAt,
                timeMs: toEpochMs(createdAt),
                path: item.path || "",
                aspectRatio: normalizeAspectRatio(item.aspectRatio || group.aspectRatio || "16:9"),
                importedToProject: !!item.importedToProject,
                projectImportPath: item.projectImportPath || "",
                stateLabel: isMissing ? "Missing file" : "Done",
                stateClass: isMissing ? "missing" : "done"
            });
            applyState(group, isMissing ? "missing" : "done", isMissing ? "Missing file" : "Done", "");
        }

        for (i = 0; i < images.length; i += 1) {
            item = images[i] || {};
            key = "image:" + (item.batchId || item.id);
            createdAt = item.createdAt || "";
            group = ensureGroup(key, "image", createdAt);
            group.prompt = group.prompt || trimText(item.prompt || "");
            group.model = group.model || trimText(item.model || "");
            group.modeLabel = "Image";
            group.aspectRatio = group.aspectRatio || normalizeImageAspectRatio(item.aspectRatio || "1:1");
            group.imageSize = group.imageSize || normalizeImageSize(item.imageSize || "1K");
            group.sampleCount = item.sampleCount || group.sampleCount || 1;
            group.sourceMode = "image";
            if (item.refIds && item.refIds instanceof Array) {
                group.refsCount = item.refIds.length;
                if (!group.referenceIds.length) {
                    group.referenceIds = item.refIds.slice(0);
                }
            }
            if (item.refPaths && item.refPaths instanceof Array && !group.referencePaths.length) {
                for (j = 0; j < item.refPaths.length; j += 1) {
                    if (item.refPaths[j]) {
                        group.referencePaths.push(item.refPaths[j]);
                    }
                }
            }

            isMissing = item.path ? !fileExists(item.path) : true;
            group.items.push({
                kind: "image",
                id: item.id,
                sampleIndex: item.sampleIndex || 0,
                sampleCount: item.sampleCount || group.sampleCount || 1,
                createdAt: createdAt,
                timeMs: toEpochMs(createdAt),
                path: item.path || "",
                aspectRatio: normalizeImageAspectRatio(item.aspectRatio || group.aspectRatio || "1:1"),
                importedToProject: !!item.importedToProject,
                projectImportPath: item.projectImportPath || "",
                stateLabel: isMissing ? "Missing file" : "Done",
                stateClass: isMissing ? "missing" : "done"
            });
            applyState(group, isMissing ? "missing" : "done", isMissing ? "Missing file" : "Done", "");
        }

        for (i = 0; i < groups.length; i += 1) {
            groups[i].items.sort(function (a, b) {
                var ai = a.sampleIndex || 0;
                var bi = b.sampleIndex || 0;
                if (ai && bi && ai !== bi) {
                    return ai - bi;
                }
                return a.timeMs - b.timeMs;
            });
        }

        for (i = 0; i < groups.length; i += 1) {
            group = groups[i];
            activeJobCount = 0;
            for (j = 0; j < group.items.length; j += 1) {
                item = group.items[j];
                if (!item) {
                    continue;
                }
                if ((item.kind === "video-job" || item.kind === "image-job") && (item.stateClass === "generating" || item.stateClass === "idle")) {
                    activeJobCount += 1;
                }
            }
            if (activeJobCount > 0) {
                expectedCount = normalizeExpectedCount(group.sampleCount, group.items.length);
            } else {
                expectedCount = group.items.length;
                if (!expectedCount || expectedCount < 1) {
                    expectedCount = 1;
                }
            }
            slots = [];
            fallbackItems = [];

            for (j = 0; j < group.items.length; j += 1) {
                item = group.items[j];
                rawIndex = parseInt(item && item.sampleIndex, 10);
                if (isFinite(rawIndex) && rawIndex >= 0 && rawIndex < expectedCount && !slots[rawIndex]) {
                    slots[rawIndex] = item;
                } else {
                    fallbackItems.push(item);
                }
            }

            for (slotIndex = 0; slotIndex < expectedCount && fallbackItems.length; slotIndex += 1) {
                if (!slots[slotIndex]) {
                    slots[slotIndex] = fallbackItems.shift();
                }
            }

            filledItems = [];
            for (slotIndex = 0; slotIndex < expectedCount; slotIndex += 1) {
                if (slots[slotIndex]) {
                    slots[slotIndex].sampleIndex = slotIndex;
                    filledItems.push(slots[slotIndex]);
                    continue;
                }

                slotStateClass = group.stateClass === "generating" ? "generating" : "idle";
                slotStateLabel = slotStateClass === "generating" ? "Generating" : "Pending";
                if (group.stateClass === "error" || group.stateClass === "missing") {
                    slotStateClass = "idle";
                    slotStateLabel = "Pending";
                }

                filledItems.push({
                    kind: group.kind === "video" ? "video-slot" : "image-slot",
                    id: group.key + ":slot:" + String(slotIndex),
                    sampleIndex: slotIndex,
                    sampleCount: expectedCount,
                    createdAt: group.createdAt,
                    timeMs: group.timeMs,
                    path: "",
                    previewPath: "",
                    stateLabel: slotStateLabel,
                    stateClass: slotStateClass,
                    error: "",
                    aspectRatio: group.aspectRatio || (group.kind === "video" ? "16:9" : "1:1")
                });
            }

            group.items = filledItems;
            group.sampleCount = expectedCount;
            group.hasPendingJobs = group.pendingJobsCount > 0;
        }

        cleanupSmoothProgressJobs(activeProgressJobIds);

        groups.sort(function (a, b) {
            var at = a.timeMs || 0;
            var bt = b.timeMs || 0;
            if (bt !== at) {
                return bt - at;
            }
            return (a.key > b.key) ? 1 : -1;
        });

        return groups;
    }

    function findShotByPath(shots, targetPath) {
        var normalizedTarget = normalizePathForCompare(targetPath);
        var i;
        if (!normalizedTarget) {
            return null;
        }
        for (i = 0; i < shots.length; i += 1) {
            if (normalizePathForCompare(shots[i] && shots[i].path) === normalizedTarget) {
                return shots[i];
            }
        }
        return null;
    }

    function setSelectValueIfExists(selectEl, value) {
        var i;
        var target = String(value || "");
        if (!selectEl || !selectEl.options) {
            return false;
        }
        for (i = 0; i < selectEl.options.length; i += 1) {
            if (String(selectEl.options[i].value) === target) {
                selectEl.value = target;
                return true;
            }
        }
        return false;
    }

    function clampSampleCountValue(value) {
        var num = parseInt(value, 10);
        if (!isFinite(num) || num < 1) {
            num = 1;
        }
        if (num > 4) {
            num = 4;
        }
        return num;
    }

    function buildRefEntriesFromGroup(group, state, limit) {
        var refs = [];
        var taken = {};
        var shots = state.shots || [];
        var i;
        var pathValue;
        var shot;
        var key;

        function pushShotRef(shotRecord) {
            var entryPath;
            var entryName;
            var normKey;
            if (!shotRecord || !shotRecord.path) {
                return;
            }
            entryPath = shotRecord.path;
            normKey = normalizePathForCompare(entryPath);
            if (!normKey || taken[normKey]) {
                return;
            }
            entryName = (shotRecord.compName || baseName(shotRecord.path) || "Frame") +
                " | frame " + (shotRecord.frame != null ? shotRecord.frame : "-");
            refs.push({
                id: shotRecord.id || makeId("ref"),
                path: shotRecord.path,
                name: entryName,
                mimeType: guessImageMimeType(shotRecord.path),
                createdAt: (new Date()).toISOString()
            });
            taken[normKey] = true;
        }

        function pushPathRef(rawPath) {
            var normalizedPath = trimText(rawPath || "");
            var normKey;
            if (!normalizedPath || !isSupportedImagePath(normalizedPath) || !fileExists(normalizedPath)) {
                return;
            }
            normKey = normalizePathForCompare(normalizedPath);
            if (!normKey || taken[normKey]) {
                return;
            }
            refs.push({
                id: makeId("ref"),
                path: normalizedPath,
                name: baseName(normalizedPath),
                mimeType: guessImageMimeType(normalizedPath),
                createdAt: (new Date()).toISOString()
            });
            taken[normKey] = true;
        }

        for (i = 0; i < group.referenceIds.length && refs.length < limit; i += 1) {
            shot = findShotById(shots, group.referenceIds[i]);
            pushShotRef(shot);
        }
        for (i = 0; i < group.referencePaths.length && refs.length < limit; i += 1) {
            pathValue = group.referencePaths[i];
            shot = findShotByPath(shots, pathValue);
            if (shot) {
                pushShotRef(shot);
                continue;
            }
            pushPathRef(pathValue);
        }

        key = normalizePathForCompare(group.startShotPath || "");
        if (key && refs.length < limit && !taken[key]) {
            shot = findShotByPath(shots, group.startShotPath);
            if (shot) {
                pushShotRef(shot);
            }
        }

        return refs.slice(0, limit);
    }

    function applyGroupToComposer(group) {
        var state = getState();
        var promptInput = getById("promptInput");
        var imagePromptInput = getById("imagePromptInput");
        var sampleCountSelect = getById("sampleCountSelect");
        var imageSampleCountSelect = getById("imageSampleCountSelect");
        var modelSelect = getById("modelSelect");
        var imageModelSelect = getById("imageModelSelect");
        var aspectRatioSelect = getById("aspectRatioSelect");
        var imageAspectRatioSelect = getById("imageAspectRatioSelect");
        var imageSizeSelect = getById("imageSizeSelect");
        var videoMode;
        var startShotId = null;
        var endShotId = null;
        var videoRefs;
        var imageRefs;
        var sampleCount;

        if (!group) {
            return;
        }

        setActiveTab("video");

        sampleCount = clampSampleCountValue(group.sampleCount || 1);
        if (promptInput) {
            promptInput.value = group.prompt || "";
        }
        if (imagePromptInput) {
            imagePromptInput.value = group.prompt || "";
        }
        try {
            window.localStorage.setItem(STORAGE_KEY_PROMPT, group.prompt || "");
            window.localStorage.setItem(STORAGE_KEY_IMAGE_PROMPT, group.prompt || "");
        } catch (storageError) {
            // ignore
        }

        if (group.kind === "image") {
            activeGenerationType = GEN_TYPE_IMAGE;
            if (imageSampleCountSelect) {
                setSelectValueIfExists(imageSampleCountSelect, String(sampleCount));
            }
            if (imageModelSelect && group.model) {
                setSelectValueIfExists(imageModelSelect, group.model);
            }
            if (imageAspectRatioSelect && group.aspectRatio) {
                setSelectValueIfExists(imageAspectRatioSelect, normalizeImageAspectRatio(group.aspectRatio));
            }
            if (imageSizeSelect && group.imageSize) {
                setSelectValueIfExists(imageSizeSelect, normalizeImageSize(group.imageSize));
            }
            imageRefs = buildRefEntriesFromGroup(group, state, UI_MAX_REFERENCE_IMAGES);
            stateAdapterUpdate({
                startShotId: null,
                endShotId: null,
                videoRefs: [],
                refs: imageRefs
            });
            try {
                window.localStorage.setItem(STORAGE_KEY_GEN_TYPE, GEN_TYPE_IMAGE);
            } catch (storageError3) {
                // ignore
            }
            persistImageGenSettings();
            setStatus("Composer loaded from image batch.", false);
        } else {
            activeGenerationType = GEN_TYPE_VIDEO;
            videoMode = normalizeVideoMode(group.sourceMode || VIDEO_MODE_FRAMES);
            if (sampleCountSelect) {
                setSelectValueIfExists(sampleCountSelect, String(sampleCount));
            }
            if (modelSelect && group.model) {
                setSelectValueIfExists(modelSelect, group.model);
            }
            if (aspectRatioSelect && group.aspectRatio) {
                setSelectValueIfExists(aspectRatioSelect, normalizeAspectRatio(group.aspectRatio));
            }
            persistVideoGenSettings({
                mode: videoMode,
                model: modelSelect ? modelSelect.value : (group.model || ""),
                aspectRatio: aspectRatioSelect ? aspectRatioSelect.value : normalizeAspectRatio(group.aspectRatio || "16:9")
            });
            if (videoMode === VIDEO_MODE_FRAMES) {
                if (group.startShotId && findShotById(state.shots || [], group.startShotId)) {
                    startShotId = group.startShotId;
                } else if (group.startShotPath) {
                    startShotId = (findShotByPath(state.shots || [], group.startShotPath) || {}).id || null;
                }
                if (group.endShotId && findShotById(state.shots || [], group.endShotId)) {
                    endShotId = group.endShotId;
                } else if (group.endShotPath) {
                    endShotId = (findShotByPath(state.shots || [], group.endShotPath) || {}).id || null;
                }
                stateAdapterUpdate({
                    startShotId: startShotId,
                    endShotId: endShotId,
                    videoRefs: []
                });
            } else {
                videoRefs = buildRefEntriesFromGroup(group, state, UI_MAX_VIDEO_REFERENCE_IMAGES);
                stateAdapterUpdate({
                    startShotId: null,
                    endShotId: null,
                    videoRefs: videoRefs
                });
            }
            try {
                window.localStorage.setItem(STORAGE_KEY_VIDEO_MODE, videoMode);
                window.localStorage.setItem(STORAGE_KEY_GEN_TYPE, GEN_TYPE_VIDEO);
            } catch (storageError2) {
                // ignore
            }
            setStatus("Composer loaded from video batch.", false);
        }

        renderVideoModeUi(getState());
        renderFlowComposerSummary(getState());
    }

    function bindGroupMediaAction(btn, actionId, mediaKind, mediaId) {
        btn.addEventListener("click", function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            if (event && typeof event.stopPropagation === "function") {
                event.stopPropagation();
            }
            if (!mediaId) {
                return;
            }
            if (mediaKind === "video") {
                stateAdapterUpdate({ selectedVideoId: mediaId });
                if (actionId === "import") {
                    importSelectedVideo(mediaId);
                    return;
                }
                if (actionId === "reveal") {
                    revealSelectedVideo(mediaId);
                    return;
                }
                deleteSelectedVideo(mediaId);
                return;
            }

            stateAdapterUpdate({ selectedImageId: mediaId });
            if (actionId === "import") {
                importSelectedImage(mediaId);
                return;
            }
            if (actionId === "to_frames") {
                addSelectedImageToFrames(mediaId);
                return;
            }
            if (actionId === "reveal") {
                revealSelectedImage(mediaId);
                return;
            }
            deleteSelectedImage(mediaId);
        });
    }

    function clearPendingJobsForGroup(groupKey) {
        var normalizedKey = trimText(groupKey || "");
        var state;
        var jobs;
        var next;
        var removedCount = 0;
        var i;
        var item;
        var itemBatchKey;
        if (!normalizedKey) {
            return 0;
        }
        state = getState();
        jobs = getPendingJobs(state);
        next = [];
        for (i = 0; i < jobs.length; i += 1) {
            item = jobs[i];
            if (!item || !item.id) {
                continue;
            }
            itemBatchKey = (item.kind === "image" ? "image:" : "video:") + (item.batchId || item.id);
            if (itemBatchKey === normalizedKey) {
                removedCount += 1;
                continue;
            }
            next.push(item);
        }
        if (removedCount > 0) {
            stateAdapterUpdate({
                pendingJobs: trimPendingJobs(next)
            });
        }
        return removedCount;
    }

    function deleteBatchGroup(group) {
        var state = getState();
        var groupKey = group && group.key ? trimText(group.key) : "";
        var nextVideos = [];
        var nextImages = [];
        var nextPendingJobs = [];
        var removedVideos = [];
        var removedImages = [];
        var removedPendingJobs = [];
        var removedFiles = [];
        var nextSelectedVideoId = null;
        var nextSelectedImageId = null;
        var nextState;
        var i;
        var item;
        var moveResult;
        var hasImported = false;

        if (!groupKey) {
            setStatus("Batch delete failed: invalid batch.", true);
            return;
        }

        if (group && group.activePendingJobsCount > 0) {
            setStatus("Cannot delete a batch while generation is still running.", true);
            return;
        }

        for (i = 0; i < (state.videos || []).length; i += 1) {
            item = state.videos[i];
            if (item && ("video:" + (item.batchId || item.id)) === groupKey) {
                removedVideos.push(item);
                if (item.importedToProject) {
                    hasImported = true;
                }
                continue;
            }
            nextVideos.push(item);
        }

        for (i = 0; i < (state.images || []).length; i += 1) {
            item = state.images[i];
            if (item && ("image:" + (item.batchId || item.id)) === groupKey) {
                removedImages.push(item);
                if (item.importedToProject) {
                    hasImported = true;
                }
                continue;
            }
            nextImages.push(item);
        }

        for (i = 0; i < getPendingJobs(state).length; i += 1) {
            item = getPendingJobs(state)[i];
            if (item && ((item.kind === "image" ? "image:" : "video:") + (item.batchId || item.id)) === groupKey) {
                removedPendingJobs.push(item);
                continue;
            }
            nextPendingJobs.push(item);
        }

        if (!removedVideos.length && !removedImages.length && !removedPendingJobs.length) {
            setStatus("Batch delete failed: nothing to remove.", true);
            return;
        }

        if (hasImported) {
            if (!window.confirm("Delete this batch from VeoBridge Gallery?\n\nProject copy will remain in After Effects project folder.")) {
                setStatus("Batch delete canceled.", false);
                return;
            }
        }

        if (state.selectedVideoId && findVideoById(nextVideos, state.selectedVideoId)) {
            nextSelectedVideoId = state.selectedVideoId;
        } else if (nextVideos.length) {
            nextSelectedVideoId = nextVideos[0].id;
        }

        if (state.selectedImageId && findImageById(nextImages, state.selectedImageId)) {
            nextSelectedImageId = state.selectedImageId;
        } else if (nextImages.length) {
            nextSelectedImageId = nextImages[0].id;
        }

        nextState = {
            shots: state.shots || [],
            selectedShotId: state.selectedShotId || null,
            startShotId: state.startShotId || null,
            endShotId: state.endShotId || null,
            refs: state.refs || [],
            videoRefs: getVideoRefs(state),
            videos: nextVideos,
            images: nextImages,
            pendingJobs: nextPendingJobs
        };

        for (i = 0; i < removedVideos.length; i += 1) {
            item = removedVideos[i];
            if (item && item.path && shouldDeletePathForNextState(item.path, nextState)) {
                moveResult = moveFileToTrash(item.path);
                if (moveResult && moveResult.ok && moveResult.moved) {
                    removedFiles.push({
                        originalPath: moveResult.originalPath,
                        trashPath: moveResult.trashPath
                    });
                }
            }
        }

        for (i = 0; i < removedImages.length; i += 1) {
            item = removedImages[i];
            if (item && item.path && shouldDeletePathForNextState(item.path, nextState)) {
                moveResult = moveFileToTrash(item.path);
                if (moveResult && moveResult.ok && moveResult.moved) {
                    removedFiles.push({
                        originalPath: moveResult.originalPath,
                        trashPath: moveResult.trashPath
                    });
                }
            }
        }

        for (i = 0; i < removedPendingJobs.length; i += 1) {
            item = removedPendingJobs[i];
            if (item && item.downloadedPath && shouldDeletePathForNextState(item.downloadedPath, nextState)) {
                moveResult = moveFileToTrash(item.downloadedPath);
                if (moveResult && moveResult.ok && moveResult.moved) {
                    removedFiles.push({
                        originalPath: moveResult.originalPath,
                        trashPath: moveResult.trashPath
                    });
                }
            }
        }

        pushUndoDeleteAction("Batch delete", buildUndoDeleteSnapshot(state), removedFiles);

        stateAdapterUpdate({
            videos: nextVideos,
            selectedVideoId: nextSelectedVideoId,
            images: nextImages,
            selectedImageId: nextSelectedImageId,
            pendingJobs: trimPendingJobs(nextPendingJobs)
        });

        if (removedFiles.length > 0) {
            setStatus("Batch moved to VeoBridge trash.", false);
            return;
        }
        setStatus("Batch removed from gallery list.", false);
    }

    function renderVideosList(state) {
        var list = getById("videosList");
        var groups = collectUnifiedMediaGroups(state);
        var renderKeyParts = [];
        var renderKey = "";
        var i;
        var j;
        var group;
        var row;
        var mediaStrip;
        var mediaCard;
        var thumbWrap;
        var mediaThumb;
        var mediaStateChip;
        var mediaCaption;
        var mediaActions;
        var actionBtn;
        var metaWrap;
        var metaHead;
        var actionsWrap;
        var titleLine;
        var subLine;
        var dateLine;
        var errorLine;
        var metaThumbs;
        var metaThumb;
        var reuseBtn;
        var deleteBatchBtn;
        var clearPendingBtn;
        var miniThumbPath;
        var displayDate;
        var aspectClass;
        var selectedClass;
        var batchCount;
        var groupStateLabelKey;
        var itemStateLabelKey;
        var actionsVideo = [
            { id: "import", text: "Import", title: "Import to AE" },
            { id: "reveal", text: "Reveal", title: "Reveal in file manager" },
            { id: "delete", text: "Delete", title: "Delete media" }
        ];
        var actionsImage = [
            { id: "to_frames", text: "To Frames", title: "Add image to Captured Frames" },
            { id: "reveal", text: "Reveal", title: "Reveal in file manager" },
            { id: "delete", text: "Delete", title: "Delete media" }
        ];
        var cardActions;
        var currentItem;

        if (!list) {
            return;
        }

        renderKeyParts.push("v:" + String(state.selectedVideoId || ""));
        renderKeyParts.push("i:" + String(state.selectedImageId || ""));
        renderKeyParts.push("groups:" + String(groups.length));
        for (i = 0; i < groups.length; i += 1) {
            group = groups[i];
            groupStateLabelKey = group.stateLabel;
            if (group.stateClass === "generating") {
                groupStateLabelKey = "Generating";
            }
            renderKeyParts.push([
                group.key,
                group.kind,
                group.stateClass,
                groupStateLabelKey,
                group.prompt,
                group.model,
                group.modeLabel,
                group.sourceMode,
                group.aspectRatio,
                group.imageSize,
                group.sampleCount,
                group.refsCount,
                group.startShotId || "",
                group.endShotId || "",
                group.referenceIds.join(","),
                group.referencePaths.join(","),
                String(group.pendingJobsCount || 0),
                String(group.activePendingJobsCount || 0),
                group.items.length
            ].join("|"));
            for (j = 0; j < group.items.length; j += 1) {
                currentItem = group.items[j];
                itemStateLabelKey = currentItem.stateLabel;
                if ((currentItem.kind === "video-job" || currentItem.kind === "image-job") && currentItem.stateClass === "generating") {
                    itemStateLabelKey = "Generating";
                }
                renderKeyParts.push([
                    currentItem.kind,
                    currentItem.id,
                currentItem.stateClass,
                itemStateLabelKey,
                currentItem.sampleIndex || 0,
                currentItem.path || "",
                currentItem.previewPath || "",
                currentItem.importedToProject ? "1" : "0",
                currentItem.projectImportPath || "",
                currentItem.error || ""
            ].join("|"));
        }
        }
        renderKey = renderKeyParts.join("||");
        if (lastVideosListRenderKey === renderKey) {
            return;
        }
        lastVideosListRenderKey = renderKey;

        list.innerHTML = "";
        if (!groups.length) {
            row = document.createElement("div");
            row.className = "muted-note";
            row.textContent = "No generated media yet.";
            list.appendChild(row);
            return;
        }

        for (i = 0; i < groups.length; i += 1) {
            group = groups[i];

            row = document.createElement("div");
            row.className = "flow-group-row flow-state-" + group.stateClass;
            row.setAttribute("data-group-key", group.key);
            row.setAttribute("data-group-kind", group.kind);

            mediaStrip = document.createElement("div");
            mediaStrip.className = "flow-group-strip " + getAspectClass(group.aspectRatio || "16:9");
            mediaStrip.setAttribute("data-count", String(group.items.length));
            mediaStrip.style.setProperty("--group-count", String(group.items.length > 0 ? group.items.length : 1));

            for (j = 0; j < group.items.length; j += 1) {
                currentItem = group.items[j];
                aspectClass = getAspectClass(currentItem.aspectRatio || group.aspectRatio || "16:9");
                selectedClass = "";
                if (currentItem.kind === "video" && currentItem.id && currentItem.id === state.selectedVideoId) {
                    selectedClass = " is-selected";
                } else if (currentItem.kind === "image" && currentItem.id && currentItem.id === state.selectedImageId) {
                    selectedClass = " is-selected";
                }
                mediaCard = document.createElement("div");
                mediaCard.className = "flow-group-item flow-state-" + currentItem.stateClass + " " + aspectClass + selectedClass;
                mediaCard.setAttribute("data-media-kind", currentItem.kind);
                mediaCard.setAttribute("data-media-id", currentItem.id || "");

                thumbWrap = document.createElement("div");
                thumbWrap.className = "flow-group-thumb";

                if (currentItem.kind === "video" && currentItem.path && currentItem.stateClass !== "missing") {
                    mediaThumb = document.createElement("video");
                    mediaThumb.className = "video-thumb";
                    mediaThumb.muted = true;
                    mediaThumb.defaultMuted = true;
                    mediaThumb.loop = true;
                    mediaThumb.preload = "auto";
                    mediaThumb.setAttribute("playsinline", "playsinline");
                    mediaThumb.src = toFileUrl(currentItem.path);
                    thumbWrap.appendChild(mediaThumb);
                } else if (currentItem.kind === "image" && currentItem.path && currentItem.stateClass !== "missing") {
                    mediaThumb = document.createElement("img");
                    mediaThumb.className = "shot-thumb";
                    mediaThumb.alt = baseName(currentItem.path);
                    mediaThumb.src = toFileUrl(currentItem.path);
                    thumbWrap.appendChild(mediaThumb);
                } else if (currentItem.previewPath && fileExists(currentItem.previewPath) && isSupportedImagePath(currentItem.previewPath)) {
                    mediaThumb = document.createElement("img");
                    mediaThumb.className = "shot-thumb";
                    mediaThumb.alt = "Preview";
                    mediaThumb.src = toFileUrl(currentItem.previewPath);
                    thumbWrap.appendChild(mediaThumb);
                } else {
                    mediaThumb = document.createElement("div");
                    mediaThumb.className = "flow-thumb-placeholder";
                    if (currentItem.kind === "video-slot" || currentItem.kind === "image-slot") {
                        mediaThumb.textContent = currentItem.stateLabel || "Pending";
                    } else if (currentItem.kind === "video-job" || currentItem.kind === "image-job") {
                        if (currentItem.stateClass === "error" && currentItem.error) {
                            mediaThumb.textContent = currentItem.error;
                        } else {
                            mediaThumb.textContent = currentItem.stateLabel || "Pending";
                        }
                    } else {
                        mediaThumb.textContent = "No preview";
                    }
                    thumbWrap.appendChild(mediaThumb);
                }

                if (currentItem.stateClass !== "done") {
                    mediaStateChip = document.createElement("span");
                    mediaStateChip.className = "state-chip state-" + currentItem.stateClass;
                    mediaStateChip.textContent = currentItem.stateLabel || "-";
                    thumbWrap.appendChild(mediaStateChip);
                }

                if (currentItem.importedToProject) {
                    mediaStateChip = document.createElement("span");
                    mediaStateChip.className = "state-chip state-imported";
                    mediaStateChip.textContent = "Imported";
                    thumbWrap.appendChild(mediaStateChip);
                }

                mediaCaption = document.createElement("div");
                mediaCaption.className = "flow-group-caption";
                mediaCaption.textContent = truncateText(group.prompt || "Generated media", 48);

                if (currentItem.kind === "video" || currentItem.kind === "image") {
                    mediaActions = document.createElement("div");
                    mediaActions.className = "flow-group-actions";
                    cardActions = currentItem.kind === "image" ? actionsImage : actionsVideo;
                    for (var a = 0; a < cardActions.length; a += 1) {
                        actionBtn = document.createElement("button");
                        actionBtn.type = "button";
                        actionBtn.className = "video-card-action-btn";
                        if (cardActions[a].id === "delete") {
                            actionBtn.className += " is-danger";
                        }
                        actionBtn.textContent = cardActions[a].text;
                        actionBtn.title = cardActions[a].title;
                        bindGroupMediaAction(actionBtn, cardActions[a].id, currentItem.kind, currentItem.id);
                        mediaActions.appendChild(actionBtn);
                    }
                    thumbWrap.appendChild(mediaActions);
                }

                mediaCard.appendChild(thumbWrap);
                mediaCard.appendChild(mediaCaption);

                mediaCard.addEventListener("click", function (event) {
                    var target = event.currentTarget;
                    var kind = target ? target.getAttribute("data-media-kind") : "";
                    var id = target ? target.getAttribute("data-media-id") : "";
                    if (!id) {
                        return;
                    }
                    if (kind === "video") {
                        stateAdapterUpdate({ selectedVideoId: id });
                        openMediaPreview("video", id);
                    } else if (kind === "image") {
                        stateAdapterUpdate({ selectedImageId: id });
                        openMediaPreview("image", id);
                    }
                });

                if (currentItem.kind === "video" && mediaThumb && mediaThumb.tagName && mediaThumb.tagName.toLowerCase() === "video") {
                    (function (videoEl, cardEl) {
                        function startPreview() {
                            pauseAllInlineVideoPreviews(videoEl);
                            playInlineVideoPreview(videoEl);
                        }
                        function stopPreview() {
                            stopInlineVideoPreview(videoEl);
                        }
                        cardEl.addEventListener("mouseenter", startPreview);
                        cardEl.addEventListener("mouseleave", stopPreview);
                        cardEl.addEventListener("focusin", startPreview);
                        cardEl.addEventListener("focusout", stopPreview);
                    }(mediaThumb, mediaCard));
                }

                mediaStrip.appendChild(mediaCard);
            }

            metaWrap = document.createElement("div");
            metaWrap.className = "flow-group-meta";

            metaHead = document.createElement("div");
            metaHead.className = "flow-row-meta-head";

            titleLine = document.createElement("div");
            titleLine.className = "flow-row-title";
            titleLine.textContent = group.prompt || (group.kind === "video" ? "Video request" : "Image request");
            metaHead.appendChild(titleLine);

            actionsWrap = document.createElement("div");
            actionsWrap.className = "flow-row-actions";

            reuseBtn = document.createElement("button");
            reuseBtn.type = "button";
            reuseBtn.className = "flow-reuse-btn";
            reuseBtn.textContent = "\u21BB";
            reuseBtn.title = "Reuse this batch in composer";
            reuseBtn.addEventListener("click", (function (groupCopy) {
                return function (event) {
                    if (event && typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    if (event && typeof event.stopPropagation === "function") {
                        event.stopPropagation();
                    }
                    applyGroupToComposer(groupCopy);
                };
            }(group)));
            actionsWrap.appendChild(reuseBtn);

            deleteBatchBtn = document.createElement("button");
            deleteBatchBtn.type = "button";
            deleteBatchBtn.className = "flow-batch-delete-btn is-danger";
            deleteBatchBtn.textContent = "\u00D7";
            deleteBatchBtn.title = "Delete batch";
            deleteBatchBtn.setAttribute("aria-label", "Delete batch");
            deleteBatchBtn.addEventListener("click", (function (groupCopy2) {
                return function (event) {
                    if (event && typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    if (event && typeof event.stopPropagation === "function") {
                        event.stopPropagation();
                    }
                    deleteBatchGroup(groupCopy2);
                };
            }(group)));
            actionsWrap.appendChild(deleteBatchBtn);

            if (group.hasPendingJobs) {
                clearPendingBtn = document.createElement("button");
                clearPendingBtn.type = "button";
                clearPendingBtn.className = "flow-clear-pending-btn is-danger";
                clearPendingBtn.textContent = "Clear";
                clearPendingBtn.title = "Remove pending placeholders in this batch";
                clearPendingBtn.addEventListener("click", (function (groupKeyCopy) {
                    return function (event) {
                        var removed;
                        if (event && typeof event.preventDefault === "function") {
                            event.preventDefault();
                        }
                        if (event && typeof event.stopPropagation === "function") {
                            event.stopPropagation();
                        }
                        removed = clearPendingJobsForGroup(groupKeyCopy);
                        if (removed > 0) {
                            setStatus("Removed " + removed + " pending item(s) from batch.", false);
                            return;
                        }
                        setStatus("No pending placeholders to clear.", false);
                    };
                }(group.key)));
                actionsWrap.appendChild(clearPendingBtn);
            }
            metaHead.appendChild(actionsWrap);
            metaWrap.appendChild(metaHead);

            subLine = document.createElement("div");
            subLine.className = "flow-row-sub";
            batchCount = group.sampleCount || group.items.length || 1;
            subLine.textContent = (group.model || "-") +
                " | " + (group.aspectRatio || "-") +
                " | x" + String(batchCount);
            metaWrap.appendChild(subLine);

            metaThumbs = document.createElement("div");
            metaThumbs.className = "flow-meta-thumbs";
            for (j = 0; j < group.items.length && j < 2; j += 1) {
                miniThumbPath = group.items[j].path || group.items[j].previewPath || "";
                if (!miniThumbPath || !fileExists(miniThumbPath) || !isSupportedImagePath(miniThumbPath)) {
                    continue;
                }
                metaThumb = document.createElement("img");
                metaThumb.className = "flow-meta-thumb";
                metaThumb.alt = "Media thumb";
                metaThumb.src = toFileUrl(miniThumbPath);
                metaThumbs.appendChild(metaThumb);
            }
            if (metaThumbs.childNodes.length > 0) {
                metaWrap.appendChild(metaThumbs);
            }

            dateLine = document.createElement("div");
            dateLine.className = "flow-row-date";
            displayDate = formatDateOnly(group.createdAt);
            dateLine.textContent = "Created " + displayDate;
            metaWrap.appendChild(dateLine);

            if (group.error) {
                errorLine = document.createElement("div");
                errorLine.className = "flow-row-error";
                errorLine.textContent = truncateText(group.error, 180);
                metaWrap.appendChild(errorLine);
            }

            row.appendChild(mediaStrip);
            row.appendChild(metaWrap);
            list.appendChild(row);
        }
    }

    function renderRefsList(state) {
        var list = getById("refsList");
        var refs = state.refs || [];
        var normalizedRefs = [];
        var i;
        var refItem;
        var item;
        var thumbWrap;
        var thumb;
        var caption;
        var removeBtn;
        var actionsWrap;
        var placeholder;
        var slotCount;
        var refCount;

        if (!list) {
            return;
        }

        for (i = 0; i < refs.length; i += 1) {
            if (refs[i] && refs[i].path) {
                normalizedRefs.push(refs[i]);
            }
        }
        if (normalizedRefs.length > UI_MAX_REFERENCE_IMAGES) {
            normalizedRefs = normalizedRefs.slice(0, UI_MAX_REFERENCE_IMAGES);
        }
        refCount = normalizedRefs.length;
        slotCount = refCount + 1;
        if (slotCount > UI_MAX_REFERENCE_IMAGES) {
            slotCount = UI_MAX_REFERENCE_IMAGES;
        }
        if (slotCount < 1) {
            slotCount = 1;
        }

        list.innerHTML = "";
        for (i = 0; i < slotCount; i += 1) {
            refItem = normalizedRefs[i] || null;

            item = document.createElement("div");
            item.className = "ref-item" + (refItem ? "" : " is-empty");
            item.setAttribute("data-ref-slot-index", String(i));

            if (refItem) {
                item.setAttribute("data-ref-id", refItem.id || "");

                thumbWrap = document.createElement("div");
                thumbWrap.className = "shot-thumb-wrap";

                thumb = document.createElement("img");
                thumb.className = "shot-thumb";
                thumb.alt = refItem.name || baseName(refItem.path);
                if (refItem.path) {
                    thumb.src = toFileUrl(refItem.path);
                }
                thumbWrap.appendChild(thumb);

                actionsWrap = document.createElement("div");
                actionsWrap.className = "ref-card-actions";
                removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "shot-card-action-btn";
                removeBtn.textContent = "Remove";
                removeBtn.setAttribute("data-ref-id", refItem.id || "");
                removeBtn.addEventListener("click", function (event) {
                    var id = event.currentTarget ? event.currentTarget.getAttribute("data-ref-id") : null;
                    if (event && typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    if (event && typeof event.stopPropagation === "function") {
                        event.stopPropagation();
                    }
                    removeReferenceById(id);
                });
                actionsWrap.appendChild(removeBtn);
                thumbWrap.appendChild(actionsWrap);
                item.appendChild(thumbWrap);

                caption = document.createElement("div");
                caption.className = "shot-caption";
                caption.textContent = (refItem.name || baseName(refItem.path || "ref")) + (fileExists(refItem.path) ? "" : " | missing");
                item.appendChild(caption);
            } else {
                placeholder = document.createElement("div");
                placeholder.className = "ref-slot-placeholder";
                placeholder.textContent = "Empty slot";
                item.appendChild(placeholder);

                caption = document.createElement("div");
                caption.className = "shot-caption";
                caption.textContent = "Reference " + String(i + 1);
                item.appendChild(caption);

                item.setAttribute("tabindex", "0");
                item.addEventListener("click", function (event) {
                    var target = event.currentTarget;
                    var slotRaw = target ? target.getAttribute("data-ref-slot-index") : "";
                    var slotIndex = parseInt(slotRaw, 10);
                    if (!isFinite(slotIndex) || slotIndex < 0) {
                        slotIndex = 0;
                    }
                    openShotPicker("imageRefSlot:" + String(slotIndex));
                });
                item.addEventListener("keydown", function (event) {
                    var target = event.currentTarget;
                    var slotRaw = target ? target.getAttribute("data-ref-slot-index") : "";
                    var slotIndex = parseInt(slotRaw, 10);
                    if (event.key === "Enter" || event.key === " ") {
                        if (typeof event.preventDefault === "function") {
                            event.preventDefault();
                        }
                        if (!isFinite(slotIndex) || slotIndex < 0) {
                            slotIndex = 0;
                        }
                        openShotPicker("imageRefSlot:" + String(slotIndex));
                    }
                });
            }
            list.appendChild(item);
        }
    }

    function renderVideoRefsList(state) {
        var list = getById("videoRefsList");
        var refs = getVideoRefs(state);
        var normalizedRefs = [];
        var i;
        var refItem;
        var item;
        var thumbWrap;
        var thumb;
        var caption;
        var removeBtn;
        var actionsWrap;

        var slotCount;
        var refCount;
        var placeholder;

        if (!list) {
            return;
        }

        for (i = 0; i < refs.length; i += 1) {
            if (refs[i] && refs[i].path) {
                normalizedRefs.push(refs[i]);
            }
        }
        if (normalizedRefs.length > UI_MAX_VIDEO_REFERENCE_IMAGES) {
            normalizedRefs = normalizedRefs.slice(0, UI_MAX_VIDEO_REFERENCE_IMAGES);
        }
        refCount = normalizedRefs.length;
        slotCount = refCount + 1;
        if (slotCount > UI_MAX_VIDEO_REFERENCE_IMAGES) {
            slotCount = UI_MAX_VIDEO_REFERENCE_IMAGES;
        }
        if (slotCount < 1) {
            slotCount = 1;
        }

        list.innerHTML = "";
        for (i = 0; i < slotCount; i += 1) {
            refItem = normalizedRefs[i] || null;

            item = document.createElement("div");
            item.className = "ref-item" + (refItem ? "" : " is-empty");
            item.setAttribute("data-video-ref-slot-index", String(i));

            if (refItem) {
                item.setAttribute("data-video-ref-id", refItem.id || "");

                thumbWrap = document.createElement("div");
                thumbWrap.className = "shot-thumb-wrap";

                thumb = document.createElement("img");
                thumb.className = "shot-thumb";
                thumb.alt = refItem.name || baseName(refItem.path);
                if (refItem.path) {
                    thumb.src = toFileUrl(refItem.path);
                }
                thumbWrap.appendChild(thumb);
                item.appendChild(thumbWrap);

                caption = document.createElement("div");
                caption.className = "shot-caption";
                caption.textContent = (refItem.name || baseName(refItem.path || "ref")) + (fileExists(refItem.path) ? "" : " | missing");
                item.appendChild(caption);

                actionsWrap = document.createElement("div");
                actionsWrap.className = "ref-card-actions";
                removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "shot-card-action-btn";
                removeBtn.textContent = "Remove";
                removeBtn.setAttribute("data-video-ref-id", refItem.id || "");
                removeBtn.addEventListener("click", function (event) {
                    var id = event.currentTarget ? event.currentTarget.getAttribute("data-video-ref-id") : null;
                    if (event && typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    if (event && typeof event.stopPropagation === "function") {
                        event.stopPropagation();
                    }
                    removeVideoReferenceById(id);
                });
                actionsWrap.appendChild(removeBtn);
                thumbWrap.appendChild(actionsWrap);
            } else {
                placeholder = document.createElement("div");
                placeholder.className = "ref-slot-placeholder";
                placeholder.textContent = "Empty slot";
                item.appendChild(placeholder);

                caption = document.createElement("div");
                caption.className = "shot-caption";
                caption.textContent = "Reference " + String(i + 1);
                item.appendChild(caption);

                item.setAttribute("tabindex", "0");
                item.addEventListener("click", function (event) {
                    var target = event.currentTarget;
                    var slotRaw = target ? target.getAttribute("data-video-ref-slot-index") : "";
                    var slotIndex = parseInt(slotRaw, 10);
                    if (!isFinite(slotIndex) || slotIndex < 0) {
                        slotIndex = 0;
                    }
                    openShotPicker("videoRefSlot:" + String(slotIndex));
                });
                item.addEventListener("keydown", function (event) {
                    var target = event.currentTarget;
                    var slotRaw = target ? target.getAttribute("data-video-ref-slot-index") : "";
                    var slotIndex = parseInt(slotRaw, 10);
                    if (event.key === "Enter" || event.key === " ") {
                        if (typeof event.preventDefault === "function") {
                            event.preventDefault();
                        }
                        if (!isFinite(slotIndex) || slotIndex < 0) {
                            slotIndex = 0;
                        }
                        openShotPicker("videoRefSlot:" + String(slotIndex));
                    }
                });
            }

            list.appendChild(item);
        }
    }

    function renderImagesList(state) {
        var list = getById("imagesList");
        var images = state.images || [];
        var renderKeyParts = [];
        var renderKey = "";
        var i;
        var imageItem;
        var item;
        var thumbWrap;
        var thumb;
        var badge;
        var caption;
        var metaWrap;
        var titleLine;
        var subLine;
        var dateLine;
        var actionsWrap;
        var actionBtn;
        var selectedEl = null;

        if (!list) {
            return;
        }

        renderKeyParts.push("selected:" + String(state.selectedImageId || ""));
        renderKeyParts.push("count:" + String(images.length));
        for (i = 0; i < images.length; i += 1) {
            imageItem = images[i] || {};
            renderKeyParts.push([
                imageItem.id || "",
                imageItem.path || "",
                imageItem.createdAt || "",
                imageItem.model || "",
                imageItem.aspectRatio || "",
                imageItem.imageSize || "",
                imageItem.importedToProject ? "1" : "0",
                imageItem.projectImportPath || "",
                fileExists(imageItem.path) ? "1" : "0"
            ].join("|"));
        }
        renderKey = renderKeyParts.join("||");
        if (lastImagesListRenderKey === renderKey) {
            return;
        }
        lastImagesListRenderKey = renderKey;

        list.innerHTML = "";

        if (!images.length) {
            item = document.createElement("div");
            item.className = "muted-note";
            item.textContent = "No generated images yet.";
            list.appendChild(item);
            return;
        }

        for (i = 0; i < images.length; i += 1) {
            imageItem = images[i];

            item = document.createElement("div");
            item.className = "image-item flow-media-row" + (imageItem.id === state.selectedImageId ? " is-selected" : "");
            item.setAttribute("data-image-id", imageItem.id);
            item.setAttribute("role", "button");
            item.setAttribute("tabindex", "0");
            if (imageItem.id === state.selectedImageId) {
                selectedEl = item;
            }

            thumbWrap = document.createElement("div");
            thumbWrap.className = "shot-thumb-wrap flow-row-thumb";

            thumb = document.createElement("img");
            thumb.className = "shot-thumb";
            thumb.alt = baseName(imageItem.path || "image");
            if (imageItem.path) {
                thumb.src = toFileUrl(imageItem.path);
            }
            thumbWrap.appendChild(thumb);

            if (!fileExists(imageItem.path)) {
                badge = document.createElement("span");
                badge.className = "state-chip state-missing";
                badge.textContent = "Missing file";
                thumbWrap.appendChild(badge);
                item.className += " flow-state-missing";
            } else {
                badge = document.createElement("span");
                badge.className = "state-chip state-done";
                badge.textContent = "Done";
                thumbWrap.appendChild(badge);
                item.className += " flow-state-done";
            }

            if (imageItem.importedToProject) {
                badge = document.createElement("span");
                badge.className = "state-chip state-imported";
                badge.textContent = "Imported";
                thumbWrap.appendChild(badge);
            }

            item.appendChild(thumbWrap);

            metaWrap = document.createElement("div");
            metaWrap.className = "flow-row-meta";

            titleLine = document.createElement("div");
            titleLine.className = "flow-row-title";
            titleLine.textContent = trimText(imageItem.prompt || "") || baseName(imageItem.path || "image.png");
            metaWrap.appendChild(titleLine);

            subLine = document.createElement("div");
            subLine.className = "flow-row-sub";
            subLine.textContent = (imageItem.model || "-") + " | " + (imageItem.aspectRatio || "-") + " | " + (imageItem.imageSize || "-");
            metaWrap.appendChild(subLine);

            dateLine = document.createElement("div");
            dateLine.className = "flow-row-date";
            dateLine.textContent = formatDate(imageItem.createdAt) + (fileExists(imageItem.path) ? "" : " | missing file");
            metaWrap.appendChild(dateLine);

            item.appendChild(metaWrap);

            actionsWrap = document.createElement("div");
            actionsWrap.className = "video-row-actions";

            actionBtn = document.createElement("button");
            actionBtn.type = "button";
            actionBtn.className = "video-card-action-btn";
            actionBtn.textContent = "Import";
            actionBtn.addEventListener("click", function (event) {
                var target = event.currentTarget && event.currentTarget.parentNode ? event.currentTarget.parentNode.parentNode : null;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                if (event && typeof event.stopPropagation === "function") {
                    event.stopPropagation();
                }
                if (!imageId) {
                    return;
                }
                stateAdapterUpdate({ selectedImageId: imageId });
                importSelectedImage();
            });
            actionsWrap.appendChild(actionBtn);

            actionBtn = document.createElement("button");
            actionBtn.type = "button";
            actionBtn.className = "video-card-action-btn";
            actionBtn.textContent = "To Frames";
            actionBtn.addEventListener("click", function (event) {
                var target = event.currentTarget && event.currentTarget.parentNode ? event.currentTarget.parentNode.parentNode : null;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                if (event && typeof event.stopPropagation === "function") {
                    event.stopPropagation();
                }
                if (!imageId) {
                    return;
                }
                stateAdapterUpdate({ selectedImageId: imageId });
                addSelectedImageToFrames();
            });
            actionsWrap.appendChild(actionBtn);

            actionBtn = document.createElement("button");
            actionBtn.type = "button";
            actionBtn.className = "video-card-action-btn";
            actionBtn.textContent = "Reveal";
            actionBtn.addEventListener("click", function (event) {
                var target = event.currentTarget && event.currentTarget.parentNode ? event.currentTarget.parentNode.parentNode : null;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                if (event && typeof event.stopPropagation === "function") {
                    event.stopPropagation();
                }
                if (!imageId) {
                    return;
                }
                stateAdapterUpdate({ selectedImageId: imageId });
                revealSelectedImage();
            });
            actionsWrap.appendChild(actionBtn);

            actionBtn = document.createElement("button");
            actionBtn.type = "button";
            actionBtn.className = "video-card-action-btn is-danger";
            actionBtn.textContent = "Delete";
            actionBtn.addEventListener("click", function (event) {
                var target = event.currentTarget && event.currentTarget.parentNode ? event.currentTarget.parentNode.parentNode : null;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (event && typeof event.preventDefault === "function") {
                    event.preventDefault();
                }
                if (event && typeof event.stopPropagation === "function") {
                    event.stopPropagation();
                }
                if (!imageId) {
                    return;
                }
                stateAdapterUpdate({ selectedImageId: imageId });
                deleteSelectedImage();
            });
            actionsWrap.appendChild(actionBtn);

            item.appendChild(actionsWrap);

            item.addEventListener("click", function (event) {
                var target = event.currentTarget;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (!imageId) {
                    return;
                }
                stateAdapterUpdate({ selectedImageId: imageId });
            });

            item.addEventListener("keydown", function (event) {
                var target = event.currentTarget;
                var imageId = target ? target.getAttribute("data-image-id") : null;
                if (!imageId) {
                    return;
                }
                if (event.key === "Enter" || event.key === " ") {
                    if (typeof event.preventDefault === "function") {
                        event.preventDefault();
                    }
                    stateAdapterUpdate({ selectedImageId: imageId });
                }
            });

            list.appendChild(item);
        }

        if (selectedEl) {
            scrollIntoViewSafe(selectedEl);
        }
    }

    function renderMediaPreviewOverlay(state) {
        var overlay = getById("mediaPreviewOverlay");
        var titleEl = getById("mediaPreviewTitle");
        var emptyEl = getById("mediaPreviewEmpty");
        var videoEl = getById("mediaPreviewVideo");
        var imageEl = getById("mediaPreviewImage");
        var metaEl = getById("mediaPreviewMeta");
        var btnImport = getById("btnMediaPreviewImport");
        var btnImportProject = getById("btnMediaPreviewImportProject");
        var btnImportComp = getById("btnMediaPreviewImportComp");
        var btnCapture = getById("btnMediaPreviewCapture");
        var btnToFrames = getById("btnMediaPreviewToFrames");
        var btnReveal = getById("btnMediaPreviewReveal");
        var btnDelete = getById("btnMediaPreviewDelete");
        var record = null;
        var filePath = "";
        var createdText = "";
        var line2 = "";
        var line3 = "";

        if (!overlay || !titleEl || !emptyEl || !videoEl || !imageEl || !metaEl) {
            return;
        }

        if (!mediaPreviewKind || !mediaPreviewId) {
            overlay.hidden = true;
            return;
        }

        if (mediaPreviewKind === "video") {
            record = findVideoById(state.videos || [], mediaPreviewId);
        } else if (mediaPreviewKind === "image") {
            record = findImageById(state.images || [], mediaPreviewId);
        }

        if (!record) {
            closeMediaPreview();
            return;
        }

        filePath = record.path || "";
        titleEl.textContent = trimText(record.prompt || "") || baseName(filePath || "Media");
        createdText = "Created " + formatDateOnly(record.createdAt || "");

        if (btnImport) {
            btnImport.hidden = false;
        }
        if (btnImportProject) {
            btnImportProject.hidden = false;
        }
        if (btnImportComp) {
            btnImportComp.hidden = false;
        }
        if (btnCapture) {
            btnCapture.hidden = mediaPreviewKind !== "video";
            btnCapture.disabled = !!isCapturingPreviewFrame;
        }
        if (btnReveal) {
            btnReveal.hidden = false;
        }
        if (btnDelete) {
            btnDelete.hidden = false;
        }
        if (btnToFrames) {
            btnToFrames.hidden = mediaPreviewKind !== "image";
        }

        if (!filePath || !fileExists(filePath)) {
            emptyEl.textContent = "Selected media file is missing.";
            emptyEl.style.display = "";
            videoEl.hidden = true;
            imageEl.hidden = true;
            stopInlineVideoPreview(videoEl);
            videoEl.removeAttribute("src");
            videoEl.removeAttribute("data-current-path");
            imageEl.removeAttribute("src");
            imageEl.removeAttribute("data-current-path");
            if (btnCapture) {
                btnCapture.hidden = true;
                btnCapture.disabled = true;
            }
            line2 = mediaPreviewKind === "video"
                ? ((record.model || "-") + " | " + (record.aspectRatio || "-"))
                : ((record.model || "-") + " | " + (record.aspectRatio || "-") + " | " + (record.imageSize || "-"));
            line3 = record.importedToProject ? ("Imported to project: " + (record.projectImportPath || "yes")) : "";
            metaEl.textContent = createdText + "\n" + line2 + (line3 ? ("\n" + line3) : "") + "\nPath: " + (filePath || "-");
            overlay.hidden = false;
            return;
        }

        emptyEl.style.display = "none";
        if (mediaPreviewKind === "video") {
            imageEl.hidden = true;
            imageEl.removeAttribute("src");
            if (videoEl.getAttribute("data-current-path") !== filePath) {
                videoEl.src = toFileUrl(filePath);
                videoEl.setAttribute("data-current-path", filePath);
            }
            videoEl.hidden = false;
            pauseAllInlineVideoPreviews(videoEl);
            playInlineVideoPreview(videoEl);
            if (btnCapture) {
                btnCapture.hidden = false;
                btnCapture.disabled = !!isCapturingPreviewFrame;
            }
            line2 = (record.model || "-") + " | " + (record.aspectRatio || "-") + " | " + (record.requestMode || record.mode || "video");
            line3 = record.importedToProject ? ("Imported to project: " + (record.projectImportPath || "yes")) : "";
            metaEl.textContent = createdText + "\n" + line2 + (line3 ? ("\n" + line3) : "");
        } else {
            stopInlineVideoPreview(videoEl);
            videoEl.hidden = true;
            videoEl.removeAttribute("src");
            if (imageEl.getAttribute("data-current-path") !== filePath) {
                imageEl.src = toFileUrl(filePath);
                imageEl.setAttribute("data-current-path", filePath);
            }
            imageEl.hidden = false;
            if (btnCapture) {
                btnCapture.hidden = true;
                btnCapture.disabled = true;
            }
            line2 = (record.model || "-") + " | " + (record.aspectRatio || "-") + " | " + (record.imageSize || "-");
            line3 = record.importedToProject ? ("Imported to project: " + (record.projectImportPath || "yes")) : "";
            metaEl.textContent = createdText + "\n" + line2 + (line3 ? ("\n" + line3) : "");
        }

        overlay.hidden = false;
    }

    function renderVideoPreview(state) {
        var empty = getById("videoPreviewEmpty");
        var player = getById("videoPreviewPlayer");
        var meta = getById("videoPreviewMeta");
        var summary = getById("videoMetaSummary");
        var details = getById("videoMetaDetails");
        var detailsToggle = getById("btnToggleVideoMetaDetails");
        var videos = state.videos || [];
        var shots = state.shots || [];
        var selectedVideo = findVideoById(videos, state.selectedVideoId);
        var startShot;
        var endShot;
        var lines = [];
        var summaryChips = [];
        var chipHtml = [];
        var i;

        function requestModeLabel(value) {
            if (value === "text") {
                return "Text";
            }
            if (value === "image") {
                return "Image-to-Video";
            }
            if (value === "interpolation") {
                return "Interpolation";
            }
            if (value === "reference" || value === "reference_fallback_parameters") {
                return "Reference";
            }
            if (value === "text_only_fallback") {
                return "Text fallback";
            }
            return value || "Video";
        }

        if (!empty || !player || !meta || !summary || !details || !detailsToggle) {
            return;
        }

        if (!selectedVideo || !selectedVideo.path) {
            empty.style.display = "";
            player.className = "video-preview-player";
            player.removeAttribute("src");
            player.removeAttribute("data-current-path");
            player.load();
            summary.innerHTML = "";
            details.textContent = "";
            details.hidden = true;
            detailsToggle.hidden = true;
            detailsToggle.textContent = "Show details";
            return;
        }

        if (!fileExists(selectedVideo.path)) {
            empty.style.display = "";
            empty.textContent = "Selected video file is missing. Remove it from the list or regenerate.";
            player.className = "video-preview-player";
            player.removeAttribute("src");
            player.removeAttribute("data-current-path");
            player.load();
            summary.innerHTML = "<div class=\"video-meta-primary is-warning\">File is missing on disk.</div>" +
                "<div class=\"video-meta-secondary\">Path: " + escapeHtml(selectedVideo.path) + "</div>";
            details.textContent = "";
            details.hidden = true;
            detailsToggle.hidden = true;
            return;
        }

        empty.style.display = "none";
        empty.textContent = "No generated videos yet.";
        player.className = "video-preview-player is-visible";

        if (player.getAttribute("data-current-path") !== selectedVideo.path) {
            player.src = toFileUrl(selectedVideo.path);
            player.setAttribute("data-current-path", selectedVideo.path);
            player.load();
        }

        startShot = findShotById(shots, selectedVideo.startShotId);
        endShot = findShotById(shots, selectedVideo.endShotId);

        summaryChips.push(selectedVideo.model || "-");
        summaryChips.push(requestModeLabel(selectedVideo.requestMode || selectedVideo.mode || ""));
        summaryChips.push(selectedVideo.aspectRatio || "-");
        summaryChips.push(selectedVideo.durationSeconds ? String(selectedVideo.durationSeconds) + "s" : "-");
        if (selectedVideo.resolution) {
            summaryChips.push(selectedVideo.resolution);
        }
        if (selectedVideo.importedToProject) {
            summaryChips.push("Imported");
        }

        for (i = 0; i < summaryChips.length; i += 1) {
            chipHtml.push("<span class=\"video-meta-chip\">" + escapeHtml(summaryChips[i]) + "</span>");
        }

        summary.innerHTML = "<div class=\"video-meta-primary\">" + chipHtml.join("") + "</div>";

        lines.push("Start: " + (startShot ? formatShotLabel(startShot) : "-"));
        lines.push("End: " + (endShot ? formatShotLabel(endShot) : "-"));
        lines.push("Prompt: " + (selectedVideo.prompt || "-"));
        lines.push("");
        lines.push("File: " + baseName(selectedVideo.path));
        lines.push("Path: " + selectedVideo.path);
        lines.push("Created: " + formatDate(selectedVideo.createdAt));
        lines.push("Model: " + (selectedVideo.model || "-"));
        lines.push("Aspect: " + (selectedVideo.aspectRatio || "-"));
        lines.push("Mode: " + (selectedVideo.mode || "-"));
        if (selectedVideo.durationSeconds) {
            lines.push("Duration: " + selectedVideo.durationSeconds + "s");
        }
        if (selectedVideo.resolution) {
            lines.push("Resolution: " + selectedVideo.resolution);
        }
        lines.push("Request: " + (selectedVideo.requestMode || "frames"));
        if (selectedVideo.refIds && selectedVideo.refIds.length) {
            lines.push("Refs: " + selectedVideo.refIds.length);
        }
        if (selectedVideo.importedToProject) {
            lines.push("Imported: yes");
            lines.push("Project copy: " + (selectedVideo.projectImportPath || "-"));
            lines.push("Imported at: " + formatDate(selectedVideo.importedAt));
        }
        details.textContent = lines.join("\n");
        details.hidden = !isVideoMetaDetailsExpanded;
        detailsToggle.hidden = false;
        detailsToggle.textContent = isVideoMetaDetailsExpanded ? "Hide details" : "Show details";
    }

    function renderImagePreview(state) {
        var empty = getById("imagePreviewEmpty");
        var imageEl = getById("imagePreview");
        var meta = getById("imagePreviewMeta");
        var summary = getById("imageMetaSummary");
        var details = getById("imageMetaDetails");
        var detailsToggle = getById("btnToggleImageMetaDetails");
        var images = state.images || [];
        var selectedImage = findImageById(images, state.selectedImageId);
        var lines = [];
        var summaryChips = [];
        var chipHtml = [];
        var i;

        if (!empty || !imageEl || !meta || !summary || !details || !detailsToggle) {
            return;
        }

        if (!selectedImage || !selectedImage.path) {
            empty.style.display = "";
            imageEl.className = "image-preview";
            imageEl.removeAttribute("src");
            imageEl.removeAttribute("data-current-path");
            summary.innerHTML = "";
            details.textContent = "";
            details.hidden = true;
            detailsToggle.hidden = true;
            detailsToggle.textContent = "Show details";
            return;
        }

        if (!fileExists(selectedImage.path)) {
            empty.style.display = "";
            empty.textContent = "Selected image file is missing. Remove it from list or regenerate.";
            imageEl.className = "image-preview";
            imageEl.removeAttribute("src");
            imageEl.removeAttribute("data-current-path");
            summary.innerHTML = "<div class=\"video-meta-primary is-warning\">File is missing on disk.</div>" +
                "<div class=\"video-meta-secondary\">Path: " + escapeHtml(selectedImage.path) + "</div>";
            details.textContent = "";
            details.hidden = true;
            detailsToggle.hidden = true;
            return;
        }

        empty.style.display = "none";
        empty.textContent = "No generated images yet.";
        imageEl.className = "image-preview is-visible";

        if (imageEl.getAttribute("data-current-path") !== selectedImage.path) {
            imageEl.src = toFileUrl(selectedImage.path);
            imageEl.setAttribute("data-current-path", selectedImage.path);
        }

        summaryChips.push(selectedImage.model || "-");
        summaryChips.push(selectedImage.aspectRatio || "-");
        summaryChips.push(selectedImage.imageSize || "-");
        if (selectedImage.width && selectedImage.height) {
            summaryChips.push(String(selectedImage.width) + "x" + String(selectedImage.height));
        }
        if (selectedImage.importedToProject) {
            summaryChips.push("Imported");
        }

        for (i = 0; i < summaryChips.length; i += 1) {
            chipHtml.push("<span class=\"video-meta-chip\">" + escapeHtml(summaryChips[i]) + "</span>");
        }
        summary.innerHTML = "<div class=\"video-meta-primary\">" + chipHtml.join("") + "</div>";

        lines.push("File: " + baseName(selectedImage.path));
        lines.push("Path: " + selectedImage.path);
        lines.push("Created: " + formatDate(selectedImage.createdAt));
        lines.push("Model: " + (selectedImage.model || "-"));
        lines.push("Aspect: " + (selectedImage.aspectRatio || "-"));
        lines.push("Size: " + (selectedImage.imageSize || "-"));
        if (selectedImage.width && selectedImage.height) {
            lines.push("Dimensions: " + selectedImage.width + " x " + selectedImage.height);
        }
        lines.push("Prompt: " + (selectedImage.prompt || "-"));
        if (selectedImage.importedToProject) {
            lines.push("Imported: yes");
            lines.push("Project copy: " + (selectedImage.projectImportPath || "-"));
            lines.push("Imported at: " + formatDate(selectedImage.importedAt));
        }
        details.textContent = lines.join("\n");
        details.hidden = !isImageMetaDetailsExpanded;
        detailsToggle.hidden = false;
        detailsToggle.textContent = isImageMetaDetailsExpanded ? "Hide details" : "Show details";
    }

    function renderStartEndSummary(state) {
        var shots = state.shots || [];
        var startShot = findShotById(shots, state.startShotId);
        var endShot = findShotById(shots, state.endShotId);

        renderSummaryCard(startShot, "galleryStartThumbWrap", "galleryStartThumb", "galleryStartLabel", "Start");
        renderSummaryCard(endShot, "galleryEndThumbWrap", "galleryEndThumb", "galleryEndLabel", "End");
    }

    function renderVideoModeUi(state) {
        var settings = getVideoGenSettings(state);
        var mode = settings.mode;
        var generateBlock = getById("videoGenerateBlock");
        var btnGenTypeImage = getById("btnGenTypeImage");
        var btnGenTypeVideo = getById("btnGenTypeVideo");
        var btnFrames = getById("btnModeFrames");
        var btnReference = getById("btnModeReference");
        var btnSetStart = getById("btnSetStart");
        var btnSetEnd = getById("btnSetEnd");
        var hint = getById("videoModeHint");
        var startEndRow = getById("videoStartEndRow");
        var startCard = getById("videoStartCard");
        var endCard = getById("videoEndCard");
        var swapBtn = getById("btnSwapStartEnd");
        var refsBlock = getById("videoRefsBlock");
        var imageRefsBlock = getById("imageRefsBlock");
        var videoModeOptionsRow = getById("videoModeOptionsRow");
        var videoOptionsRow = getById("videoOptionsRow");
        var imageOptionsRow = getById("imageOptionsRow");
        var videoModelLabel = getById("videoFlowModelLabel");
        var imageModelLabel = getById("imageFlowModelLabel");
        var promptInput = getById("promptInput");
        var inlineUnavailable = videoCapabilities.checked && !videoCapabilities.inlineData && activeGenerationType === GEN_TYPE_VIDEO;

        function setModeBtnState(btn, active) {
            if (!btn) {
                return;
            }
            btn.className = "mode-tab-btn" + (active ? " is-active" : "");
        }

        setModeBtnState(btnGenTypeImage, activeGenerationType === GEN_TYPE_IMAGE);
        setModeBtnState(btnGenTypeVideo, activeGenerationType === GEN_TYPE_VIDEO);
        setModeBtnState(btnFrames, mode === VIDEO_MODE_FRAMES);
        setModeBtnState(btnReference, mode === VIDEO_MODE_REFERENCE);

        if (btnFrames) {
            btnFrames.disabled = false;
        }
        if (btnReference) {
            btnReference.disabled = false;
        }
        if (generateBlock) {
            generateBlock.setAttribute("data-video-mode", mode);
            generateBlock.setAttribute("data-gen-type", activeGenerationType);
        }
        if (btnSetStart) {
            btnSetStart.hidden = true;
        }
        if (btnSetEnd) {
            btnSetEnd.hidden = true;
        }

        if (startEndRow) {
            startEndRow.hidden = !(activeGenerationType === GEN_TYPE_VIDEO && mode === VIDEO_MODE_FRAMES);
            startEndRow.className = "start-end-row mode-" + mode;
        }
        if (startCard) {
            startCard.hidden = !(activeGenerationType === GEN_TYPE_VIDEO && mode === VIDEO_MODE_FRAMES);
        }
        if (endCard) {
            endCard.hidden = !(activeGenerationType === GEN_TYPE_VIDEO && mode === VIDEO_MODE_FRAMES);
        }
        if (swapBtn) {
            swapBtn.hidden = !(activeGenerationType === GEN_TYPE_VIDEO && mode === VIDEO_MODE_FRAMES);
        }
        if (refsBlock) {
            refsBlock.hidden = !(activeGenerationType === GEN_TYPE_VIDEO && mode === VIDEO_MODE_REFERENCE);
        }
        if (imageRefsBlock) {
            imageRefsBlock.hidden = activeGenerationType !== GEN_TYPE_IMAGE;
        }
        if (videoModeOptionsRow) {
            videoModeOptionsRow.hidden = activeGenerationType !== GEN_TYPE_VIDEO;
        }
        if (videoOptionsRow) {
            videoOptionsRow.hidden = activeGenerationType !== GEN_TYPE_VIDEO;
        }
        if (imageOptionsRow) {
            imageOptionsRow.hidden = activeGenerationType !== GEN_TYPE_IMAGE;
        }
        if (videoModelLabel) {
            videoModelLabel.hidden = activeGenerationType !== GEN_TYPE_VIDEO;
        }
        if (imageModelLabel) {
            imageModelLabel.hidden = activeGenerationType !== GEN_TYPE_IMAGE;
        }
        if (promptInput) {
            if (activeGenerationType === GEN_TYPE_IMAGE) {
                promptInput.placeholder = "Describe the image you want to generate.";
            } else if (mode === VIDEO_MODE_FRAMES) {
                promptInput.placeholder = "Describe motion: no Start/End = text-to-video, Start only = image-to-video, Start+End = interpolation.";
            } else {
                promptInput.placeholder = "Describe the motion while keeping reference style/subject.";
            }
        }

        if (hint) {
            if (activeGenerationType === GEN_TYPE_IMAGE) {
                hint.textContent = "Image mode: prompt + optional references (up to 4).";
                hint.className = "refs-note";
            } else if (inlineUnavailable) {
                hint.textContent = "Image inputs aren't confirmed for this key/project. Frames/Reference may fail with API 400, but you can still try.";
                hint.className = "refs-note inline-status is-error";
            } else if (mode === VIDEO_MODE_FRAMES) {
                hint.textContent = "Frames mode: no Start/End = Text-to-Video; Start only = Image-to-Video; Start+End = Interpolation.";
                hint.className = "refs-note";
            } else {
                hint.textContent = "Reference Images: add up to 3 refs, then describe desired motion.";
                hint.className = "refs-note";
            }
        }
    }

    function renderFlowComposerSummary(state) {
        var videoBtn = getById("btnVideoFlowOptions");
        var videoModelLabel = getById("videoFlowModelLabel");
        var imageModelLabel = getById("imageFlowModelLabel");
        var sampleSelect = getById("sampleCountSelect");
        var imageSampleSelect = getById("imageSampleCountSelect");
        var aspectSelect = getById("aspectRatioSelect");
        var imageAspectSelect = getById("imageAspectRatioSelect");
        var modelSelect = getById("modelSelect");
        var imageModelSelect = getById("imageModelSelect");
        var mode = normalizeVideoMode(getVideoGenSettings(state).mode);
        var videoModeLabel = "Frames";
        var videoSampleText = "x2";
        var imageSampleText = "x1";
        var videoAspectText = "16:9";
        var imageAspectText = "1:1";
        var imageSettings = state && state.imageGenSettings ? state.imageGenSettings : {};

        if (mode === VIDEO_MODE_REFERENCE) {
            videoModeLabel = "Ingredients";
        }

        if (sampleSelect && sampleSelect.value) {
            videoSampleText = "x" + String(sampleSelect.value);
        }
        if (imageSampleSelect && imageSampleSelect.value) {
            imageSampleText = "x" + String(imageSampleSelect.value);
        }
        if (aspectSelect && aspectSelect.value) {
            videoAspectText = String(aspectSelect.value);
        }
        if (imageAspectSelect && imageAspectSelect.value) {
            imageAspectText = String(imageAspectSelect.value);
        }

        if (videoBtn) {
            videoBtn.setAttribute("data-gen-type", activeGenerationType);
            videoBtn.setAttribute("data-video-mode", mode);
            if (activeGenerationType === GEN_TYPE_IMAGE) {
                videoBtn.textContent = "Image \u2022 " + imageSampleText + " \u2022 " + imageAspectText;
            } else {
                videoBtn.textContent = "Video \u2022 " + videoModeLabel + " \u2022 " + videoSampleText + " \u2022 " + videoAspectText;
            }
        }

        if (videoModelLabel) {
            videoModelLabel.textContent = modelSelect && modelSelect.value ? modelSelect.value : "-";
        }
        if (imageModelLabel) {
            imageModelLabel.textContent = imageModelSelect && imageModelSelect.value ? imageModelSelect.value : (imageSettings.model || "-");
        }
    }

    function syncImageSettingsControls(state) {
        var settings = state.imageGenSettings || {};
        var modelSelect = getById("imageModelSelect");
        var aspectSelect = getById("imageAspectRatioSelect");
        var sizeSelect = getById("imageSizeSelect");

        if (modelSelect && settings.model) {
            modelSelect.value = settings.model;
        }
        if (aspectSelect) {
            aspectSelect.value = normalizeImageAspectRatio(settings.aspectRatio || "1:1");
        }
        if (sizeSelect) {
            sizeSelect.value = normalizeImageSize(settings.imageSize || "1K");
        }
    }

    function syncVideoSettingsControls(state) {
        var settings = getVideoGenSettings(state);
        var modelSelect = getById("modelSelect");
        var aspectSelect = getById("aspectRatioSelect");

        if (modelSelect) {
            modelSelect.value = settings.model;
        }
        if (aspectSelect) {
            aspectSelect.value = settings.aspectRatio;
        }
    }

    function ensureStateSelections(state) {
        var shots = state.shots || [];
        var videos = state.videos || [];
        var images = state.images || [];
        var selectedShotExists = !!findShotById(shots, state.selectedShotId);
        var selectedVideoExists = !!findVideoById(videos, state.selectedVideoId);
        var selectedImageExists = !!findImageById(images, state.selectedImageId);
        var patch = {};
        var hasPatch = false;

        if (shots.length && !selectedShotExists) {
            patch.selectedShotId = shots[shots.length - 1].id;
            hasPatch = true;
        }
        if (!shots.length && state.selectedShotId) {
            patch.selectedShotId = null;
            hasPatch = true;
        }

        if (videos.length && !selectedVideoExists) {
            patch.selectedVideoId = videos[0].id;
            hasPatch = true;
        }
        if (!videos.length && state.selectedVideoId) {
            patch.selectedVideoId = null;
            hasPatch = true;
        }

        if (images.length && !selectedImageExists) {
            patch.selectedImageId = images[0].id;
            hasPatch = true;
        }
        if (!images.length && state.selectedImageId) {
            patch.selectedImageId = null;
            hasPatch = true;
        }

        if (hasPatch) {
            stateAdapterUpdate(patch);
            return true;
        }

        return false;
    }

    function renderAll(state) {
        try {
            if (ensureStateSelections(state)) {
                return;
            }
            renderShotsList(state);
            renderImageShotsList(state);
            renderVideosList(state);
            renderStartEndSummary(state);
            renderVideoRefsList(state);
            renderVideoPreview(state);

            renderRefsList(state);
            renderImagesList(state);
            renderImagePreview(state);
            renderMediaPreviewOverlay(state);
            syncVideoSettingsControls(state);
            syncImageSettingsControls(state);
            renderVideoModeUi(state);
            renderFlowComposerSummary(state);
            updateCarouselDensity();
        } catch (error) {
            setStatus("Render failed: " + formatError(error), true);
        }
    }

    function setControlsEnabled(ids, enabled) {
        var i;
        var el;
        for (i = 0; i < ids.length; i += 1) {
            el = getById(ids[i]);
            if (el) {
                el.disabled = !enabled;
            }
        }
    }

    function refreshBusyUi() {
        // Keep composer controls interactive so users can queue next requests immediately.
        setControlsEnabled([
            "btnGenerate",
            "btnVideoFlowOptions",
            "btnGenTypeImage",
            "btnGenTypeVideo",
            "btnOpenVideoStartPicker",
            "btnOpenVideoEndPicker",
            "btnOpenVideoRefPicker",
            "btnModeFrames",
            "btnModeReference",
            "btnSetStart",
            "btnSetEnd",
            "btnClearStart",
            "btnClearEnd",
            "btnSwapStartEnd",
            "btnAddVideoRefSelected",
            "btnClearVideoRefs",
            "btnDeleteVideo",
            "btnRevealVideo",
            "btnImportVideo",
            "sampleCountSelect",
            "modelSelect",
            "aspectRatioSelect",
            "promptInput",
            "btnTabVideo",
            "btnTabImage"
        ], true);

        setControlsEnabled([
            "btnGenerateImage",
            "btnOpenImageShotPicker",
            "imagePromptInput",
            "imageSampleCountSelect",
            "imageModelSelect",
            "imageAspectRatioSelect",
            "imageSizeSelect",
            "btnAddRefs",
            "btnAddSelectedShotToRefs",
            "btnClearRefs",
            "btnImportImage",
            "btnAddImageToFrames",
            "btnRevealImage",
            "btnDeleteImage"
        ], true);

        renderVideoModeUi(getState());
    }

    function getVideoGenerationInput() {
        var state = getState();
        var shots = state.shots || [];
        var startShot = findShotById(shots, state.startShotId);
        var endShot = findShotById(shots, state.endShotId);
        var videoSettings = getVideoGenSettings(state);
        var mode = normalizeVideoMode(videoSettings.mode);
        var videoRefs = getVideoRefs(state);
        var promptInput = getById("promptInput");
        var sampleSelect = getById("sampleCountSelect");
        var modelSelect = getById("modelSelect");
        var aspectRatioSelect = getById("aspectRatioSelect");
        var prompt = trimText(promptInput ? promptInput.value : "");
        var sampleCount = parseSampleCount(sampleSelect ? sampleSelect.value : "2");
        var modelId = trimText(modelSelect ? modelSelect.value : videoSettings.model);
        var aspectRatio = normalizeAspectRatio(aspectRatioSelect ? aspectRatioSelect.value : videoSettings.aspectRatio);
        var apiKey = getApiKeyFromStorage();
        var i;
        var refIds = [];

        if (!modelId && window.VeoApi) {
            modelId = window.VeoApi.DEFAULT_MODEL_ID || "veo-3.1-generate-preview";
        }
        if (!modelId) {
            throw new Error("Generation model is not selected.");
        }

        if (!apiKey) {
            throw new Error("API key is missing. Open Settings in the main panel.");
        }
        if (!prompt) {
            throw new Error("Prompt is empty.");
        }

        if (mode === VIDEO_MODE_FRAMES) {
            if (!startShot && endShot) {
                throw new Error("End frame requires Start frame.");
            }
            if (startShot && startShot.path && !fileExists(startShot.path)) {
                throw new Error("Start frame file is missing on disk: " + startShot.path);
            }
        }
        if (mode === VIDEO_MODE_FRAMES && endShot && endShot.path && !fileExists(endShot.path)) {
            throw new Error("End frame file is missing on disk: " + endShot.path);
        }
        if (mode === VIDEO_MODE_REFERENCE) {
            if (!videoRefs.length) {
                throw new Error("Reference mode requires at least 1 reference image.");
            }
            if (videoRefs.length > UI_MAX_VIDEO_REFERENCE_IMAGES) {
                throw new Error("Reference limit reached (" + UI_MAX_VIDEO_REFERENCE_IMAGES + ").");
            }
            for (i = 0; i < videoRefs.length; i += 1) {
                if (!videoRefs[i] || !videoRefs[i].path) {
                    throw new Error("Reference image path is invalid.");
                }
                if (!isSupportedImagePath(videoRefs[i].path)) {
                    throw new Error("Reference image must be PNG/JPG/WEBP: " + videoRefs[i].path);
                }
                if (!fileExists(videoRefs[i].path)) {
                    throw new Error("Reference image file is missing: " + videoRefs[i].path);
                }
                refIds.push(videoRefs[i].id || null);
            }
        }

        try {
            window.localStorage.setItem(STORAGE_KEY_MODEL, modelId);
            window.localStorage.setItem(STORAGE_KEY_PROMPT, prompt);
            window.localStorage.setItem(STORAGE_KEY_ASPECT_RATIO, aspectRatio);
            window.localStorage.setItem(STORAGE_KEY_VIDEO_MODE, mode);
            if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function") {
                window.VeoBridgeSettings.saveSettings({ modelId: modelId, aspectRatio: aspectRatio });
            }
        } catch (writeError) {
            // ignore
        }

        return {
            apiKey: apiKey,
            prompt: prompt,
            sampleCount: sampleCount,
            modelId: modelId,
            aspectRatio: aspectRatio,
            mode: mode,
            durationSeconds: 8,
            resolution: "720p",
            videosDir: resolveLibraryVideosDir(),
            startShot: startShot,
            endShot: endShot,
            references: videoRefs,
            referenceIds: refIds
        };
    }

    function getImageGenerationInput() {
        var state = getState();
        var refs = state.refs || [];
        var promptInput = getById("promptInput") || getById("imagePromptInput");
        var modelSelect = getById("imageModelSelect");
        var aspectSelect = getById("imageAspectRatioSelect");
        var sizeSelect = getById("imageSizeSelect");
        var prompt = trimText(promptInput ? promptInput.value : "");
        var modelId = trimText(modelSelect ? modelSelect.value : "") || (window.VeoApi ? window.VeoApi.DEFAULT_IMAGE_MODEL_ID : "gemini-3.1-flash-image-preview");
        var aspectRatio = normalizeImageAspectRatio(aspectSelect ? aspectSelect.value : "1:1");
        var imageSize = normalizeImageSize(sizeSelect ? sizeSelect.value : "1K");
        var apiKey = getApiKeyFromStorage();
        var i;

        if (!apiKey) {
            throw new Error("API key is missing. Open Settings in the main panel.");
        }
        if (!prompt) {
            throw new Error("Prompt is empty.");
        }

        for (i = 0; i < refs.length; i += 1) {
            if (!refs[i] || !refs[i].path) {
                throw new Error("Reference image path is invalid.");
            }
            if (!isSupportedImagePath(refs[i].path)) {
                throw new Error("Reference image must be PNG/JPG/WEBP: " + refs[i].path);
            }
            if (!fileExists(refs[i].path)) {
                throw new Error("Reference image file is missing: " + refs[i].path);
            }
        }

        try {
            window.localStorage.setItem(STORAGE_KEY_IMAGE_PROMPT, prompt);
        } catch (error) {
            // ignore
        }

        return {
            apiKey: apiKey,
            prompt: prompt,
            modelId: modelId,
            aspectRatio: aspectRatio,
            imageSize: imageSize,
            references: refs,
            imagesDir: resolveLibraryImagesDir()
        };
    }

    function appendGeneratedVideo(result, context) {
        var state = getState();
        var videos = state.videos ? state.videos.slice(0) : [];
        var savedPath = result && result.downloadedPath ? result.downloadedPath : "";
        var videoRecord = {
            id: makeId("video"),
            path: savedPath,
            createdAt: (new Date()).toISOString(),
            prompt: context.prompt,
            aspectRatio: context.aspectRatio,
            startShotId: context.startShot && context.startShot.id ? context.startShot.id : null,
            endShotId: context.endShot && context.endShot.id ? context.endShot.id : null,
            startShotPath: context.startShot && context.startShot.path ? context.startShot.path : null,
            endShotPath: context.endShot && context.endShot.path ? context.endShot.path : null,
            model: context.modelId,
            mode: context.mode || null,
            durationSeconds: context.durationSeconds || null,
            resolution: context.resolution || null,
            refIds: context.referenceIds || [],
            requestMode: result.requestMode || "frames",
            batchId: context.batchId || null,
            sampleIndex: context.sampleIndex || null,
            sampleCount: context.sampleCount || null,
            status: "ready",
            importedToProject: false,
            projectImportPath: null,
            importedAt: null
        };

        if (!savedPath) {
            throw new Error("Generation finished but downloaded video path is empty.");
        }
        if (!fileExists(savedPath)) {
            throw new Error("Generated video file was not found on disk: " + savedPath);
        }

        videos.unshift(videoRecord);

        stateAdapterUpdate({
            videos: videos,
            selectedVideoId: videoRecord.id
        });

        return videoRecord;
    }

    function appendGeneratedImage(result, context, dimensions) {
        var state = getState();
        var images = state.images ? state.images.slice(0) : [];
        var savedPath = result && (result.path || result.downloadedPath) ? (result.path || result.downloadedPath) : "";
        var imageRecord = {
            id: makeId("image"),
            path: savedPath,
            createdAt: (new Date()).toISOString(),
            prompt: context.prompt,
            aspectRatio: context.aspectRatio,
            imageSize: context.imageSize,
            model: context.modelId,
            batchId: context.batchId || null,
            sampleIndex: context.sampleIndex || null,
            sampleCount: context.sampleCount || null,
            refIds: context.referenceIds || [],
            refPaths: context.referencePaths || [],
            width: dimensions && dimensions.width ? dimensions.width : null,
            height: dimensions && dimensions.height ? dimensions.height : null,
            status: "ready",
            importedToProject: false,
            projectImportPath: null,
            importedAt: null
        };

        if (!savedPath) {
            throw new Error("Image generation finished but output path is empty.");
        }
        if (!fileExists(savedPath)) {
            throw new Error("Generated image file was not found on disk: " + savedPath);
        }

        images.unshift(imageRecord);

        stateAdapterUpdate({
            images: images,
            selectedImageId: imageRecord.id
        });

        return imageRecord;
    }

    function resolveApiModeForInput(input) {
        if (input.mode === VIDEO_MODE_FRAMES) {
            if (input.startShot && input.startShot.path && input.endShot && input.endShot.path) {
                return "interpolation";
            }
            if (input.startShot && input.startShot.path) {
                return "image";
            }
            return "text";
        }
        if (input.mode === VIDEO_MODE_REFERENCE) {
            return "reference";
        }
        return "text";
    }

    function cloneReferenceEntriesForJob(refs) {
        var source = refs && refs instanceof Array ? refs : [];
        var next = [];
        var i;
        var item;

        for (i = 0; i < source.length; i += 1) {
            item = source[i];
            if (!item || !item.path) {
                continue;
            }
            next.push({
                id: item.id || null,
                path: item.path,
                name: item.name || baseName(item.path),
                mimeType: item.mimeType || guessImageMimeType(item.path),
                createdAt: item.createdAt || (new Date()).toISOString()
            });
        }
        return next;
    }

    function enqueueVideoGenerationJobs(input) {
        var nowIso = (new Date()).toISOString();
        var jobs = [];
        var i;
        var apiMode = resolveApiModeForInput(input);
        var refsSnapshot = cloneReferenceEntriesForJob(input.references || []);
        var refIds = input.referenceIds && input.referenceIds instanceof Array ? input.referenceIds.slice(0) : [];
        var batchId = input.batchId || makeId("video_batch");

        for (i = 1; i <= input.sampleCount; i += 1) {
            jobs.push({
                id: makeId("video_job"),
                kind: "video",
                batchId: batchId,
                status: "queued",
                sampleIndex: i,
                sampleCount: input.sampleCount,
                createdAt: nowIso,
                updatedAt: nowIso,
                progressPercent: 0,
                prompt: input.prompt,
                modelId: input.modelId,
                aspectRatio: input.aspectRatio,
                uiMode: input.mode,
                apiMode: apiMode,
                durationSeconds: input.durationSeconds || 8,
                resolution: input.resolution || "720p",
                videosDir: input.videosDir || "",
                startShotId: input.startShot && input.startShot.id ? input.startShot.id : null,
                endShotId: input.endShot && input.endShot.id ? input.endShot.id : null,
                startShotPath: input.startShot && input.startShot.path ? input.startShot.path : "",
                endShotPath: input.endShot && input.endShot.path ? input.endShot.path : "",
                startShotCompName: input.startShot && input.startShot.compName ? input.startShot.compName : null,
                endShotCompName: input.endShot && input.endShot.compName ? input.endShot.compName : null,
                startShotFrame: input.startShot && typeof input.startShot.frame === "number" ? input.startShot.frame : null,
                endShotFrame: input.endShot && typeof input.endShot.frame === "number" ? input.endShot.frame : null,
                references: refsSnapshot,
                referenceIds: refIds
            });
        }

        mutatePendingJobs(function (existing) {
            return existing.concat(jobs);
        });
        return jobs;
    }

    function enqueueImageGenerationJobs(input, sampleCount, batchId) {
        var nowIso = (new Date()).toISOString();
        var jobs = [];
        var i;
        var refsSnapshot = cloneReferenceEntriesForJob(input.references || []);

        for (i = 1; i <= sampleCount; i += 1) {
            jobs.push({
                id: makeId("image_job"),
                kind: "image",
                batchId: batchId,
                status: "queued",
                sampleIndex: i,
                sampleCount: sampleCount,
                createdAt: nowIso,
                updatedAt: nowIso,
                progressPercent: 0,
                prompt: input.prompt,
                modelId: input.modelId,
                aspectRatio: input.aspectRatio,
                imageSize: input.imageSize,
                references: refsSnapshot
            });
        }

        mutatePendingJobs(function (existing) {
            return existing.concat(jobs);
        });
        return jobs;
    }

    function sortJobsForExecution(jobs) {
        var list = jobs.slice(0);
        list.sort(function (a, b) {
            var ac = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
            var bc = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
            if (ac !== bc) {
                return ac - bc;
            }
            return (a.sampleIndex || 0) - (b.sampleIndex || 0);
        });
        return list;
    }

    function getPendingVideoJobsForExecution(jobIds) {
        var state = getState();
        var jobs = getPendingJobs(state);
        var idMap = {};
        var selected = [];
        var i;
        var job;

        if (jobIds && jobIds instanceof Array) {
            for (i = 0; i < jobIds.length; i += 1) {
                idMap[jobIds[i]] = true;
            }
        }

        for (i = 0; i < jobs.length; i += 1) {
            job = jobs[i];
            if (!isActiveVideoJob(job)) {
                continue;
            }
            if (jobIds && jobIds instanceof Array && !idMap[job.id]) {
                continue;
            }
            selected.push(job);
        }

        return sortJobsForExecution(selected);
    }

    function getPendingImageJobsForExecution(jobIds) {
        var state = getState();
        var jobs = getPendingJobs(state);
        var idMap = {};
        var selected = [];
        var i;
        var job;

        if (jobIds && jobIds instanceof Array) {
            for (i = 0; i < jobIds.length; i += 1) {
                idMap[jobIds[i]] = true;
            }
        }

        for (i = 0; i < jobs.length; i += 1) {
            job = jobs[i];
            if (!isActiveImageJob(job)) {
                continue;
            }
            if (jobIds && jobIds instanceof Array && !idMap[job.id]) {
                continue;
            }
            selected.push(job);
        }

        return sortJobsForExecution(selected);
    }

    function buildGeneratePayloadFromVideoJob(job, apiKey) {
        var payload = {
            apiKey: apiKey,
            prompt: job.prompt || "",
            mode: job.apiMode || "text",
            startShotPath: job.startShotPath || "",
            endShotPath: job.endShotPath || "",
            modelId: job.modelId || "",
            aspectRatio: normalizeAspectRatio(job.aspectRatio || "16:9"),
            durationSeconds: job.durationSeconds || 8,
            resolution: job.resolution || "720p",
            sampleIndex: job.sampleIndex || 1,
            sampleCount: job.sampleCount || 1,
            referenceImages: cloneReferenceEntriesForJob(job.references || []),
            videosDir: job.videosDir || "",
            allowTextOnlyFallback: false
        };

        if (job.operationName || job.operationUrl) {
            payload.resumeOperationName = job.operationName || "";
            payload.resumeOperationUrl = job.operationUrl || "";
            payload.requestMode = job.requestMode || "";
            payload.fallbackReason = job.fallbackReason || "";
        }
        return payload;
    }

    function buildVideoContextFromJob(job) {
        var startShot = null;
        var endShot = null;

        if (job.startShotId || job.startShotPath) {
            startShot = {
                id: job.startShotId || null,
                path: job.startShotPath || null,
                compName: job.startShotCompName || null,
                frame: typeof job.startShotFrame === "number" ? job.startShotFrame : null
            };
        }
        if (job.endShotId || job.endShotPath) {
            endShot = {
                id: job.endShotId || null,
                path: job.endShotPath || null,
                compName: job.endShotCompName || null,
                frame: typeof job.endShotFrame === "number" ? job.endShotFrame : null
            };
        }

        return {
            prompt: job.prompt || "",
            aspectRatio: normalizeAspectRatio(job.aspectRatio || "16:9"),
            startShot: startShot,
            endShot: endShot,
            modelId: job.modelId || "",
            mode: job.uiMode || VIDEO_MODE_FRAMES,
            durationSeconds: job.durationSeconds || 8,
            resolution: job.resolution || "720p",
            referenceIds: job.referenceIds && job.referenceIds instanceof Array ? job.referenceIds.slice(0) : [],
            batchId: job.batchId || null,
            sampleIndex: job.sampleIndex || null,
            sampleCount: job.sampleCount || null
        };
    }

    function markRemainingVideoJobsFailed(jobIds, reason) {
        var idMap = {};
        var i;
        var text = reason || "Cancelled because previous sample failed.";
        for (i = 0; i < jobIds.length; i += 1) {
            idMap[jobIds[i]] = true;
        }
        mutatePendingJobs(function (jobs) {
            var next = jobs.slice(0);
            var idx;
            var item;
            for (idx = 0; idx < next.length; idx += 1) {
                item = next[idx];
                if (!item || !idMap[item.id]) {
                    continue;
                }
                if (!isActivePendingJob(item)) {
                    continue;
                }
                item.status = "failed";
                item.error = text;
                item.lastStage = "Cancelled";
                item.updatedAt = (new Date()).toISOString();
            }
            return next;
        });
    }

    function runPendingVideoJobs(options) {
        var runOptions = options || {};
        var targetIds = runOptions.jobIds && runOptions.jobIds instanceof Array ? runOptions.jobIds.slice(0) : null;
        var stopOnError = runOptions.stopOnError !== false;
        var requestedConcurrency = parseInt(runOptions.concurrency, 10);
        var jobs = getPendingVideoJobsForExecution(targetIds);
        var trackedJobIds = {};
        var total = jobs.length;
        var done = 0;
        var failed = 0;
        var firstError = null;
        var apiKey = getApiKeyFromStorage();
        var nextIndex = 0;
        var activeCount = 0;
        var completedCount = 0;
        var isAborting = false;
        var concurrency = requestedConcurrency;
        var launchTimer = null;
        var isLaunching = false;
        var i;

        function registerTrackedJobs(items) {
            var idx;
            var candidate;
            for (idx = 0; idx < items.length; idx += 1) {
                candidate = items[idx];
                if (candidate && candidate.id) {
                    trackedJobIds[candidate.id] = true;
                }
            }
        }

        function injectQueuedJobs() {
            var injectedIds = drainInjectedVideoJobIds();
            var injectedJobs;
            var added = 0;
            var idx;
            var candidate;
            if (!injectedIds.length) {
                return 0;
            }
            injectedJobs = getPendingVideoJobsForExecution(injectedIds);
            for (idx = 0; idx < injectedJobs.length; idx += 1) {
                candidate = injectedJobs[idx];
                if (!candidate || !candidate.id || trackedJobIds[candidate.id]) {
                    continue;
                }
                trackedJobIds[candidate.id] = true;
                jobs.push(candidate);
                total += 1;
                added += 1;
            }
            if (added > 0) {
                jobs = sortJobsForExecution(jobs);
            }
            return added;
        }

        if (!isFinite(concurrency) || concurrency < 1) {
            concurrency = Math.min(4, total || 1);
        }
        if (concurrency > 4) {
            concurrency = 4;
        }
        registerTrackedJobs(jobs);

        function setJobProgress(job, stage, details, isError) {
            var info = details || {};
            var jobProgress = normalizeProgressPercent(info.progressPercent);
            var fallbackProgress = stageToProgressPercent(stage);
            var progressText = "";
            var label = "Sample " + (job.sampleIndex || 1) + "/" + (job.sampleCount || total);
            var suffix = " (" + done + "/" + total + " done";

            if (jobProgress === null && fallbackProgress !== null) {
                jobProgress = fallbackProgress;
            }
            if (jobProgress !== null) {
                progressText = " " + String(jobProgress) + "%";
            }

            if (failed > 0) {
                suffix += ", " + failed + " failed";
            }
            suffix += ")";

            setGenerationStatus(label + ": " + stage + progressText + "..." + suffix, !!isError);
            setStatus(label + ": " + stage + progressText + "..." + suffix, !!isError);
        }

        function runOne(job) {
            var payload = buildGeneratePayloadFromVideoJob(job, apiKey);
            var context = buildVideoContextFromJob(job);
            var statusFromStage;

            if (!payload.prompt) {
                return Promise.reject(new Error("Prompt is empty."));
            }

            patchPendingJob(job.id, {
                status: payload.resumeOperationName || payload.resumeOperationUrl ? "polling" : "uploading",
                error: null,
                progressPercent: payload.resumeOperationName || payload.resumeOperationUrl ? 36 : 8,
                lastStage: payload.resumeOperationName || payload.resumeOperationUrl ? "Polling" : "Uploading"
            });

            payload.onStatus = function (stage, details) {
                var info = details || {};
                var progressFromDetails = normalizeProgressPercent(info.progressPercent);
                var progressForPatch = progressFromDetails;
                statusFromStage = mapVideoStageToJobStatus(stage);
                if (progressForPatch === null) {
                    progressForPatch = stageToProgressPercent(stage);
                }
                patchPendingJob(job.id, {
                    status: statusFromStage,
                    progressPercent: progressForPatch,
                    lastStage: stage || null
                });
                setJobProgress(job, stage || "Working", info, false);
            };

            payload.onOperation = function (operationInfo) {
                patchPendingJob(job.id, {
                    status: "polling",
                    progressPercent: 40,
                    operationName: operationInfo && operationInfo.operationName ? operationInfo.operationName : null,
                    operationUrl: operationInfo && operationInfo.operationUrl ? operationInfo.operationUrl : null,
                    requestMode: operationInfo && operationInfo.requestMode ? operationInfo.requestMode : (job.requestMode || null),
                    fallbackReason: operationInfo && operationInfo.fallbackReason ? operationInfo.fallbackReason : (job.fallbackReason || null),
                    lastStage: "Polling"
                });
            };

            return window.VeoApi.generateVideo(payload).then(function (result) {
                patchPendingJob(job.id, {
                    status: "importing",
                    progressPercent: 96,
                    downloadedPath: result && result.downloadedPath ? result.downloadedPath : null,
                    operationName: result && result.operationName ? result.operationName : (job.operationName || null),
                    operationUrl: result && result.operationUrl ? result.operationUrl : (job.operationUrl || null),
                    requestMode: result && result.requestMode ? result.requestMode : (job.requestMode || null),
                    fallbackReason: result && result.fallbackReason ? result.fallbackReason : (job.fallbackReason || null),
                    lastStage: "Importing"
                });

                appendGeneratedVideo(result, context);
                removePendingJob(job.id);
                if (result.requestMode === "text_only_fallback") {
                    setGenerationStatus("Sample " + (job.sampleIndex || 1) + "/" + (job.sampleCount || total) + ": Done (text-only fallback) (" + (done + 1) + "/" + total + ")", false);
                } else {
                    setGenerationStatus("Sample " + (job.sampleIndex || 1) + "/" + (job.sampleCount || total) + ": Done (" + (done + 1) + "/" + total + ")", false);
                }
                setStatus("Done: " + baseName(result.downloadedPath), false);
            }, function (error) {
                var message = toCardErrorMessage(error);
                patchPendingJob(job.id, {
                    status: "failed",
                    error: message,
                    progressPercent: 0,
                    lastStage: "Failed"
                });
                throw new Error("Sample " + (job.sampleIndex || 1) + "/" + (job.sampleCount || total) + ": " + message);
            });
        }

        function finishAndReset(resolve, reject) {
            isVideoGenerating = false;
            isResumingPendingJobs = false;
            stopPendingJobsLeaseHeartbeat();
            releasePendingJobsLease();
            if (launchTimer && typeof window.clearInterval === "function") {
                window.clearInterval(launchTimer);
                launchTimer = null;
            }
            refreshBusyUi();
            if (hasActivePendingVideoJobs(getState())) {
                schedulePendingVideoResume(120);
            }
            if (failed > 0) {
                setGenerationStatus("Completed with errors (" + done + "/" + total + " done, " + failed + " failed).", true);
                setStatus("Video generation completed with errors.", true);
            }
            resolve({
                done: done,
                failed: failed,
                total: total,
                hasErrors: failed > 0
            });
        }

        if (!total) {
            return Promise.resolve();
        }
        if (!apiKey) {
            return Promise.reject(new Error("API key is missing. Open Settings in the main panel."));
        }
        if (isVideoGenerating) {
            return Promise.reject(new Error("Another operation is already running."));
        }
        if (!acquirePendingJobsLease()) {
            if (runOptions.isResume) {
                return Promise.resolve();
            }
            return Promise.reject(new Error("Pending jobs are already processed in another Gallery window."));
        }

        isVideoGenerating = true;
        isResumingPendingJobs = !!runOptions.isResume;
        startPendingJobsLeaseHeartbeat();
        refreshBusyUi();

        return new Promise(function (resolve, reject) {
            function maybeFinish() {
                if (!isAborting) {
                    injectQueuedJobs();
                }
                if (completedCount >= total && activeCount === 0) {
                    finishAndReset(resolve, reject);
                }
            }

            function launchNext() {
                var job;
                var runPromise;
                var nextConcurrency = concurrency;

                if (isLaunching) {
                    return;
                }
                isLaunching = true;

                try {
                    if (!isAborting) {
                        injectQueuedJobs();
                    }

                    if (isAborting && activeCount === 0) {
                        maybeFinish();
                        return;
                    }

                    nextConcurrency = Math.min(4, total || 1);
                    if (nextConcurrency < 1) {
                        nextConcurrency = 1;
                    }

                    while (!isAborting && activeCount < nextConcurrency && nextIndex < total) {
                        job = jobs[nextIndex];
                        nextIndex += 1;
                        activeCount += 1;

                        try {
                            runPromise = runOne(job);
                        } catch (syncError) {
                            activeCount -= 1;
                            completedCount += 1;
                            failed += 1;
                            firstError = firstError || syncError;
                            if (stopOnError) {
                                isAborting = true;
                                markRemainingVideoJobsFailed(targetIds || [], toCardErrorMessage(syncError));
                            }
                            continue;
                        }

                        if (!runPromise || typeof runPromise.then !== "function") {
                            runPromise = Promise.resolve(runPromise);
                        }

                        (function (jobRef, promiseRef) {
                            promiseRef.then(function () {
                                done += 1;
                                activeCount -= 1;
                                completedCount += 1;
                                if (!isAborting) {
                                    launchNext();
                                }
                                maybeFinish();
                            }, function (error) {
                                failed += 1;
                                activeCount -= 1;
                                completedCount += 1;
                                firstError = firstError || error;
                                if (stopOnError && !isAborting) {
                                    isAborting = true;
                                    markRemainingVideoJobsFailed(targetIds || [], toCardErrorMessage(error));
                                }
                                if (!isAborting) {
                                    launchNext();
                                }
                                maybeFinish();
                            });
                        }(job, runPromise));
                    }

                    maybeFinish();
                } finally {
                    isLaunching = false;
                }
            }

            if (typeof window.setInterval === "function") {
                launchTimer = window.setInterval(function () {
                    if (isAborting) {
                        return;
                    }
                    launchNext();
                }, 120);
            }

            launchNext();
        });
    }

    function hasActivePendingVideoJobs(state) {
        var jobs = getPendingJobs(state || getState());
        var i;
        for (i = 0; i < jobs.length; i += 1) {
            if (isActiveVideoJob(jobs[i])) {
                return true;
            }
        }
        return false;
    }

    function schedulePendingVideoResume(delayMs) {
        var waitMs = typeof delayMs === "number" && delayMs >= 0 ? delayMs : 300;

        if (pendingVideoResumeTimer && typeof window.clearTimeout === "function") {
            window.clearTimeout(pendingVideoResumeTimer);
            pendingVideoResumeTimer = null;
        }
        if (typeof window.setTimeout !== "function") {
            return;
        }
        pendingVideoResumeTimer = window.setTimeout(function () {
            pendingVideoResumeTimer = null;
            if (isVideoGenerating || isResumingPendingJobs) {
                return;
            }
            var state = getState();
            var lease = getPendingJobsLease(state);
            if (isPendingJobsLeaseActive(lease) && !isPendingJobsLeaseOwnedByCurrentWindow(lease)) {
                return;
            }
            if (!hasActivePendingVideoJobs(state)) {
                return;
            }

            runPendingVideoJobs({
                stopOnError: false,
                isResume: true
            }).then(function (result) {
                if (result && result.hasErrors) {
                    setGenerationStatus("Recovered pending jobs with errors (" + result.done + "/" + result.total + " done, " + result.failed + " failed).", true);
                    setStatus("Pending jobs recovered with errors.", true);
                    return;
                }
                setGenerationStatus("Done.", false);
                setStatus("Recovered pending generation jobs.", false);
            }, function (error) {
                setGenerationStatus("Recovery failed: " + formatError(error), true);
                setStatus("Recovery failed: " + formatError(error), true);
            });
        }, waitMs);
    }

    function runImageGeneration(input, sampleIndex, sampleCount, batchId, jobId) {
        var referenceIds = [];
        var referencePaths = [];
        var refsSource = input.references || [];
        var refsIndex;
        var context = {
            apiKey: input.apiKey,
            prompt: input.prompt,
            modelId: input.modelId,
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
            batchId: batchId || null,
            sampleIndex: sampleIndex || null,
            sampleCount: sampleCount || null,
            referenceIds: referenceIds,
            referencePaths: referencePaths
        };

        for (refsIndex = 0; refsIndex < refsSource.length; refsIndex += 1) {
            referenceIds.push(refsSource[refsIndex] && refsSource[refsIndex].id ? refsSource[refsIndex].id : null);
            referencePaths.push(refsSource[refsIndex] && refsSource[refsIndex].path ? refsSource[refsIndex].path : "");
        }

        if (jobId) {
            patchPendingJob(jobId, {
                status: "uploading",
                error: null,
                progressPercent: 8,
                lastStage: "Uploading"
            });
        }

        return window.VeoApi.generateImage({
            apiKey: input.apiKey,
            prompt: input.prompt,
            modelId: input.modelId,
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
            sampleIndex: sampleIndex || 1,
            sampleCount: sampleCount || 1,
            referenceImages: input.references,
            imagesDir: input.imagesDir,
            onStatus: function (stage, details) {
                var info = details || {};
                var progressFromDetails = normalizeProgressPercent(info.progressPercent);
                var progressForPatch = progressFromDetails;
                if (progressForPatch === null) {
                    progressForPatch = stageToProgressPercent(stage);
                }
                if (jobId) {
                    patchPendingJob(jobId, {
                        status: mapVideoStageToJobStatus(stage),
                        progressPercent: progressForPatch,
                        lastStage: stage || null
                    });
                }
                setImageGenerationStatus(stage + "...", false);
                setStatus("Image: " + stage + "...", false);
            }
        }).then(function (result) {
            return readImageDimensions(result.path || result.downloadedPath).then(function (dimensions) {
                appendGeneratedImage(result, context, dimensions);
                if (jobId) {
                    removePendingJob(jobId);
                }
                setImageGenerationStatus("Done.", false);
                setStatus("Done: " + baseName(result.path || result.downloadedPath), false);
            }, function () {
                appendGeneratedImage(result, context, null);
                if (jobId) {
                    removePendingJob(jobId);
                }
                setImageGenerationStatus("Done.", false);
                setStatus("Done: " + baseName(result.path || result.downloadedPath), false);
            });
        }, function (error) {
            if (jobId) {
                patchPendingJob(jobId, {
                    status: "failed",
                    error: toCardErrorMessage(error),
                    progressPercent: 0,
                    lastStage: "Failed"
                });
            }
            throw error;
        });
    }

    function runQueuedImageBatch(request) {
        var input = request.input;
        var sampleCount = request.sampleCount;
        var batchId = request.batchId;
        var done = 0;
        var failed = 0;
        var jobs = [];
        var nextIndex = 0;
        var activeCount = 0;
        var completedCount = 0;
        var concurrency;

        jobs = getPendingImageJobsForExecution(request.jobIds || []);
        if (!jobs.length) {
            return Promise.resolve({
                done: 0,
                failed: 0,
                total: 0,
                hasErrors: false
            });
        }
        if (!isFinite(sampleCount) || sampleCount < 1) {
            sampleCount = jobs.length;
        }
        concurrency = Math.min(4, jobs.length);

        isImageGenerating = true;
        refreshBusyUi();

        function updateBatchStatus(stage, sampleIndex, isError) {
            var text = "Sample " + sampleIndex + "/" + sampleCount + ": " + stage + "... (" + done + "/" + sampleCount + " done";
            if (failed > 0) {
                text += ", " + failed + " failed";
            }
            text += ")";
            setImageGenerationStatus(text, !!isError);
        }

        return new Promise(function (resolve) {
            function finalize() {
                isImageGenerating = false;
                refreshBusyUi();
                if (failed > 0) {
                    setImageGenerationStatus("Completed with errors (" + done + "/" + sampleCount + " done, " + failed + " failed).", true);
                    setStatus("Image generation completed with errors.", true);
                } else {
                    setImageGenerationStatus("Done.", false);
                    setStatus("Image generation finished.", false);
                }
                resolve({
                    done: done,
                    failed: failed,
                    total: sampleCount,
                    hasErrors: failed > 0
                });
            }

            function maybeFinish() {
                if (completedCount >= sampleCount && activeCount === 0) {
                    finalize();
                }
            }

            function launchNext() {
                var currentJob;
                while (activeCount < concurrency && nextIndex < sampleCount) {
                    currentJob = jobs[nextIndex];
                    nextIndex += 1;
                    activeCount += 1;
                    updateBatchStatus("Uploading", currentJob.sampleIndex || nextIndex, false);

                    (function (jobRef) {
                        runImageGeneration(input, jobRef.sampleIndex || 1, sampleCount, batchId, jobRef.id).then(function () {
                            done += 1;
                            activeCount -= 1;
                            completedCount += 1;
                            launchNext();
                            maybeFinish();
                        }, function () {
                            failed += 1;
                            activeCount -= 1;
                            completedCount += 1;
                            updateBatchStatus("Failed", jobRef.sampleIndex || 1, true);
                            launchNext();
                            maybeFinish();
                        });
                    }(currentJob));
                }
            }

            launchNext();
            maybeFinish();
        });
    }

    function processPendingImageQueue() {
        if (isImageGenerating) {
            return;
        }
        if (!pendingImageQueue.length) {
            return;
        }

        runQueuedImageBatch(pendingImageQueue.shift()).then(function () {
            if (pendingImageQueue.length) {
                setImageGenerationStatus("Starting next queued image batch...", false);
                processPendingImageQueue();
            }
        });
    }

    function onGenerateClick() {
        var input;
        var apiMode;
        var jobs = [];
        var jobIds = [];

        if (activeGenerationType === GEN_TYPE_IMAGE) {
            onGenerateImageClick();
            return;
        }

        if (!window.VeoApi || typeof window.VeoApi.generateVideo !== "function") {
            setGenerationStatus("VeoApi.generateVideo is unavailable.", true);
            return;
        }

        try {
            input = getVideoGenerationInput();
        } catch (error) {
            setGenerationStatus(formatError(error), true);
            setStatus(formatError(error), true);
            return;
        }

        apiMode = resolveApiModeForInput(input);
        input.batchId = makeId("video_batch");

        Promise.resolve()
            .then(function () {
                if (apiMode === "text") {
                    return null;
                }
                if (videoCapabilities.checked) {
                    return null;
                }
                setGenerationStatus("Checking model capabilities...", false);
                return probeVideoCapabilities(false);
            })
            .then(function () {
                if (apiMode !== "text" && videoCapabilities.checked && !videoCapabilities.inlineData) {
                    setStatus("Warning: image input support is not confirmed for this key/project. Trying request anyway...", false);
                }
            })
            .then(function () {
                var i;
                jobs = enqueueVideoGenerationJobs(input);
                for (i = 0; i < jobs.length; i += 1) {
                    jobIds.push(jobs[i].id);
                }
                if (isVideoGenerating || isResumingPendingJobs) {
                    queueInjectedVideoJobIds(jobIds);
                    setGenerationStatus("Queued " + jobs.length + " sample(s). Starting in parallel...", false);
                    setStatus("Queued video batch (" + jobs.length + " sample(s)).", false);
                    return null;
                }
                return runPendingVideoJobs({
                    jobIds: jobIds,
                    stopOnError: false,
                    concurrency: input.sampleCount || 1,
                    isResume: false
                });
            })
            .then(function (result) {
                if (!result) {
                    return;
                }
                if (result && result.hasErrors) {
                    setGenerationStatus("Completed with errors (" + result.done + "/" + result.total + " done, " + result.failed + " failed).", true);
                    setStatus("Video generation completed with errors.", true);
                    return;
                }
                setGenerationStatus("Done.", false);
                setStatus("Video generation finished.", false);
            }, function (error) {
                setGenerationStatus("Generation failed: " + formatError(error), true);
                setStatus("Generation failed: " + formatError(error), true);
            });
    }

    function onGenerateImageClick() {
        var input;
        var sampleSelect = getById("imageSampleCountSelect");
        var sampleCount = parseSampleCount(sampleSelect ? sampleSelect.value : "1");
        var batchId = makeId("image_batch");
        var jobs = [];
        var jobIds = [];
        var i;

        if (!window.VeoApi || typeof window.VeoApi.generateImage !== "function") {
            setImageGenerationStatus("VeoApi.generateImage is unavailable.", true);
            return;
        }

        try {
            input = getImageGenerationInput();
        } catch (error) {
            setImageGenerationStatus(formatError(error), true);
            setStatus(formatError(error), true);
            return;
        }

        jobs = enqueueImageGenerationJobs(input, sampleCount, batchId);
        for (i = 0; i < jobs.length; i += 1) {
            jobIds.push(jobs[i].id);
        }

        pendingImageQueue.push({
            input: input,
            sampleCount: sampleCount,
            batchId: batchId,
            jobIds: jobIds
        });

        if (isImageGenerating) {
            setImageGenerationStatus("Queued image batch (" + sampleCount + " sample(s)).", false);
            setStatus("Queued image batch (" + sampleCount + " sample(s)).", false);
            return;
        }

        processPendingImageQueue();
    }

    function setStart() {
        var state = getState();
        if (!state.selectedShotId) {
            setStatus("Select a frame first.", true);
            return;
        }

        stateAdapterUpdate({ startShotId: state.selectedShotId });
        maybeAutoApplyVideoAspectRatioFromShotId(state.selectedShotId);
        setStatus("Start frame set.", false);
    }

    function setEnd() {
        var state = getState();
        if (!state.selectedShotId) {
            setStatus("Select a frame first.", true);
            return;
        }

        stateAdapterUpdate({ endShotId: state.selectedShotId });
        maybeAutoApplyVideoAspectRatioFromShotId(state.selectedShotId);
        setStatus("End frame set.", false);
    }

    function clearStart() {
        var state = getState();
        if (!state.startShotId) {
            setStatus("Start frame is already empty.", false);
            return;
        }

        stateAdapterUpdate({ startShotId: null });
        setStatus("Start frame cleared.", false);
    }

    function clearEnd() {
        var state = getState();
        if (!state.endShotId) {
            setStatus("End frame is already empty.", false);
            return;
        }

        stateAdapterUpdate({ endShotId: null });
        setStatus("End frame cleared.", false);
    }

    function swapStartEnd() {
        var state = getState();
        var startShotId = state.startShotId || null;
        var endShotId = state.endShotId || null;

        if (!startShotId && !endShotId) {
            setStatus("Start and End are empty. Set at least one frame first.", true);
            return;
        }

        stateAdapterUpdate({
            startShotId: endShotId,
            endShotId: startShotId
        });
        setStatus("Start and End swapped.", false);
    }

    function deleteSelectedShot(shotIdOverride) {
        var state = getState();
        var shots = state.shots || [];
        var selectedId = typeof shotIdOverride === "string" ? shotIdOverride : state.selectedShotId;
        var preferredSelectedId = state.selectedShotId;
        var nextShots = [];
        var nextSelected = null;
        var removed = false;
        var removedPath = "";
        var removedFiles = [];
        var moveResult = null;
        var nextImageRefs = [];
        var nextVideoRefs = [];
        var nextState;
        var i;

        if (!selectedId) {
            setStatus("Select a frame first.", true);
            return;
        }

        for (i = 0; i < shots.length; i += 1) {
            if (shots[i] && shots[i].id === selectedId) {
                removed = true;
                removedPath = shots[i].path || "";
                continue;
            }
            if (shots[i]) {
                nextShots.push(shots[i]);
            }
        }

        if (!removed) {
            setStatus("Selected frame was not found in current state.", true);
            return;
        }

        if (nextShots.length) {
            if (preferredSelectedId && preferredSelectedId !== selectedId && findShotById(nextShots, preferredSelectedId)) {
                nextSelected = preferredSelectedId;
            } else {
                nextSelected = nextShots[nextShots.length - 1].id;
            }
        }

        if (removedPath) {
            nextImageRefs = (state.refs || []).filter(function (refItem) {
                return normalizePathForCompare(refItem && refItem.path) !== normalizePathForCompare(removedPath);
            });
            nextVideoRefs = getVideoRefs(state).filter(function (refItem2) {
                return normalizePathForCompare(refItem2 && refItem2.path) !== normalizePathForCompare(removedPath);
            });
        } else {
            nextImageRefs = state.refs || [];
            nextVideoRefs = getVideoRefs(state);
        }

        nextState = {
            shots: nextShots,
            selectedShotId: nextSelected,
            startShotId: state.startShotId === selectedId ? null : state.startShotId,
            endShotId: state.endShotId === selectedId ? null : state.endShotId,
            refs: nextImageRefs,
            videoRefs: nextVideoRefs,
            videos: state.videos || [],
            images: state.images || [],
            pendingJobs: getPendingJobs(state)
        };

        if (removedPath && shouldDeletePathForNextState(removedPath, nextState)) {
            moveResult = moveFileToTrash(removedPath);
            if (moveResult && moveResult.ok && moveResult.moved) {
                removedFiles.push({
                    originalPath: moveResult.originalPath,
                    trashPath: moveResult.trashPath
                });
            }
        }

        pushUndoDeleteAction("Frame delete", buildUndoDeleteSnapshot(state), removedFiles);

        stateAdapterUpdate({
            shots: nextShots,
            selectedShotId: nextSelected,
            startShotId: state.startShotId === selectedId ? null : state.startShotId,
            endShotId: state.endShotId === selectedId ? null : state.endShotId,
            refs: nextImageRefs,
            videoRefs: nextVideoRefs
        });

        if (removedFiles.length > 0) {
            setStatus("Frame moved to VeoBridge trash.", false);
            return;
        }
        setStatus("Frame removed from gallery list.", false);
    }

    function revealPathInExplorer(targetPath) {
        var cmd;
        var args;

        if (!targetPath) {
            return false;
        }

        if (!childProcess || typeof process === "undefined") {
            return false;
        }
        if (process.platform !== "darwin" && process.platform !== "win32" && (!path || typeof path.dirname !== "function")) {
            return false;
        }

        if (process.platform === "darwin") {
            cmd = "open";
            args = ["-R", targetPath];
        } else if (process.platform === "win32") {
            cmd = "explorer.exe";
            args = ["/select," + targetPath];
        } else {
            cmd = "xdg-open";
            args = [path.dirname(targetPath)];
        }

        try {
            childProcess.spawn(cmd, args, {
                detached: true,
                stdio: "ignore"
            }).unref();
            return true;
        } catch (error) {
            return false;
        }
    }

    function revealSelectedShot(shotIdOverride) {
        var state = getState();
        var selectedId = typeof shotIdOverride === "string" ? shotIdOverride : state.selectedShotId;
        var shot = findShotById(state.shots || [], selectedId);

        if (!shot || !shot.path) {
            setStatus("Selected frame has no file path.", true);
            return;
        }
        if (!fileExists(shot.path)) {
            setStatus("Selected frame file is missing on disk.", true);
            return;
        }

        if (!revealPathInExplorer(shot.path)) {
            setStatus("Reveal is unavailable in this environment.", true);
            return;
        }

        setStatus("Revealed frame in file manager.", false);
    }

    function ensureHostPathsForImport(callback) {
        var done = typeof callback === "function" ? callback : function () {};
        if (hostPaths && hostPaths.bridgeDir) {
            done(null, hostPaths);
            return;
        }
        if (!window.VeoBridgeState || typeof window.VeoBridgeState.ensurePaths !== "function") {
            done(new Error("Path initialization is unavailable in this environment."));
            return;
        }
        window.VeoBridgeState.ensurePaths(function (error, pathsResult) {
            if (error) {
                done(error);
                return;
            }
            hostPaths = pathsResult || hostPaths;
            done(null, hostPaths);
        });
    }

    function resolveProjectMediaDir(mediaKind) {
        if (mediaKind === "video") {
            return resolveProjectVideosDir();
        }
        return resolveProjectImagesDir();
    }

    function buildUniquePathInDir(targetDir, sourcePath) {
        var fileName;
        var ext;
        var stem;
        var candidate;
        var suffix = 1;

        if (!targetDir || !sourcePath || !path) {
            return "";
        }

        fileName = path.basename(sourcePath);
        ext = path.extname(fileName);
        stem = path.basename(fileName, ext);
        candidate = path.join(targetDir, fileName);

        while (fileExists(candidate)) {
            candidate = path.join(targetDir, stem + "_" + String(suffix) + ext);
            suffix += 1;
            if (suffix > 5000) {
                return "";
            }
        }
        return candidate;
    }

    function remapPathInState(oldPath, nextPath) {
        var oldNorm = normalizePathForCompare(oldPath);
        var nextNorm = normalizePathForCompare(nextPath);
        var state;
        var shots;
        var refs;
        var videoRefs;
        var videos;
        var images;
        var pendingJobs;
        var changed = false;
        var i;
        var j;
        var item;
        var nextItem;
        var nextRefs;

        if (!oldNorm || !nextNorm || oldNorm === nextNorm) {
            return false;
        }

        state = getState();

        shots = (state.shots || []).slice(0);
        for (i = 0; i < shots.length; i += 1) {
            item = shots[i];
            if (!item || normalizePathForCompare(item.path) !== oldNorm) {
                continue;
            }
            nextItem = cloneJson(item, {});
            nextItem.path = nextPath;
            shots[i] = nextItem;
            changed = true;
        }

        refs = (state.refs || []).slice(0);
        for (i = 0; i < refs.length; i += 1) {
            item = refs[i];
            if (!item || normalizePathForCompare(item.path) !== oldNorm) {
                continue;
            }
            nextItem = cloneJson(item, {});
            nextItem.path = nextPath;
            refs[i] = nextItem;
            changed = true;
        }

        videoRefs = getVideoRefs(state).slice(0);
        for (i = 0; i < videoRefs.length; i += 1) {
            item = videoRefs[i];
            if (!item || normalizePathForCompare(item.path) !== oldNorm) {
                continue;
            }
            nextItem = cloneJson(item, {});
            nextItem.path = nextPath;
            videoRefs[i] = nextItem;
            changed = true;
        }

        videos = (state.videos || []).slice(0);
        for (i = 0; i < videos.length; i += 1) {
            item = videos[i];
            if (!item) {
                continue;
            }
            nextItem = null;
            if (normalizePathForCompare(item.path) === oldNorm) {
                nextItem = cloneJson(item, {});
                nextItem.path = nextPath;
            }
            if (normalizePathForCompare(item.startShotPath) === oldNorm) {
                nextItem = nextItem || cloneJson(item, {});
                nextItem.startShotPath = nextPath;
            }
            if (normalizePathForCompare(item.endShotPath) === oldNorm) {
                nextItem = nextItem || cloneJson(item, {});
                nextItem.endShotPath = nextPath;
            }
            if (item.refPaths && item.refPaths instanceof Array) {
                nextRefs = item.refPaths.slice(0);
                for (j = 0; j < nextRefs.length; j += 1) {
                    if (normalizePathForCompare(nextRefs[j]) === oldNorm) {
                        nextRefs[j] = nextPath;
                        nextItem = nextItem || cloneJson(item, {});
                    }
                }
                if (nextItem) {
                    nextItem.refPaths = nextRefs;
                }
            }
            if (nextItem) {
                videos[i] = nextItem;
                changed = true;
            }
        }

        images = (state.images || []).slice(0);
        for (i = 0; i < images.length; i += 1) {
            item = images[i];
            if (!item) {
                continue;
            }
            nextItem = null;
            if (normalizePathForCompare(item.path) === oldNorm) {
                nextItem = cloneJson(item, {});
                nextItem.path = nextPath;
            }
            if (item.refPaths && item.refPaths instanceof Array) {
                nextRefs = item.refPaths.slice(0);
                for (j = 0; j < nextRefs.length; j += 1) {
                    if (normalizePathForCompare(nextRefs[j]) === oldNorm) {
                        nextRefs[j] = nextPath;
                        nextItem = nextItem || cloneJson(item, {});
                    }
                }
                if (nextItem) {
                    nextItem.refPaths = nextRefs;
                }
            }
            if (nextItem) {
                images[i] = nextItem;
                changed = true;
            }
        }

        pendingJobs = getPendingJobs(state).slice(0);
        for (i = 0; i < pendingJobs.length; i += 1) {
            item = pendingJobs[i];
            if (!item) {
                continue;
            }
            nextItem = null;
            if (normalizePathForCompare(item.startShotPath) === oldNorm) {
                nextItem = cloneJson(item, {});
                nextItem.startShotPath = nextPath;
            }
            if (normalizePathForCompare(item.endShotPath) === oldNorm) {
                nextItem = nextItem || cloneJson(item, {});
                nextItem.endShotPath = nextPath;
            }
            if (normalizePathForCompare(item.downloadedPath) === oldNorm) {
                nextItem = nextItem || cloneJson(item, {});
                nextItem.downloadedPath = nextPath;
            }
            if (item.references && item.references instanceof Array) {
                nextRefs = item.references.slice(0);
                for (j = 0; j < nextRefs.length; j += 1) {
                    if (!nextRefs[j]) {
                        continue;
                    }
                    if (normalizePathForCompare(nextRefs[j].path) === oldNorm) {
                        nextRefs[j] = cloneJson(nextRefs[j], {});
                        nextRefs[j].path = nextPath;
                        nextItem = nextItem || cloneJson(item, {});
                    }
                }
                if (nextItem) {
                    nextItem.references = nextRefs;
                }
            }
            if (nextItem) {
                pendingJobs[i] = nextItem;
                changed = true;
            }
        }

        if (!changed) {
            return false;
        }

        stateAdapterUpdate({
            shots: shots,
            refs: refs,
            videoRefs: videoRefs,
            videos: videos,
            images: images,
            pendingJobs: pendingJobs
        });
        return true;
    }

    function moveMediaToProjectForImport(sourcePath, mediaKind) {
        var targetDir;
        var targetPath;

        if (!sourcePath || !fileExists(sourcePath)) {
            return {
                ok: false,
                error: "File is missing on disk."
            };
        }
        if (!hostPaths || !hostPaths.projectSaved || !hostPaths.projectBridgeDir) {
            return {
                ok: false,
                error: "Project is not saved. Save the AE project first."
            };
        }

        targetDir = resolveProjectMediaDir(mediaKind);
        if (!targetDir) {
            return {
                ok: false,
                error: "Cannot access VeoBridge project folder."
            };
        }
        if (isPathInsideDir(sourcePath, targetDir)) {
            return {
                ok: true,
                copied: false,
                path: sourcePath,
                originalPath: sourcePath
            };
        }

        targetPath = buildUniquePathInDir(targetDir, sourcePath);
        if (!targetPath) {
            return {
                ok: false,
                error: "Cannot create a unique target file name in project folder."
            };
        }
        if (!copyFileToPath(sourcePath, targetPath)) {
            return {
                ok: false,
                error: "Failed to copy media file into project folder."
            };
        }

        return {
            ok: true,
            copied: true,
            path: targetPath,
            originalPath: sourcePath
        };
    }

    function importSelectedVideo(videoIdOverride) {
        var state = getState();
        var selectedId = typeof videoIdOverride === "string" ? videoIdOverride : state.selectedVideoId;
        var video = findVideoById(state.videos || [], selectedId);
        var sourcePath;
        var prepared;
        var script;

        if (!video || !video.path) {
            setStatus("Select a generated video first.", true);
            return;
        }
        if (!fileExists(video.path)) {
            setStatus("Cannot import: video file is missing on disk.", true);
            return;
        }

        sourcePath = video.path;
        setStatus("Preparing video for import...", false);
        ensureHostPathsForImport(function (pathsError) {
            if (pathsError) {
                setStatus("Import failed: " + formatError(pathsError), true);
                return;
            }
            prepared = moveMediaToProjectForImport(sourcePath, "video");
            if (!prepared.ok) {
                setStatus("Import failed: " + prepared.error, true);
                return;
            }
            script = "VeoBridge_importVideo(" + toHostStringLiteral(prepared.path) + ")";
            setStatus("Importing video into AE...", false);

            callHost(script, function (error) {
                var videos;
                var nextVideos;
                var i;
                var item;
                if (error) {
                    setStatus("Import failed: " + formatError(error), true);
                    return;
                }
                videos = (getState().videos || []).slice(0);
                nextVideos = [];
                for (i = 0; i < videos.length; i += 1) {
                    item = videos[i];
                    if (item && item.id === selectedId) {
                        item = cloneJson(item, {});
                        item.importedToProject = true;
                        item.projectImportPath = prepared.path;
                        item.importedAt = (new Date()).toISOString();
                    }
                    nextVideos.push(item);
                }
                stateAdapterUpdate({ videos: nextVideos });
                setStatus("Done: Video imported. Project copy will remain in After Effects project folder.", false);
            });
        });
    }

    function importSelectedVideoToActiveComp(videoIdOverride) {
        var state = getState();
        var selectedId = typeof videoIdOverride === "string" ? videoIdOverride : state.selectedVideoId;
        var video = findVideoById(state.videos || [], selectedId);
        var sourcePath;
        var prepared;
        var script;

        if (!video || !video.path) {
            setStatus("Select a generated video first.", true);
            return;
        }
        if (!fileExists(video.path)) {
            setStatus("Cannot import: video file is missing on disk.", true);
            return;
        }

        sourcePath = video.path;
        setStatus("Preparing video for import...", false);
        ensureHostPathsForImport(function (pathsError) {
            if (pathsError) {
                setStatus("Import to active comp failed: " + formatError(pathsError), true);
                return;
            }
            prepared = moveMediaToProjectForImport(sourcePath, "video");
            if (!prepared.ok) {
                setStatus("Import to active comp failed: " + prepared.error, true);
                return;
            }
            script = "VeoBridge_importVideoToActiveComp(" + toHostStringLiteral(prepared.path) + ")";
            setStatus("Importing video to active composition...", false);

            callHost(script, function (error) {
                var videos;
                var nextVideos;
                var i;
                var item;
                if (error) {
                    setStatus("Import to active comp failed: " + formatError(error), true);
                    return;
                }
                videos = (getState().videos || []).slice(0);
                nextVideos = [];
                for (i = 0; i < videos.length; i += 1) {
                    item = videos[i];
                    if (item && item.id === selectedId) {
                        item = cloneJson(item, {});
                        item.importedToProject = true;
                        item.projectImportPath = prepared.path;
                        item.importedAt = (new Date()).toISOString();
                    }
                    nextVideos.push(item);
                }
                stateAdapterUpdate({ videos: nextVideos });
                setStatus("Done: Video added to active composition. Project copy will remain in After Effects project folder.", false);
            });
        });
    }

    function revealSelectedVideo(videoIdOverride) {
        var state = getState();
        var selectedId = typeof videoIdOverride === "string" ? videoIdOverride : state.selectedVideoId;
        var video = findVideoById(state.videos || [], selectedId);

        if (!video || !video.path) {
            setStatus("Select a generated video first.", true);
            return;
        }
        if (!fileExists(video.path)) {
            setStatus("Selected video file is missing on disk.", true);
            return;
        }

        if (!revealPathInExplorer(video.path)) {
            setStatus("Reveal is unavailable in this environment.", true);
            return;
        }

        setStatus("Revealed video in file manager.", false);
    }

    function deleteSelectedVideo(videoIdOverride) {
        var state = getState();
        var videos = state.videos || [];
        var selectedId = typeof videoIdOverride === "string" ? videoIdOverride : state.selectedVideoId;
        var preferredSelectedId = state.selectedVideoId;
        var i;
        var nextVideos = [];
        var nextSelected = null;
        var removedVideo = null;
        var removedFiles = [];
        var moveResult = null;
        var nextState;

        if (!selectedId) {
            setStatus("Select a generated video first.", true);
            return;
        }

        for (i = 0; i < videos.length; i += 1) {
            if (videos[i] && videos[i].id === selectedId) {
                removedVideo = videos[i];
                continue;
            }
            nextVideos.push(videos[i]);
        }

        if (!removedVideo) {
            setStatus("Selected video was not found in current state.", true);
            return;
        }

        if (removedVideo.importedToProject) {
            if (!window.confirm("Delete this media from VeoBridge Gallery?\n\nProject copy will remain in After Effects project folder.")) {
                setStatus("Delete canceled.", false);
                return;
            }
        }

        if (nextVideos.length) {
            if (preferredSelectedId && preferredSelectedId !== selectedId && findVideoById(nextVideos, preferredSelectedId)) {
                nextSelected = preferredSelectedId;
            } else {
                nextSelected = nextVideos[0].id;
            }
        }

        nextState = {
            shots: state.shots || [],
            selectedShotId: state.selectedShotId || null,
            startShotId: state.startShotId || null,
            endShotId: state.endShotId || null,
            refs: state.refs || [],
            videoRefs: getVideoRefs(state),
            videos: nextVideos,
            images: state.images || [],
            pendingJobs: getPendingJobs(state)
        };

        if (removedVideo.path && shouldDeletePathForNextState(removedVideo.path, nextState)) {
            moveResult = moveFileToTrash(removedVideo.path);
            if (moveResult && moveResult.ok && moveResult.moved) {
                removedFiles.push({
                    originalPath: moveResult.originalPath,
                    trashPath: moveResult.trashPath
                });
            }
        }

        pushUndoDeleteAction("Video delete", buildUndoDeleteSnapshot(state), removedFiles);

        stateAdapterUpdate({
            videos: nextVideos,
            selectedVideoId: nextSelected
        });

        if (removedFiles.length > 0) {
            setStatus("Video moved to VeoBridge trash.", false);
            return;
        }
        setStatus("Video removed from gallery list.", false);
    }

    function importSelectedImage(imageIdOverride) {
        var state = getState();
        var selectedId = typeof imageIdOverride === "string" ? imageIdOverride : state.selectedImageId;
        var image = findImageById(state.images || [], selectedId);
        var sourcePath;
        var prepared;
        var script;

        if (!image || !image.path) {
            setStatus("Select a generated image first.", true);
            return;
        }
        if (!fileExists(image.path)) {
            setStatus("Cannot import: image file is missing on disk.", true);
            return;
        }

        sourcePath = image.path;
        setStatus("Preparing image for import...", false);
        ensureHostPathsForImport(function (pathsError) {
            if (pathsError) {
                setStatus("Import failed: " + formatError(pathsError), true);
                return;
            }
            prepared = moveMediaToProjectForImport(sourcePath, "image");
            if (!prepared.ok) {
                setStatus("Import failed: " + prepared.error, true);
                return;
            }
            script = "VeoBridge_importImage(" + toHostStringLiteral(prepared.path) + ")";
            setStatus("Importing image into AE...", false);

            callHost(script, function (error) {
                var images;
                var nextImages;
                var i;
                var item;
                if (error) {
                    setStatus("Import failed: " + formatError(error), true);
                    return;
                }
                images = (getState().images || []).slice(0);
                nextImages = [];
                for (i = 0; i < images.length; i += 1) {
                    item = images[i];
                    if (item && item.id === selectedId) {
                        item = cloneJson(item, {});
                        item.importedToProject = true;
                        item.projectImportPath = prepared.path;
                        item.importedAt = (new Date()).toISOString();
                    }
                    nextImages.push(item);
                }
                stateAdapterUpdate({ images: nextImages });
                setStatus("Done: Image imported. Project copy will remain in After Effects project folder.", false);
            });
        });
    }

    function importSelectedImageToActiveComp(imageIdOverride) {
        var state = getState();
        var selectedId = typeof imageIdOverride === "string" ? imageIdOverride : state.selectedImageId;
        var image = findImageById(state.images || [], selectedId);
        var sourcePath;
        var prepared;
        var script;

        if (!image || !image.path) {
            setStatus("Select a generated image first.", true);
            return;
        }
        if (!fileExists(image.path)) {
            setStatus("Cannot import: image file is missing on disk.", true);
            return;
        }

        sourcePath = image.path;
        setStatus("Preparing image for import...", false);
        ensureHostPathsForImport(function (pathsError) {
            if (pathsError) {
                setStatus("Import to active comp failed: " + formatError(pathsError), true);
                return;
            }
            prepared = moveMediaToProjectForImport(sourcePath, "image");
            if (!prepared.ok) {
                setStatus("Import to active comp failed: " + prepared.error, true);
                return;
            }
            script = "VeoBridge_importImageToActiveComp(" + toHostStringLiteral(prepared.path) + ")";
            setStatus("Importing image to active composition...", false);

            callHost(script, function (error) {
                var images;
                var nextImages;
                var i;
                var item;
                if (error) {
                    setStatus("Import to active comp failed: " + formatError(error), true);
                    return;
                }
                images = (getState().images || []).slice(0);
                nextImages = [];
                for (i = 0; i < images.length; i += 1) {
                    item = images[i];
                    if (item && item.id === selectedId) {
                        item = cloneJson(item, {});
                        item.importedToProject = true;
                        item.projectImportPath = prepared.path;
                        item.importedAt = (new Date()).toISOString();
                    }
                    nextImages.push(item);
                }
                stateAdapterUpdate({ images: nextImages });
                setStatus("Done: Image added to active composition. Project copy will remain in After Effects project folder.", false);
            });
        });
    }

    function addSelectedImageToFrames(imageIdOverride) {
        var state = getState();
        var images = state.images || [];
        var shots = state.shots ? state.shots.slice(0) : [];
        var selectedId = typeof imageIdOverride === "string" ? imageIdOverride : state.selectedImageId;
        var image = findImageById(images, selectedId);

        if (!image || !image.path) {
            setStatus("Select a generated image first.", true);
            return;
        }
        if (!fileExists(image.path)) {
            setStatus("Selected image file is missing on disk.", true);
            return;
        }

        function appendWithSize(size) {
            var shot = {
                id: makeId("shot"),
                path: image.path,
                compName: "Generated Image",
                frame: null,
                createdAt: (new Date()).toISOString(),
                width: size && size.width ? size.width : (image.width || null),
                height: size && size.height ? size.height : (image.height || null)
            };

            shots.push(shot);
            stateAdapterUpdate({
                shots: shots,
                selectedShotId: shot.id
            });
            setStatus("Image added to Captured Frames.", false);
        }

        if (image.width && image.height) {
            appendWithSize({ width: image.width, height: image.height });
            return;
        }

        readImageDimensions(image.path).then(function (size) {
            appendWithSize(size);
        }, function () {
            appendWithSize(null);
        });
    }

    function revealSelectedImage(imageIdOverride) {
        var state = getState();
        var selectedId = typeof imageIdOverride === "string" ? imageIdOverride : state.selectedImageId;
        var image = findImageById(state.images || [], selectedId);

        if (!image || !image.path) {
            setStatus("Select a generated image first.", true);
            return;
        }
        if (!fileExists(image.path)) {
            setStatus("Selected image file is missing on disk.", true);
            return;
        }

        if (!revealPathInExplorer(image.path)) {
            setStatus("Reveal is unavailable in this environment.", true);
            return;
        }

        setStatus("Revealed image in file manager.", false);
    }

    function deleteSelectedImage(imageIdOverride) {
        var state = getState();
        var images = state.images || [];
        var selectedId = typeof imageIdOverride === "string" ? imageIdOverride : state.selectedImageId;
        var i;
        var nextImages = [];
        var nextSelected = null;
        var removedImage = null;
        var preferredSelectedId = state.selectedImageId;
        var removedFiles = [];
        var moveResult = null;
        var nextState;

        if (!selectedId) {
            setStatus("Select a generated image first.", true);
            return;
        }

        for (i = 0; i < images.length; i += 1) {
            if (images[i] && images[i].id === selectedId) {
                removedImage = images[i];
                continue;
            }
            nextImages.push(images[i]);
        }

        if (!removedImage) {
            setStatus("Selected image was not found in current state.", true);
            return;
        }

        if (removedImage.importedToProject) {
            if (!window.confirm("Delete this media from VeoBridge Gallery?\n\nProject copy will remain in After Effects project folder.")) {
                setStatus("Delete canceled.", false);
                return;
            }
        }

        if (nextImages.length) {
            if (preferredSelectedId && preferredSelectedId !== selectedId && findImageById(nextImages, preferredSelectedId)) {
                nextSelected = preferredSelectedId;
            } else {
                nextSelected = nextImages[0].id;
            }
        }

        nextState = {
            shots: state.shots || [],
            selectedShotId: state.selectedShotId || null,
            startShotId: state.startShotId || null,
            endShotId: state.endShotId || null,
            refs: state.refs || [],
            videoRefs: getVideoRefs(state),
            videos: state.videos || [],
            images: nextImages,
            pendingJobs: getPendingJobs(state)
        };

        if (removedImage.path && shouldDeletePathForNextState(removedImage.path, nextState)) {
            moveResult = moveFileToTrash(removedImage.path);
            if (moveResult && moveResult.ok && moveResult.moved) {
                removedFiles.push({
                    originalPath: moveResult.originalPath,
                    trashPath: moveResult.trashPath
                });
            }
        }

        pushUndoDeleteAction("Image delete", buildUndoDeleteSnapshot(state), removedFiles);

        stateAdapterUpdate({
            images: nextImages,
            selectedImageId: nextSelected
        });

        if (removedFiles.length > 0) {
            setStatus("Image moved to VeoBridge trash.", false);
            return;
        }
        setStatus("Image removed from gallery list.", false);
    }

    function removeReferenceById(refId) {
        var state = getState();
        var refs = state.refs || [];
        var next = [];
        var i;
        var removed = false;

        if (!refId) {
            return;
        }

        for (i = 0; i < refs.length; i += 1) {
            if (refs[i] && refs[i].id === refId) {
                removed = true;
                continue;
            }
            next.push(refs[i]);
        }

        if (!removed) {
            return;
        }

        stateAdapterUpdate({ refs: next });
        setStatus("Reference image removed.", false);
    }

    function removeVideoReferenceById(refId) {
        var state = getState();
        var refs = getVideoRefs(state);
        var next = [];
        var i;
        var removed = false;

        if (!refId) {
            return;
        }

        for (i = 0; i < refs.length; i += 1) {
            if (refs[i] && refs[i].id === refId) {
                removed = true;
                continue;
            }
            next.push(refs[i]);
        }

        if (!removed) {
            return;
        }

        stateAdapterUpdate({ videoRefs: next });
        setStatus("Video reference removed.", false);
    }

    function hasReferenceForPath(refs, candidatePath) {
        var target = normalizePathForCompare(candidatePath);
        var i;
        for (i = 0; i < refs.length; i += 1) {
            if (normalizePathForCompare(refs[i] && refs[i].path) === target) {
                return true;
            }
        }
        return false;
    }

    function createReferenceEntry(filePath, displayName) {
        return {
            id: makeId("ref"),
            path: filePath,
            name: displayName || baseName(filePath),
            mimeType: guessImageMimeType(filePath),
            createdAt: (new Date()).toISOString()
        };
    }

    function appendReferenceEntry(refs, filePath, displayName) {
        refs.push(createReferenceEntry(filePath, displayName));
    }

    function insertReferenceEntryAt(refs, slotIndex, filePath, displayName, limit) {
        var next = refs ? refs.slice(0) : [];
        var normalizedPath = normalizePathForCompare(filePath);
        var i;
        var targetIndex = parseInt(slotIndex, 10);
        var entry = createReferenceEntry(filePath, displayName);

        if (!isFinite(targetIndex) || targetIndex < 0) {
            targetIndex = next.length;
        }

        for (i = next.length - 1; i >= 0; i -= 1) {
            if (normalizePathForCompare(next[i] && next[i].path) === normalizedPath) {
                next.splice(i, 1);
            }
        }

        if (targetIndex > next.length) {
            targetIndex = next.length;
        }
        if (targetIndex < 0) {
            targetIndex = 0;
        }

        if (next.length >= limit) {
            if (targetIndex >= next.length) {
                targetIndex = next.length - 1;
            }
            next.splice(targetIndex, 1);
        }

        next.splice(targetIndex, 0, entry);
        if (next.length > limit) {
            next = next.slice(0, limit);
        }
        return next;
    }

    function addShotToRefsById(shotId, slotIndex) {
        var state = getState();
        var shots = state.shots || [];
        var refs = state.refs ? state.refs.slice(0) : [];
        var shot = findShotById(shots, shotId);
        var hasSlotIndex = isFinite(parseInt(slotIndex, 10));

        if (!shot || !shot.path) {
            setStatus("Selected frame has no file path.", true);
            return;
        }
        if (!isSupportedImagePath(shot.path)) {
            setStatus("Frame file is not a supported image format (PNG/JPG/WEBP).", true);
            return;
        }
        if (!fileExists(shot.path)) {
            setStatus("Frame file is missing on disk: " + shot.path, true);
            return;
        }
        if (!hasSlotIndex && hasReferenceForPath(refs, shot.path)) {
            setStatus("This frame is already in Reference Images.", false);
            return;
        }
        if (!hasSlotIndex && refs.length >= UI_MAX_REFERENCE_IMAGES) {
            setStatus("Reference limit reached (" + UI_MAX_REFERENCE_IMAGES + ").", true);
            return;
        }
        if (hasSlotIndex) {
            refs = insertReferenceEntryAt(
                refs,
                slotIndex,
                shot.path,
                (shot.compName || baseName(shot.path) || "Frame") + " | frame " + (shot.frame != null ? shot.frame : "-"),
                UI_MAX_REFERENCE_IMAGES
            );
        } else {
            appendReferenceEntry(
                refs,
                shot.path,
                (shot.compName || baseName(shot.path) || "Frame") + " | frame " + (shot.frame != null ? shot.frame : "-")
            );
        }
        stateAdapterUpdate({ refs: refs });
        setStatus(hasSlotIndex ? "Reference slot updated." : "Frame added to Reference Images.", false);
    }

    function addShotToVideoRefsById(shotId, slotIndex) {
        var state = getState();
        var shots = state.shots || [];
        var refs = getVideoRefs(state).slice(0);
        var shot = findShotById(shots, shotId);
        var hasSlotIndex = isFinite(parseInt(slotIndex, 10));

        if (!shot || !shot.path) {
            setStatus("Selected frame has no file path.", true);
            return;
        }
        if (!isSupportedImagePath(shot.path)) {
            setStatus("Frame file is not a supported image format (PNG/JPG/WEBP).", true);
            return;
        }
        if (!fileExists(shot.path)) {
            setStatus("Frame file is missing on disk: " + shot.path, true);
            return;
        }
        if (!hasSlotIndex && hasReferenceForPath(refs, shot.path)) {
            setStatus("This frame is already in Video References.", false);
            return;
        }
        if (!hasSlotIndex && refs.length >= UI_MAX_VIDEO_REFERENCE_IMAGES) {
            setStatus("Video reference limit reached (" + UI_MAX_VIDEO_REFERENCE_IMAGES + ").", true);
            return;
        }
        if (hasSlotIndex) {
            refs = insertReferenceEntryAt(
                refs,
                slotIndex,
                shot.path,
                (shot.compName || baseName(shot.path) || "Frame") + " | frame " + (shot.frame != null ? shot.frame : "-"),
                UI_MAX_VIDEO_REFERENCE_IMAGES
            );
        } else {
            appendReferenceEntry(
                refs,
                shot.path,
                (shot.compName || baseName(shot.path) || "Frame") + " | frame " + (shot.frame != null ? shot.frame : "-")
            );
        }
        stateAdapterUpdate({ videoRefs: refs });
        setStatus(hasSlotIndex ? "Video reference slot updated." : "Frame added to Video References.", false);
    }

    function addSelectedShotToRefs() {
        var state = getState();
        if (!state.selectedShotId) {
            setStatus("Select a frame first.", true);
            return;
        }
        addShotToRefsById(state.selectedShotId);
    }

    function addSelectedShotToVideoRefs() {
        var state = getState();
        if (!state.selectedShotId) {
            setStatus("Select a frame first.", true);
            return;
        }
        addShotToVideoRefsById(state.selectedShotId);
    }

    function getDraggedShotId(event) {
        var dt = event && event.dataTransfer;
        var shotId = "";
        if (!dt) {
            return "";
        }
        try {
            shotId = dt.getData("application/x-veobridge-shot-id") || dt.getData("text/plain") || "";
        } catch (error) {
            shotId = "";
        }
        return trimText(shotId);
    }

    function addReferenceFiles(fileList) {
        var state = getState();
        var refs = state.refs ? state.refs.slice(0) : [];
        var availableSlots = UI_MAX_REFERENCE_IMAGES - refs.length;
        var added = 0;
        var i;
        var fileObj;
        var rawPath;

        if (!fileList || !fileList.length) {
            setStatus("No reference images selected.", true);
            return;
        }

        if (availableSlots <= 0) {
            setStatus("Reference limit reached (" + UI_MAX_REFERENCE_IMAGES + ").", true);
            return;
        }

        for (i = 0; i < fileList.length && added < availableSlots; i += 1) {
            fileObj = fileList[i];
            rawPath = fileObj && fileObj.path ? String(fileObj.path) : "";

            if (!rawPath) {
                continue;
            }
            if (!isSupportedImagePath(rawPath)) {
                continue;
            }
            if (!fileExists(rawPath)) {
                continue;
            }
            if (hasReferenceForPath(refs, rawPath)) {
                continue;
            }

            appendReferenceEntry(refs, rawPath, fileObj.name || baseName(rawPath));
            added += 1;
        }

        if (!added) {
            setStatus("No valid reference images were added (PNG/JPG/WEBP only).", true);
            return;
        }

        stateAdapterUpdate({ refs: refs });
        setStatus("Added " + added + " reference image(s).", false);
    }

    function clearReferences() {
        stateAdapterUpdate({ refs: [] });
        setStatus("Reference images cleared.", false);
    }

    function clearVideoReferences() {
        stateAdapterUpdate({ videoRefs: [] });
        setStatus("Video reference images cleared.", false);
    }

    function setRefsDropActive(isActive) {
        var refsList = getById("refsList");
        if (!refsList) {
            return;
        }
        if (refsList.classList) {
            if (isActive) {
                refsList.classList.add("is-drop-target");
            } else {
                refsList.classList.remove("is-drop-target");
            }
            return;
        }
        if (isActive) {
            if (refsList.className.indexOf("is-drop-target") < 0) {
                refsList.className += " is-drop-target";
            }
        } else {
            refsList.className = refsList.className.replace(/\s*is-drop-target/g, "");
        }
    }

    function bindRefsDropZone() {
        var refsList = getById("refsList");
        var dragDepth = 0;

        if (!refsList) {
            return;
        }

        refsList.addEventListener("dragenter", function (event) {
            var shotId = getDraggedShotId(event);
            if (!shotId) {
                return;
            }
            dragDepth += 1;
            setRefsDropActive(true);
            if (event.preventDefault) {
                event.preventDefault();
            }
        });

        refsList.addEventListener("dragover", function (event) {
            var shotId = getDraggedShotId(event);
            if (!shotId) {
                return;
            }
            if (event.preventDefault) {
                event.preventDefault();
            }
            try {
                event.dataTransfer.dropEffect = "copy";
            } catch (error) {
                // ignore
            }
            setRefsDropActive(true);
        });

        refsList.addEventListener("dragleave", function () {
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) {
                setRefsDropActive(false);
            }
        });

        refsList.addEventListener("drop", function (event) {
            var shotId = getDraggedShotId(event);
            dragDepth = 0;
            setRefsDropActive(false);
            if (!shotId) {
                return;
            }
            if (event.preventDefault) {
                event.preventDefault();
            }
            addShotToRefsById(shotId);
        });
    }

    function setVideoRefsDropActive(isActive) {
        var refsList = getById("videoRefsList");
        if (!refsList) {
            return;
        }
        if (refsList.classList) {
            if (isActive) {
                refsList.classList.add("is-drop-target");
            } else {
                refsList.classList.remove("is-drop-target");
            }
            return;
        }
        if (isActive) {
            if (refsList.className.indexOf("is-drop-target") < 0) {
                refsList.className += " is-drop-target";
            }
        } else {
            refsList.className = refsList.className.replace(/\s*is-drop-target/g, "");
        }
    }

    function bindVideoRefsDropZone() {
        var refsList = getById("videoRefsList");
        var dragDepth = 0;

        if (!refsList) {
            return;
        }

        refsList.addEventListener("dragenter", function (event) {
            var shotId = getDraggedShotId(event);
            if (!shotId) {
                return;
            }
            dragDepth += 1;
            setVideoRefsDropActive(true);
            if (event.preventDefault) {
                event.preventDefault();
            }
        });

        refsList.addEventListener("dragover", function (event) {
            var shotId = getDraggedShotId(event);
            if (!shotId) {
                return;
            }
            if (event.preventDefault) {
                event.preventDefault();
            }
            try {
                event.dataTransfer.dropEffect = "copy";
            } catch (error) {
                // ignore
            }
            setVideoRefsDropActive(true);
        });

        refsList.addEventListener("dragleave", function () {
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) {
                setVideoRefsDropActive(false);
            }
        });

        refsList.addEventListener("drop", function (event) {
            var shotId = getDraggedShotId(event);
            dragDepth = 0;
            setVideoRefsDropActive(false);
            if (!shotId) {
                return;
            }
            if (event.preventDefault) {
                event.preventDefault();
            }
            addShotToVideoRefsById(shotId);
        });
    }

    function setPanelResizeMode(enabled) {
        if (!document || !document.body) {
            return;
        }
        if (enabled) {
            if (document.body.classList) {
                document.body.classList.add("is-resizing-panels");
            } else if (document.body.className.indexOf("is-resizing-panels") < 0) {
                document.body.className += " is-resizing-panels";
            }
        } else if (document.body.classList) {
            document.body.classList.remove("is-resizing-panels");
        } else {
            document.body.className = document.body.className.replace(/\s*is-resizing-panels/g, "");
        }
    }

    function bindSplitterDrag(splitterId, onMove) {
        var splitter = getById(splitterId);

        if (!splitter || typeof onMove !== "function") {
            return;
        }

        splitter.addEventListener("mousedown", function (event) {
            var densityRafId = 0;

            function scheduleDensityUpdate() {
                if (densityRafId) {
                    return;
                }
                if (typeof window.requestAnimationFrame === "function") {
                    densityRafId = window.requestAnimationFrame(function () {
                        densityRafId = 0;
                        updateCarouselDensity();
                    });
                } else {
                    updateCarouselDensity();
                }
            }

            function handleMove(moveEvent) {
                onMove(moveEvent || event);
                applyVideoLayout();
                applyImageLayout();
                 scheduleDensityUpdate();
                saveLayoutsDebounced();
                if (moveEvent && moveEvent.preventDefault) {
                    moveEvent.preventDefault();
                }
            }

            function handleUp() {
                if (window.removeEventListener) {
                    window.removeEventListener("mousemove", handleMove);
                    window.removeEventListener("mouseup", handleUp);
                }
                if (densityRafId && typeof window.cancelAnimationFrame === "function") {
                    window.cancelAnimationFrame(densityRafId);
                    densityRafId = 0;
                }
                splitter.className = splitter.className.replace(/\s*is-active/g, "");
                setPanelResizeMode(false);
                updateCarouselDensity();
            }

            if (event.preventDefault) {
                event.preventDefault();
            }

            if (splitter.className.indexOf("is-active") < 0) {
                splitter.className += " is-active";
            }
            setPanelResizeMode(true);

            if (window.addEventListener) {
                window.addEventListener("mousemove", handleMove);
                window.addEventListener("mouseup", handleUp);
            }
        });
    }

    function bindLayoutSplitters() {
        bindSplitterDrag("splitVideoColumns", function (event) {
            var panel = getById("panelVideo");
            var rect;
            var ratio;
            if (!panel || !event) {
                return;
            }
            rect = panel.getBoundingClientRect();
            if (!rect || rect.width <= 20) {
                return;
            }
            ratio = (event.clientX - rect.left) / rect.width;
            videoLayout.colRatio = clampNumber(ratio, 0.32, 0.76, videoLayout.colRatio);
        });

        bindSplitterDrag("splitVideoLeft", function (event) {
            var stack = getById("videoLeftStack");
            var rect;
            var availableHeight;
            var ratio;
            if (!stack || !event) {
                return;
            }
            rect = stack.getBoundingClientRect();
            availableHeight = rect.height - 8;
            if (!rect || availableHeight <= 20) {
                return;
            }
            ratio = (event.clientY - rect.top) / availableHeight;
            videoLayout.leftTopRatio = clampNumber(ratio, 0.24, 0.72, videoLayout.leftTopRatio);
        });

        bindSplitterDrag("splitVideoRight", function (event) {
            var stack = getById("videoRightStack");
            var rect;
            var availableHeight;
            var ratio;
            if (!stack || !event) {
                return;
            }
            rect = stack.getBoundingClientRect();
            availableHeight = rect.height - 8;
            if (!rect || availableHeight <= 20) {
                return;
            }
            ratio = (event.clientY - rect.top) / availableHeight;
            videoLayout.rightTopRatio = clampNumber(ratio, 0.12, 0.86, videoLayout.rightTopRatio);
        });

        bindSplitterDrag("splitImageColumns", function (event) {
            var panel = getById("panelImage");
            var rect;
            var ratio;
            if (!panel || !event) {
                return;
            }
            rect = panel.getBoundingClientRect();
            if (!rect || rect.width <= 20) {
                return;
            }
            ratio = (event.clientX - rect.left) / rect.width;
            imageLayout.colRatio = clampNumber(ratio, 0.32, 0.76, imageLayout.colRatio);
        });

        bindSplitterDrag("splitImageLeftTop", function (event) {
            var stack = getById("imageLeftStack");
            var rect;
            var availableHeight;
            var nextTop;
            if (!stack || !event) {
                return;
            }
            rect = stack.getBoundingClientRect();
            availableHeight = rect.height - 16;
            if (!rect || availableHeight <= 30) {
                return;
            }
            nextTop = (event.clientY - rect.top) / availableHeight;
            imageLayout.leftTopRatio = clampNumber(nextTop, 0.18, 0.65, imageLayout.leftTopRatio);

            if (imageLayout.leftTopRatio + imageLayout.leftMidRatio > 0.82) {
                imageLayout.leftMidRatio = 0.82 - imageLayout.leftTopRatio;
            }
            imageLayout.leftMidRatio = clampNumber(imageLayout.leftMidRatio, 0.14, 0.62, 0.28);
        });

        bindSplitterDrag("splitImageLeftBottom", function (event) {
            var stack = getById("imageLeftStack");
            var rect;
            var availableHeight;
            var cumulativeRatio;
            var minCumulative;
            var maxCumulative;
            if (!stack || !event) {
                return;
            }
            rect = stack.getBoundingClientRect();
            availableHeight = rect.height - 16;
            if (!rect || availableHeight <= 30) {
                return;
            }
            cumulativeRatio = (event.clientY - rect.top) / availableHeight;
            minCumulative = imageLayout.leftTopRatio + 0.14;
            maxCumulative = 0.82;
            cumulativeRatio = clampNumber(cumulativeRatio, minCumulative, maxCumulative, minCumulative);

            imageLayout.leftMidRatio = clampNumber(cumulativeRatio - imageLayout.leftTopRatio, 0.14, 0.62, imageLayout.leftMidRatio);
            if (imageLayout.leftTopRatio + imageLayout.leftMidRatio > 0.82) {
                imageLayout.leftMidRatio = 0.82 - imageLayout.leftTopRatio;
            }
        });

        bindSplitterDrag("splitImageRight", function (event) {
            var stack = getById("imageRightStack");
            var rect;
            var availableHeight;
            var ratio;
            if (!stack || !event) {
                return;
            }
            rect = stack.getBoundingClientRect();
            availableHeight = rect.height - 8;
            if (!rect || availableHeight <= 20) {
                return;
            }
            ratio = (event.clientY - rect.top) / availableHeight;
            imageLayout.rightTopRatio = clampNumber(ratio, 0.35, 0.86, imageLayout.rightTopRatio);
        });
    }

    function closeWindow() {
        var bridge;

        saveWindowSizeNow();

        try {
            bridge = ensureCs();
            if (bridge && typeof bridge.closeExtension === "function") {
                bridge.closeExtension();
                return;
            }
        } catch (error) {
            // fallback below
        }
        window.close();
    }

    function setActiveTab(tabName) {
        var nextTab = tabName === "image" ? "image" : "video";
        var panelVideo = getById("panelVideo");
        var panelImage = getById("panelImage");
        var btnVideo = getById("btnTabVideo");
        var btnImage = getById("btnTabImage");

        activeTab = nextTab;
        closeShotPicker();
        closeMediaPreview();
        closeFlowOptions();

        if (panelVideo) {
            panelVideo.hidden = nextTab !== "video";
            panelVideo.style.display = nextTab === "video" ? "block" : "none";
        }
        if (panelImage) {
            panelImage.hidden = nextTab !== "image";
            panelImage.style.display = nextTab === "image" ? "block" : "none";
        }

        if (btnVideo) {
            btnVideo.className = "tab-btn" + (nextTab === "video" ? " is-active" : "");
            btnVideo.setAttribute("aria-selected", nextTab === "video" ? "true" : "false");
        }
        if (btnImage) {
            btnImage.className = "tab-btn" + (nextTab === "image" ? " is-active" : "");
            btnImage.setAttribute("aria-selected", nextTab === "image" ? "true" : "false");
        }

        try {
            window.localStorage.setItem(STORAGE_KEY_GALLERY_TAB, nextTab);
        } catch (error) {
            // ignore
        }

        if (typeof window.setTimeout === "function") {
            window.setTimeout(function () {
                updateCarouselDensity();
            }, 0);
        }
    }

    function selectAdjacentShot(direction) {
        var state = getState();
        var shots = state.shots || [];
        var i;
        var currentIndex = -1;
        var nextIndex;

        if (!shots.length) {
            return;
        }

        for (i = 0; i < shots.length; i += 1) {
            if (shots[i] && shots[i].id === state.selectedShotId) {
                currentIndex = i;
                break;
            }
        }

        if (currentIndex < 0) {
            currentIndex = shots.length - 1;
        }

        nextIndex = currentIndex + (direction < 0 ? -1 : 1);
        if (nextIndex < 0) {
            nextIndex = 0;
        }
        if (nextIndex >= shots.length) {
            nextIndex = shots.length - 1;
        }

        if (shots[nextIndex] && shots[nextIndex].id !== state.selectedShotId) {
            stateAdapterUpdate({ selectedShotId: shots[nextIndex].id });
        }
    }

    function selectAdjacentVideo(direction) {
        var state = getState();
        var videos = state.videos || [];
        var i;
        var currentIndex = -1;
        var nextIndex;

        if (!videos.length) {
            return;
        }

        for (i = 0; i < videos.length; i += 1) {
            if (videos[i] && videos[i].id === state.selectedVideoId) {
                currentIndex = i;
                break;
            }
        }

        if (currentIndex < 0) {
            currentIndex = 0;
        }

        nextIndex = currentIndex + (direction < 0 ? -1 : 1);
        if (nextIndex < 0) {
            nextIndex = 0;
        }
        if (nextIndex >= videos.length) {
            nextIndex = videos.length - 1;
        }

        if (videos[nextIndex] && videos[nextIndex].id !== state.selectedVideoId) {
            stateAdapterUpdate({ selectedVideoId: videos[nextIndex].id });
        }
    }

    function selectAdjacentImage(direction) {
        var state = getState();
        var images = state.images || [];
        var i;
        var currentIndex = -1;
        var nextIndex;

        if (!images.length) {
            return;
        }

        for (i = 0; i < images.length; i += 1) {
            if (images[i] && images[i].id === state.selectedImageId) {
                currentIndex = i;
                break;
            }
        }

        if (currentIndex < 0) {
            currentIndex = 0;
        }

        nextIndex = currentIndex + (direction < 0 ? -1 : 1);
        if (nextIndex < 0) {
            nextIndex = 0;
        }
        if (nextIndex >= images.length) {
            nextIndex = images.length - 1;
        }

        if (images[nextIndex] && images[nextIndex].id !== state.selectedImageId) {
            stateAdapterUpdate({ selectedImageId: images[nextIndex].id });
        }
    }

    function bindHorizontalWheel(listElement) {
        if (!listElement) {
            return;
        }
        if (
            listElement.className &&
            (
                String(listElement.className).indexOf("items-grid-scroll") >= 0 ||
                String(listElement.className).indexOf("flow-picker-grid") >= 0
            )
        ) {
            return;
        }
        listElement.addEventListener("wheel", function (event) {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                listElement.scrollLeft += event.deltaY;
                if (event.preventDefault) {
                    event.preventDefault();
                }
            }
        });
    }

    function bindArrowKeys(listElement, handler) {
        if (!listElement) {
            return;
        }
        listElement.addEventListener("keydown", function (event) {
            var key = event.key || event.keyCode;
            if (key === "ArrowLeft" || key === 37) {
                handler(-1);
            } else if (key === "ArrowRight" || key === 39) {
                handler(1);
            }
        });
    }

    function bindCarouselBehavior() {
        var shotsList = getById("shotsList");
        var videoRefsList = getById("videoRefsList");
        var imageShotsList = getById("imageShotsList");
        var videosList = getById("videosList");
        var imagesList = getById("imagesList");
        var refsList = getById("refsList");

        bindHorizontalWheel(shotsList);
        bindHorizontalWheel(videoRefsList);
        bindHorizontalWheel(imageShotsList);
        bindHorizontalWheel(videosList);
        bindHorizontalWheel(imagesList);
        bindHorizontalWheel(refsList);
        bindArrowKeys(shotsList, selectAdjacentShot);
        bindArrowKeys(imageShotsList, selectAdjacentShot);
        bindArrowKeys(videosList, selectAdjacentVideo);
        bindArrowKeys(imagesList, selectAdjacentImage);
    }

    function loadGenerationPrefs() {
        var promptInput = getById("promptInput");
        var modelSelect = getById("modelSelect");
        var aspectRatioSelect = getById("aspectRatioSelect");
        var imagePromptInput = getById("imagePromptInput");
        var savedPrompt = "";
        var savedModel = "";
        var savedAspectRatio = "";
        var savedMode = "";
        var savedGenType = GEN_TYPE_VIDEO;
        var savedImagePrompt = "";
        var shared = null;
        var state = getState();
        var currentVideoSettings = getVideoGenSettings(state);

        try {
            savedPrompt = window.localStorage.getItem(STORAGE_KEY_PROMPT) || "";
            savedModel = window.localStorage.getItem(STORAGE_KEY_MODEL) || "";
            savedAspectRatio = window.localStorage.getItem(STORAGE_KEY_ASPECT_RATIO) || "";
            savedMode = window.localStorage.getItem(STORAGE_KEY_VIDEO_MODE) || "";
            savedGenType = window.localStorage.getItem(STORAGE_KEY_GEN_TYPE) || GEN_TYPE_VIDEO;
            savedImagePrompt = window.localStorage.getItem(STORAGE_KEY_IMAGE_PROMPT) || "";
            activeTab = window.localStorage.getItem(STORAGE_KEY_GALLERY_TAB) || "video";
        } catch (error) {
            savedPrompt = "";
            savedModel = "";
            savedAspectRatio = "";
            savedMode = "";
            savedGenType = GEN_TYPE_VIDEO;
            savedImagePrompt = "";
            activeTab = "video";
        }

        if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.loadSettings === "function") {
            try {
                shared = window.VeoBridgeSettings.loadSettings();
                if (shared && shared.modelId) {
                    savedModel = String(shared.modelId);
                }
                if (shared && shared.aspectRatio) {
                    savedAspectRatio = String(shared.aspectRatio);
                }
            } catch (settingsError) {
                // ignore
            }
        }

        if (promptInput) {
            promptInput.value = savedPrompt || savedImagePrompt || "";
        }
        if (modelSelect) {
            modelSelect.value = savedModel || currentVideoSettings.model || (window.VeoApi ? window.VeoApi.DEFAULT_MODEL_ID : "veo-3.1-generate-preview");
            if (!modelSelect.value && window.VeoApi) {
                modelSelect.value = window.VeoApi.DEFAULT_MODEL_ID;
            }
            if (!modelSelect.value) {
                modelSelect.value = "veo-3.1-generate-preview";
            }
        }
        if (aspectRatioSelect) {
            aspectRatioSelect.value = normalizeAspectRatio(savedAspectRatio || currentVideoSettings.aspectRatio || "16:9");
        }
        if (imagePromptInput) {
            imagePromptInput.value = savedImagePrompt || savedPrompt || "";
        }
        activeGenerationType = normalizeGenerationType(savedGenType);

        stateAdapterUpdate({
            videoGenSettings: {
                mode: normalizeVideoMode(savedMode || currentVideoSettings.mode || VIDEO_MODE_FRAMES),
                model: trimText(modelSelect ? modelSelect.value : currentVideoSettings.model) || "veo-3.1-generate-preview",
                aspectRatio: normalizeAspectRatio(aspectRatioSelect ? aspectRatioSelect.value : currentVideoSettings.aspectRatio),
                durationSeconds: 8,
                resolution: "720p"
            }
        });

        if (state && (!state.imageGenSettings || !state.imageGenSettings.model)) {
            stateAdapterUpdate({
                imageGenSettings: {
                    model: window.VeoApi ? window.VeoApi.DEFAULT_IMAGE_MODEL_ID : "gemini-3.1-flash-image-preview",
                    aspectRatio: "1:1",
                    imageSize: "1K"
                }
            });
        }

        setActiveTab("video");
    }

    function persistImageGenSettings() {
        var state = getState();
        var current = state.imageGenSettings || {};
        var modelSelect = getById("imageModelSelect");
        var aspectSelect = getById("imageAspectRatioSelect");
        var sizeSelect = getById("imageSizeSelect");

        stateAdapterUpdate({
            imageGenSettings: {
                model: trimText(modelSelect ? modelSelect.value : "") || current.model || "gemini-3.1-flash-image-preview",
                aspectRatio: normalizeImageAspectRatio(aspectSelect ? aspectSelect.value : current.aspectRatio || "1:1"),
                imageSize: normalizeImageSize(sizeSelect ? sizeSelect.value : current.imageSize || "1K")
            }
        });
    }

    function persistVideoGenSettings(patch) {
        var state = getState();
        var current = getVideoGenSettings(state);
        var next = {
            mode: normalizeVideoMode(patch && patch.mode ? patch.mode : current.mode),
            model: trimText(patch && patch.model ? patch.model : current.model) || current.model,
            aspectRatio: normalizeAspectRatio(patch && patch.aspectRatio ? patch.aspectRatio : current.aspectRatio),
            durationSeconds: 8,
            resolution: "720p"
        };

        stateAdapterUpdate({
            videoGenSettings: next
        });
    }

    function persistVideoAspectRatioChoice(nextValue) {
        var aspectRatio = normalizeAspectRatio(nextValue || "16:9");
        try {
            window.localStorage.setItem(STORAGE_KEY_ASPECT_RATIO, aspectRatio);
            if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function") {
                window.VeoBridgeSettings.saveSettings({ aspectRatio: aspectRatio });
            }
        } catch (error) {
            // ignore
        }
        persistVideoGenSettings({ aspectRatio: aspectRatio });
    }

    function maybeAutoApplyVideoAspectRatioFromShotId(shotId) {
        var state;
        var shot;
        var nextRatio;
        var aspectRatioSelect;

        if (!shotId) {
            return;
        }

        state = getState();
        if (activeGenerationType !== GEN_TYPE_VIDEO || normalizeVideoMode(getVideoGenSettings(state).mode) !== VIDEO_MODE_FRAMES) {
            return;
        }

        shot = findShotById(state.shots || [], shotId);
        nextRatio = guessVideoAspectRatioFromShot(shot);
        aspectRatioSelect = getById("aspectRatioSelect");
        if (!nextRatio || !aspectRatioSelect) {
            return;
        }

        aspectRatioSelect.value = nextRatio;
        persistVideoAspectRatioChoice(nextRatio);
        renderFlowComposerSummary(getState());
    }

    function setVideoMode(mode) {
        var nextMode = normalizeVideoMode(mode);
        var state = getState();
        var currentMode = normalizeVideoMode(getVideoGenSettings(state).mode);
        persistVideoGenSettings({ mode: nextMode });

        if (currentMode !== nextMode) {
            stateAdapterUpdate({
                startShotId: null,
                endShotId: null,
                videoRefs: []
            });
        }

        try {
            window.localStorage.setItem(STORAGE_KEY_VIDEO_MODE, nextMode);
        } catch (error) {
            // ignore
        }
        if (!videoCapabilities.checked) {
            probeVideoCapabilities(false);
        }
    }

    function probeVideoCapabilities(force) {
        var modelSelect = getById("modelSelect");
        var apiKey = getApiKeyFromStorage();
        var modelId = trimText(modelSelect ? modelSelect.value : "") || (window.VeoApi ? window.VeoApi.DEFAULT_MODEL_ID : "veo-3.1-generate-preview");
        var shouldForce = !!force;
        var signature = apiKey + "|" + modelId;

        if (!window.VeoApi || typeof window.VeoApi.probeVideoCapabilities !== "function") {
            return Promise.resolve(null);
        }
        if (!apiKey) {
            videoCapabilities = {
                checked: false,
                textToVideo: false,
                inlineData: false,
                reason: "API key missing."
            };
            videoCapabilitiesSignature = "";
            renderVideoModeUi(getState());
            return Promise.resolve(null);
        }
        if (capabilitiesProbePromise) {
            return capabilitiesProbePromise;
        }
        if (!shouldForce && videoCapabilities.checked && videoCapabilitiesSignature === signature) {
            return Promise.resolve(videoCapabilities);
        }

        capabilitiesProbePromise = window.VeoApi.probeVideoCapabilities({
            apiKey: apiKey,
            modelId: modelId
        }).then(function (result) {
            videoCapabilities = {
                checked: true,
                textToVideo: !!(result && result.textToVideo),
                inlineData: !!(result && result.inlineData),
                reason: result && result.reason ? String(result.reason) : ""
            };
            videoCapabilitiesSignature = signature;
            if (result && result.probeInconclusive) {
                setStatus("Video capabilities: image-input probe is inconclusive. Real generation can still work.", false);
            } else if (!videoCapabilities.inlineData) {
                setStatus("Video capabilities: Text-only mode for current key/project.", false);
            } else {
                setStatus("Video capabilities: Text + image-input modes available.", false);
            }
            renderVideoModeUi(getState());
            return videoCapabilities;
        }, function (error) {
            var message = formatError(error);
            var warnText = "Capability check is inconclusive for current key/project. Non-text modes may still work.";
            videoCapabilities = {
                checked: false,
                textToVideo: false,
                inlineData: false,
                reason: message
            };
            videoCapabilitiesSignature = signature;
            if (message) {
                warnText += " Details: " + message;
            }
            setStatus(warnText, false);
            renderVideoModeUi(getState());
            return null;
        }).then(function (value) {
            capabilitiesProbePromise = null;
            return value;
        }, function (error2) {
            capabilitiesProbePromise = null;
            throw error2;
        });

        return capabilitiesProbePromise;
    }

    function bindActions() {
        var btnVideoFlowOptions = getById("btnVideoFlowOptions");
        var videoFlowOptions = getById("videoFlowOptions");
        var btnOpenVideoStartPicker = getById("btnOpenVideoStartPicker");
        var btnOpenVideoEndPicker = getById("btnOpenVideoEndPicker");
        var btnOpenVideoRefPicker = getById("btnOpenVideoRefPicker");
        var btnOpenImageShotPicker = getById("btnOpenImageShotPicker");
        var btnCloseVideoPicker = getById("btnCloseVideoPicker");
        var btnCloseImagePicker = getById("btnCloseImagePicker");
        var videoPickerOverlay = getById("videoPickerOverlay");
        var imagePickerOverlay = getById("imagePickerOverlay");
        var mediaPreviewOverlay = getById("mediaPreviewOverlay");
        var btnCloseMediaPreview = getById("btnCloseMediaPreview");
        var btnMediaPreviewImport = getById("btnMediaPreviewImport");
        var mediaPreviewImportMenu = getById("mediaPreviewImportMenu");
        var btnMediaPreviewImportProject = getById("btnMediaPreviewImportProject");
        var btnMediaPreviewImportComp = getById("btnMediaPreviewImportComp");
        var btnMediaPreviewCapture = getById("btnMediaPreviewCapture");
        var btnMediaPreviewToFrames = getById("btnMediaPreviewToFrames");
        var btnMediaPreviewReveal = getById("btnMediaPreviewReveal");
        var btnMediaPreviewDelete = getById("btnMediaPreviewDelete");
        var cleanupConfirmModal = getById("cleanupConfirmModal");
        var btnCleanupCancel = getById("btnCleanupCancel");
        var btnCleanupConfirm = getById("btnCleanupConfirm");
        var btnCleanup = getById("btnCleanup");
        var btnUndoDelete = getById("btnUndoDelete");
        var diagnosticsConfirmModal = getById("diagnosticsConfirmModal");
        var btnSetStart = getById("btnSetStart");
        var btnSetEnd = getById("btnSetEnd");
        var btnClearStart = getById("btnClearStart");
        var btnClearEnd = getById("btnClearEnd");
        var btnSwapStartEnd = getById("btnSwapStartEnd");
        var btnGenTypeImage = getById("btnGenTypeImage");
        var btnGenTypeVideo = getById("btnGenTypeVideo");
        var btnModeFrames = getById("btnModeFrames");
        var btnModeReference = getById("btnModeReference");
        var btnAddVideoRefSelected = getById("btnAddVideoRefSelected");
        var btnClearVideoRefs = getById("btnClearVideoRefs");
        var btnGenerate = getById("btnGenerate");
        var btnImportVideo = getById("btnImportVideo");
        var btnRevealVideo = getById("btnRevealVideo");
        var btnDeleteVideo = getById("btnDeleteVideo");
        var btnToggleVideoMetaDetails = getById("btnToggleVideoMetaDetails");
        var btnToggleImageMetaDetails = getById("btnToggleImageMetaDetails");

        var btnAddRefs = getById("btnAddRefs");
        var btnAddSelectedShotToRefs = getById("btnAddSelectedShotToRefs");
        var btnClearRefs = getById("btnClearRefs");
        var refsFileInput = getById("refsFileInput");
        var btnGenerateImage = getById("btnGenerateImage");
        var btnImportImage = getById("btnImportImage");
        var btnAddImageToFrames = getById("btnAddImageToFrames");
        var btnRevealImage = getById("btnRevealImage");
        var btnDeleteImage = getById("btnDeleteImage");

        var btnTabVideo = getById("btnTabVideo");
        var btnTabImage = getById("btnTabImage");
        var btnClose = getById("btnClose");

        var sampleCountSelect = getById("sampleCountSelect");
        var modelSelect = getById("modelSelect");
        var aspectRatioSelect = getById("aspectRatioSelect");
        var promptInput = getById("promptInput");
        var imagePromptInput = getById("imagePromptInput");
        var imageSampleCountSelect = getById("imageSampleCountSelect");
        var imageModelSelect = getById("imageModelSelect");
        var imageAspectRatioSelect = getById("imageAspectRatioSelect");
        var imageSizeSelect = getById("imageSizeSelect");

        if (btnSetStart) {
            btnSetStart.addEventListener("click", setStart);
        }
        if (btnSetEnd) {
            btnSetEnd.addEventListener("click", setEnd);
        }
        if (btnOpenVideoStartPicker) {
            btnOpenVideoStartPicker.addEventListener("click", function () {
                openShotPicker("videoStart");
            });
        }
        if (btnOpenVideoEndPicker) {
            btnOpenVideoEndPicker.addEventListener("click", function () {
                openShotPicker("videoEnd");
            });
        }
        if (btnOpenVideoRefPicker) {
            btnOpenVideoRefPicker.addEventListener("click", function () {
                openShotPicker("videoRef");
            });
        }
        if (btnOpenImageShotPicker) {
            btnOpenImageShotPicker.addEventListener("click", function () {
                openShotPicker("imageRef");
            });
        }
        if (btnCloseVideoPicker) {
            btnCloseVideoPicker.addEventListener("click", closeShotPicker);
        }
        if (btnCloseImagePicker) {
            btnCloseImagePicker.addEventListener("click", closeShotPicker);
        }
        if (videoPickerOverlay) {
            videoPickerOverlay.addEventListener("click", function (event) {
                if (event && event.target === videoPickerOverlay) {
                    closeShotPicker();
                }
            });
        }
        if (imagePickerOverlay) {
            imagePickerOverlay.addEventListener("click", function (event) {
                if (event && event.target === imagePickerOverlay) {
                    closeShotPicker();
                }
            });
        }
        if (btnCloseMediaPreview) {
            btnCloseMediaPreview.addEventListener("click", closeMediaPreview);
        }
        if (mediaPreviewOverlay) {
            mediaPreviewOverlay.addEventListener("click", function (event) {
                if (event && event.target === mediaPreviewOverlay) {
                    closeMediaPreview();
                }
            });
        }
        if (btnMediaPreviewImport) {
            btnMediaPreviewImport.addEventListener("click", function () {
                toggleMediaPreviewImportMenu();
            });
        }
        if (btnMediaPreviewImportProject) {
            btnMediaPreviewImportProject.addEventListener("click", function () {
                if (mediaPreviewKind === "video") {
                    importSelectedVideo(mediaPreviewId);
                } else if (mediaPreviewKind === "image") {
                    importSelectedImage(mediaPreviewId);
                }
                closeMediaPreviewImportMenu();
            });
        }
        if (btnMediaPreviewImportComp) {
            btnMediaPreviewImportComp.addEventListener("click", function () {
                if (mediaPreviewKind === "video") {
                    importSelectedVideoToActiveComp(mediaPreviewId);
                } else if (mediaPreviewKind === "image") {
                    importSelectedImageToActiveComp(mediaPreviewId);
                }
                closeMediaPreviewImportMenu();
            });
        }
        if (btnMediaPreviewCapture) {
            btnMediaPreviewCapture.addEventListener("click", function () {
                if (mediaPreviewKind === "video") {
                    captureCurrentPreviewVideoFrame();
                }
            });
        }
        if (btnMediaPreviewToFrames) {
            btnMediaPreviewToFrames.addEventListener("click", function () {
                if (mediaPreviewKind === "image") {
                    addSelectedImageToFrames(mediaPreviewId);
                }
            });
        }
        if (btnMediaPreviewReveal) {
            btnMediaPreviewReveal.addEventListener("click", function () {
                closeMediaPreviewImportMenu();
                if (mediaPreviewKind === "video") {
                    revealSelectedVideo(mediaPreviewId);
                    return;
                }
                if (mediaPreviewKind === "image") {
                    revealSelectedImage(mediaPreviewId);
                }
            });
        }
        if (btnMediaPreviewDelete) {
            btnMediaPreviewDelete.addEventListener("click", function () {
                closeMediaPreviewImportMenu();
                if (mediaPreviewKind === "video") {
                    deleteSelectedVideo(mediaPreviewId);
                } else if (mediaPreviewKind === "image") {
                    deleteSelectedImage(mediaPreviewId);
                }
                closeMediaPreview();
            });
        }
        document.addEventListener("click", function (event) {
            if (!mediaPreviewImportMenu || mediaPreviewImportMenu.hidden) {
                return;
            }
            if (event && btnMediaPreviewImport && event.target === btnMediaPreviewImport) {
                return;
            }
            if (event && mediaPreviewImportMenu.contains && mediaPreviewImportMenu.contains(event.target)) {
                return;
            }
            closeMediaPreviewImportMenu();
        });
        if (btnClearStart) {
            btnClearStart.addEventListener("click", clearStart);
        }
        if (btnClearEnd) {
            btnClearEnd.addEventListener("click", clearEnd);
        }
        if (btnSwapStartEnd) {
            btnSwapStartEnd.addEventListener("click", swapStartEnd);
        }
        if (btnGenTypeImage) {
            btnGenTypeImage.addEventListener("click", function () {
                var previous = activeGenerationType;
                activeGenerationType = GEN_TYPE_IMAGE;
                if (previous !== activeGenerationType) {
                    stateAdapterUpdate({
                        startShotId: null,
                        endShotId: null,
                        videoRefs: [],
                        refs: []
                    });
                }
                try {
                    window.localStorage.setItem(STORAGE_KEY_GEN_TYPE, GEN_TYPE_IMAGE);
                } catch (storageError) {
                    // ignore
                }
                renderVideoModeUi(getState());
                renderFlowComposerSummary(getState());
            });
        }
        if (btnGenTypeVideo) {
            btnGenTypeVideo.addEventListener("click", function () {
                var previous = activeGenerationType;
                activeGenerationType = GEN_TYPE_VIDEO;
                if (previous !== activeGenerationType) {
                    stateAdapterUpdate({
                        startShotId: null,
                        endShotId: null,
                        videoRefs: [],
                        refs: []
                    });
                }
                try {
                    window.localStorage.setItem(STORAGE_KEY_GEN_TYPE, GEN_TYPE_VIDEO);
                } catch (storageError2) {
                    // ignore
                }
                renderVideoModeUi(getState());
                renderFlowComposerSummary(getState());
            });
        }
        if (btnModeFrames) {
            btnModeFrames.addEventListener("click", function () {
                setVideoMode(VIDEO_MODE_FRAMES);
            });
        }
        if (btnModeReference) {
            btnModeReference.addEventListener("click", function () {
                setVideoMode(VIDEO_MODE_REFERENCE);
            });
        }
        if (btnAddVideoRefSelected) {
            btnAddVideoRefSelected.addEventListener("click", addSelectedShotToVideoRefs);
        }
        if (btnClearVideoRefs) {
            btnClearVideoRefs.addEventListener("click", clearVideoReferences);
        }
        if (btnGenerate) {
            btnGenerate.addEventListener("click", onGenerateClick);
        }
        if (btnVideoFlowOptions) {
            btnVideoFlowOptions.addEventListener("click", function (event) {
                if (event && event.preventDefault) {
                    event.preventDefault();
                }
                if (event && event.stopPropagation) {
                    event.stopPropagation();
                }
                toggleFlowOptions();
            });
        }
        if (btnImportVideo) {
            btnImportVideo.addEventListener("click", importSelectedVideo);
        }
        if (btnRevealVideo) {
            btnRevealVideo.addEventListener("click", revealSelectedVideo);
        }
        if (btnDeleteVideo) {
            btnDeleteVideo.addEventListener("click", deleteSelectedVideo);
        }
        if (btnToggleVideoMetaDetails) {
            btnToggleVideoMetaDetails.addEventListener("click", function () {
                isVideoMetaDetailsExpanded = !isVideoMetaDetailsExpanded;
                renderVideoPreview(getState());
            });
        }
        if (btnToggleImageMetaDetails) {
            btnToggleImageMetaDetails.addEventListener("click", function () {
                isImageMetaDetailsExpanded = !isImageMetaDetailsExpanded;
                renderImagePreview(getState());
            });
        }

        if (btnAddRefs) {
            btnAddRefs.addEventListener("click", function () {
                if (refsFileInput) {
                    refsFileInput.click();
                }
            });
        }
        if (btnAddSelectedShotToRefs) {
            btnAddSelectedShotToRefs.addEventListener("click", addSelectedShotToRefs);
        }
        if (btnClearRefs) {
            btnClearRefs.addEventListener("click", clearReferences);
        }
        if (refsFileInput) {
            refsFileInput.addEventListener("change", function (event) {
                addReferenceFiles(event.target && event.target.files ? event.target.files : null);
                refsFileInput.value = "";
            });
        }
        if (btnGenerateImage) {
            btnGenerateImage.addEventListener("click", onGenerateImageClick);
        }
        if (btnImportImage) {
            btnImportImage.addEventListener("click", importSelectedImage);
        }
        if (btnAddImageToFrames) {
            btnAddImageToFrames.addEventListener("click", addSelectedImageToFrames);
        }
        if (btnRevealImage) {
            btnRevealImage.addEventListener("click", revealSelectedImage);
        }
        if (btnDeleteImage) {
            btnDeleteImage.addEventListener("click", deleteSelectedImage);
        }

        if (btnTabVideo) {
            btnTabVideo.addEventListener("click", function () {
                setActiveTab("video");
            });
        }
        if (btnTabImage) {
            btnTabImage.addEventListener("click", function () {
                setActiveTab("image");
            });
        }
        if (btnClose) {
            btnClose.addEventListener("click", closeWindow);
        }
        if (btnUndoDelete) {
            btnUndoDelete.addEventListener("click", undoLastDeleteAction);
        }
        if (btnCleanup) {
            btnCleanup.addEventListener("click", openCleanupConfirmModal);
        }
        if (btnCleanupCancel) {
            btnCleanupCancel.addEventListener("click", function () {
                closeCleanupConfirmModal();
                setStatus("Cleanup canceled.", false);
            });
        }
        if (btnCleanupConfirm) {
            btnCleanupConfirm.addEventListener("click", runCleanup);
        }
        if (cleanupConfirmModal) {
            cleanupConfirmModal.addEventListener("click", function (event) {
                if (event && event.target === cleanupConfirmModal) {
                    closeCleanupConfirmModal();
                    setStatus("Cleanup canceled.", false);
                }
            });
        }

        if (modelSelect) {
            modelSelect.addEventListener("change", function () {
                var nextModel = trimText(modelSelect.value);
                try {
                    window.localStorage.setItem(STORAGE_KEY_MODEL, nextModel || "");
                    if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function") {
                        window.VeoBridgeSettings.saveSettings({ modelId: nextModel || "" });
                    }
                } catch (error) {
                    // ignore
                }
                persistVideoGenSettings({ model: nextModel });
                videoCapabilities.checked = false;
                videoCapabilitiesSignature = "";
                probeVideoCapabilities(false);
                renderFlowComposerSummary(getState());
            });
        }
        if (sampleCountSelect) {
            sampleCountSelect.addEventListener("change", function () {
                renderFlowComposerSummary(getState());
            });
        }
        if (aspectRatioSelect) {
            aspectRatioSelect.addEventListener("change", function () {
                var nextValue = normalizeAspectRatio(aspectRatioSelect.value || "16:9");
                aspectRatioSelect.value = nextValue;
                persistVideoAspectRatioChoice(nextValue, true);
                renderFlowComposerSummary(getState());
            });
        }
        if (promptInput) {
            promptInput.addEventListener("change", function () {
                try {
                    window.localStorage.setItem(STORAGE_KEY_PROMPT, promptInput.value || "");
                    window.localStorage.setItem(STORAGE_KEY_IMAGE_PROMPT, promptInput.value || "");
                } catch (error) {
                    // ignore
                }
            });
        }
        if (imagePromptInput) {
            imagePromptInput.addEventListener("change", function () {
                try {
                    window.localStorage.setItem(STORAGE_KEY_IMAGE_PROMPT, imagePromptInput.value || "");
                } catch (error) {
                    // ignore
                }
            });
        }
        if (imageSampleCountSelect) {
            imageSampleCountSelect.addEventListener("change", function () {
                renderFlowComposerSummary(getState());
            });
        }
        if (imageModelSelect) {
            imageModelSelect.addEventListener("change", function () {
                persistImageGenSettings();
                renderFlowComposerSummary(getState());
            });
        }
        if (imageAspectRatioSelect) {
            imageAspectRatioSelect.addEventListener("change", function () {
                persistImageGenSettings();
                renderFlowComposerSummary(getState());
            });
        }
        if (imageSizeSelect) {
            imageSizeSelect.addEventListener("change", function () {
                persistImageGenSettings();
                renderFlowComposerSummary(getState());
            });
        }

        window.addEventListener("click", function (event) {
            var target = event ? event.target : null;
            var insideVideo = videoFlowOptions && target && videoFlowOptions.contains(target);
            var onVideoTrigger = btnVideoFlowOptions && target && (target === btnVideoFlowOptions || btnVideoFlowOptions.contains(target));

            if (!insideVideo && !onVideoTrigger) {
                closeFlowOptions();
            }
        });

        document.addEventListener("keydown", function (event) {
            if (!event) {
                return;
            }
            if (event.key === "Escape" || event.keyCode === 27) {
                if (cleanupConfirmModal && !cleanupConfirmModal.hidden) {
                    closeCleanupConfirmModal();
                    setStatus("Cleanup canceled.", false);
                    return;
                }
                if (diagnosticsConfirmModal && !diagnosticsConfirmModal.hidden) {
                    var diagnosticsActions = getActionsAdapter();
                    if (diagnosticsActions && typeof diagnosticsActions.closeDiagnosticsModal === "function") {
                        diagnosticsActions.closeDiagnosticsModal();
                    }
                    setStatus("Diagnostics export canceled.", false);
                    return;
                }
                if (mediaPreviewOverlay && !mediaPreviewOverlay.hidden) {
                    closeMediaPreview();
                }
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        if (typeof require === "function") {
            try {
                path = require("path");
                fs = require("fs");
                os = require("os");
                childProcess = require("child_process");
            } catch (error) {
                path = null;
                fs = null;
                os = null;
                childProcess = null;
            }
        }

        if (!window.VeoBridgeState || typeof window.VeoBridgeState.getState !== "function") {
            setStatus("VeoBridgeState is unavailable.", true);
            return;
        }

        applySavedWindowSizeOnLoad();
        startWindowSizeWatcher();

        bindActions();
        var localActionsAdapter = getActionsAdapter();
        if (localActionsAdapter && typeof localActionsAdapter.bindUi === "function") {
            localActionsAdapter.bindUi();
        }
        bindCarouselBehavior();
        bindRefsDropZone();
        bindVideoRefsDropZone();
        bindLayoutSplitters();
        loadLayouts();
        loadGenerationPrefs();
        probeVideoCapabilities(false);
        startPendingJobsStaleWatcher();

        (function bindVideoPreviewError() {
            var player = getById("videoPreviewPlayer");
            if (!player) {
                return;
            }
            player.addEventListener("error", function () {
                setStatus("Video preview failed to load. File may be corrupted or missing.", true);
            });
        }());

        (function bindImagePreviewError() {
            var imageEl = getById("imagePreview");
            if (!imageEl) {
                return;
            }
            imageEl.addEventListener("error", function () {
                setStatus("Image preview failed to load. File may be corrupted or missing.", true);
            });
        }());

        var initialState = getState();
        var initialStaleResult = markStalePendingJobs({
            state: initialState,
            notify: true
        });
        if (initialStaleResult.changed) {
            initialState = getState();
        }
        renderAll(initialState);
        if (!initialStaleResult.changed) {
            setStatus("Ready.", false);
        }
        setGenerationStatus("Idle.", false);
        setImageGenerationStatus("Idle.", false);
        updateUndoDeleteButtonState();
        refreshBusyUi();
        schedulePendingVideoResume(280);

        if (typeof window.VeoBridgeState.ensurePaths === "function") {
            window.VeoBridgeState.ensurePaths(function (error, pathsResult) {
                if (error) {
                    setStatus("Path initialization warning: " + error.message + ". Using userData/VeoBridge.", false);
                    return;
                }
                hostPaths = pathsResult || null;
                if (!hostPaths || !hostPaths.projectSaved) {
                    setStatus("Project is not saved yet. Media is stored in userData/VeoBridge; importing to AE will require saving the project first.", false);
                }
            });
        }

        window.VeoBridgeState.onStateChanged = function (nextState) {
            var stateSnapshot = nextState || getState();
            var staleResult = markStalePendingJobs({
                state: stateSnapshot,
                notify: true
            });
            if (staleResult.changed) {
                return;
            }
            renderAll(stateSnapshot);
            if (!isVideoGenerating && hasActivePendingVideoJobs(stateSnapshot)) {
                schedulePendingVideoResume(380);
            }
        };

        window.addEventListener("resize", function () {
            applyVideoLayout();
            applyImageLayout();
            saveWindowSizeDebounced();
            updateCarouselDensity();
            renderAll(getState());
        });

        window.addEventListener("focus", function () {
            probeVideoCapabilities(false);
            markStalePendingJobs({
                notify: true
            });
            schedulePendingVideoResume(220);
        });

        window.addEventListener("beforeunload", function () {
            stopWindowSizeWatcher();
            saveWindowSizeNow();
            stopPendingJobsLeaseHeartbeat();
            stopPendingJobsStaleWatcher();
            releasePendingJobsLease();
            stopSmoothProgressTicker();
            if (pendingVideoResumeTimer && typeof window.clearTimeout === "function") {
                window.clearTimeout(pendingVideoResumeTimer);
                pendingVideoResumeTimer = null;
            }
        });

        dispatchGalleryReadyEvent();
    });

    window.addEventListener("error", function (event) {
        var message = event && event.message ? event.message : "Unexpected UI error.";
        if (isIgnorableResizeObserverError(message) || isIgnorableMediaPlayError(message)) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            return;
        }
        setStatus("Unexpected error: " + message, true);
        setGenerationStatus("Unexpected error: " + message, true);
        setImageGenerationStatus("Unexpected error: " + message, true);
    });

    window.addEventListener("unhandledrejection", function (event) {
        var reason = event && event.reason ? event.reason : "Unknown rejection";
        var message = resolveErrorMessage(reason);
        if (isIgnorableResizeObserverError(message) || isIgnorableMediaPlayError(message)) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            return;
        }
        setStatus("Unexpected async error: " + message, true);
        setGenerationStatus("Unexpected async error: " + message, true);
        setImageGenerationStatus("Unexpected async error: " + message, true);
    });
}());
