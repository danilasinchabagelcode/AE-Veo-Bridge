(function (global) {
    "use strict";

    var POLL_INTERVAL_MS = 750;
    var STATE_VERSION_NONE = 0;
    var LATEST_STATE_VERSION = 2;
    var DEFAULT_STATE = {
        stateVersion: LATEST_STATE_VERSION,
        shots: [],
        selectedShotId: null,
        startShotId: null,
        endShotId: null,
        pendingJobs: [],
        pendingJobsLease: null,
        videoGenSettings: {
            mode: "frames",
            model: "veo-3.1-generate-preview",
            aspectRatio: "16:9",
            durationSeconds: 8,
            resolution: "720p"
        },
        videoRefs: [],
        videos: [],
        selectedVideoId: null,
        images: [],
        selectedImageId: null,
        imageGenSettings: {
            model: "gemini-3.1-flash-image-preview",
            aspectRatio: "1:1",
            imageSize: "1K"
        },
        refs: []
    };

    var fs = null;
    var path = null;
    var os = null;
    var cs = null;

    var cachedState = null;
    var cachedPaths = null;
    var isEnsuringPaths = false;
    var ensurePathsWaiters = [];
    var lastKnownMtimeMs = 0;
    var pollTimer = null;

    function _logError(message) {
        if (global.console && typeof global.console.error === "function") {
            global.console.error("[VeoBridgeState] " + message);
        }
    }

    function _safeRequire(name) {
        try {
            if (typeof require === "function") {
                return require(name);
            }
        } catch (error) {
            return null;
        }
        return null;
    }

    function _cloneJson(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function _toNumberOrNull(value) {
        var parsed = parseInt(value, 10);
        if (!isFinite(parsed)) {
            return null;
        }
        return parsed;
    }

    function _normalizeShot(shot) {
        var input = shot || {};
        return {
            id: input.id || null,
            path: input.path || null,
            compName: input.compName || null,
            frame: typeof input.frame === "number" ? input.frame : null,
            createdAt: input.createdAt || null,
            width: typeof input.width === "number" ? input.width : null,
            height: typeof input.height === "number" ? input.height : null
        };
    }

    function _normalizePendingJob(job) {
        var input = job || {};
        var refs = [];
        var i;

        if (input.references && input.references instanceof Array) {
            for (i = 0; i < input.references.length; i += 1) {
                refs.push(_normalizeRef(input.references[i]));
            }
        }

        return {
            id: input.id || null,
            kind: input.kind || "video",
            batchId: input.batchId || null,
            status: input.status || "queued",
            sampleIndex: _toNumberOrNull(input.sampleIndex),
            sampleCount: _toNumberOrNull(input.sampleCount),
            createdAt: input.createdAt || null,
            updatedAt: input.updatedAt || null,
            prompt: input.prompt || null,
            modelId: input.modelId || null,
            aspectRatio: input.aspectRatio || null,
            uiMode: input.uiMode || null,
            apiMode: input.apiMode || null,
            durationSeconds: typeof input.durationSeconds === "number" ? input.durationSeconds : null,
            resolution: input.resolution || null,
            videosDir: input.videosDir || null,
            startShotId: input.startShotId || null,
            endShotId: input.endShotId || null,
            startShotPath: input.startShotPath || null,
            endShotPath: input.endShotPath || null,
            startShotCompName: input.startShotCompName || null,
            endShotCompName: input.endShotCompName || null,
            startShotFrame: typeof input.startShotFrame === "number" ? input.startShotFrame : null,
            endShotFrame: typeof input.endShotFrame === "number" ? input.endShotFrame : null,
            references: refs,
            referenceIds: input.referenceIds && input.referenceIds instanceof Array ? input.referenceIds.slice(0) : [],
            operationName: input.operationName || null,
            operationUrl: input.operationUrl || null,
            requestMode: input.requestMode || null,
            fallbackReason: input.fallbackReason || null,
            downloadedPath: input.downloadedPath || null,
            lastStage: input.lastStage || null,
            error: input.error || null
        };
    }

    function _normalizePendingJobsLease(lease) {
        var input = lease || {};
        var ownerId = input.ownerId ? String(input.ownerId) : "";
        var expiresAt = parseInt(input.expiresAt, 10);
        var updatedAt = input.updatedAt ? String(input.updatedAt) : null;

        if (!ownerId) {
            return null;
        }
        if (!isFinite(expiresAt) || expiresAt <= 0) {
            return null;
        }

        return {
            ownerId: ownerId,
            expiresAt: expiresAt,
            updatedAt: updatedAt
        };
    }

    function _normalizeVideo(video) {
        var input = video || {};
        var mode = input.mode || "frames";

        if (mode === "image" || mode === "interpolation") {
            mode = "frames";
        }
        if (mode !== "text" && mode !== "frames" && mode !== "reference") {
            mode = "frames";
        }

        return {
            id: input.id || null,
            path: input.path || null,
            createdAt: input.createdAt || null,
            prompt: input.prompt || null,
            batchId: input.batchId || null,
            sampleIndex: _toNumberOrNull(input.sampleIndex),
            sampleCount: _toNumberOrNull(input.sampleCount),
            aspectRatio: input.aspectRatio || "16:9",
            startShotId: input.startShotId || null,
            endShotId: input.endShotId || null,
            model: input.model || null,
            mode: mode,
            durationSeconds: typeof input.durationSeconds === "number" ? input.durationSeconds : null,
            resolution: input.resolution || null,
            refIds: input.refIds && input.refIds instanceof Array ? input.refIds : [],
            requestMode: input.requestMode || null,
            status: input.status || "ready"
        };
    }

    function _normalizeImage(image) {
        var input = image || {};
        return {
            id: input.id || null,
            path: input.path || null,
            createdAt: input.createdAt || null,
            prompt: input.prompt || null,
            batchId: input.batchId || null,
            sampleIndex: _toNumberOrNull(input.sampleIndex),
            sampleCount: _toNumberOrNull(input.sampleCount),
            aspectRatio: input.aspectRatio || "1:1",
            imageSize: input.imageSize || "1K",
            model: input.model || "gemini-3.1-flash-image-preview",
            refIds: input.refIds && input.refIds instanceof Array ? input.refIds.slice(0) : [],
            refPaths: input.refPaths && input.refPaths instanceof Array ? input.refPaths.slice(0) : [],
            width: typeof input.width === "number" ? input.width : null,
            height: typeof input.height === "number" ? input.height : null,
            status: input.status || "ready"
        };
    }

    function _normalizeRef(refItem) {
        var input = refItem || {};
        return {
            id: input.id || null,
            path: input.path || null,
            name: input.name || null,
            mimeType: input.mimeType || null,
            createdAt: input.createdAt || null
        };
    }

    function _normalizeImageGenSettings(settings) {
        var input = settings || {};
        return {
            model: input.model || "gemini-3.1-flash-image-preview",
            aspectRatio: input.aspectRatio || "1:1",
            imageSize: input.imageSize || "1K"
        };
    }

    function _normalizeVideoGenSettings(settings) {
        var input = settings || {};
        var mode = input.mode || "frames";
        var aspectRatio = input.aspectRatio === "9:16" ? "9:16" : "16:9";
        var durationSeconds = parseInt(input.durationSeconds, 10);
        var resolution = String(input.resolution || "").toLowerCase();

        if (mode === "image" || mode === "interpolation") {
            mode = "frames";
        }

        if (mode !== "text" && mode !== "frames" && mode !== "reference") {
            mode = "frames";
        }

        if (durationSeconds !== 4 && durationSeconds !== 6 && durationSeconds !== 8) {
            durationSeconds = 8;
        }

        if (resolution !== "1080p" && resolution !== "4k") {
            resolution = "720p";
        }

        return {
            mode: mode,
            model: input.model || "veo-3.1-generate-preview",
            aspectRatio: aspectRatio,
            durationSeconds: durationSeconds,
            resolution: resolution
        };
    }

    function _toStateVersion(value) {
        var parsed = parseInt(value, 10);
        if (!isFinite(parsed) || parsed < STATE_VERSION_NONE) {
            return STATE_VERSION_NONE;
        }
        return parsed;
    }

    function _migrateStateToV1(candidate) {
        var next = candidate && typeof candidate === "object" ? _cloneJson(candidate) : {};
        if (!next || typeof next !== "object") {
            next = {};
        }

        if (!(next.videoRefs && next.videoRefs instanceof Array)) {
            next.videoRefs = [];
        }
        if (!(next.pendingJobs && next.pendingJobs instanceof Array)) {
            next.pendingJobs = [];
        }
        if (!next.pendingJobsLease || typeof next.pendingJobsLease !== "object") {
            next.pendingJobsLease = null;
        }
        if (!(next.videos && next.videos instanceof Array)) {
            next.videos = [];
        }
        if (typeof next.selectedVideoId === "undefined") {
            next.selectedVideoId = null;
        }
        if (!(next.images && next.images instanceof Array)) {
            next.images = [];
        }
        if (typeof next.selectedImageId === "undefined") {
            next.selectedImageId = null;
        }
        if (!(next.refs && next.refs instanceof Array)) {
            next.refs = [];
        }
        if (!next.videoGenSettings || typeof next.videoGenSettings !== "object") {
            next.videoGenSettings = _cloneJson(DEFAULT_STATE.videoGenSettings);
        }
        if (!next.imageGenSettings || typeof next.imageGenSettings !== "object") {
            next.imageGenSettings = _cloneJson(DEFAULT_STATE.imageGenSettings);
        }

        next.stateVersion = 1;
        return next;
    }

    function _migrateStateToV2(candidate) {
        var next = candidate && typeof candidate === "object" ? _cloneJson(candidate) : {};
        if (!next || typeof next !== "object") {
            next = {};
        }

        if (next.videoGenSettings && next.videoGenSettings.mode) {
            if (next.videoGenSettings.mode === "image" || next.videoGenSettings.mode === "interpolation") {
                next.videoGenSettings.mode = "frames";
            }
        }
        if (next.videos && next.videos instanceof Array) {
            var i;
            var mode;
            for (i = 0; i < next.videos.length; i += 1) {
                if (!next.videos[i] || typeof next.videos[i] !== "object") {
                    continue;
                }
                mode = next.videos[i].mode;
                if (mode === "image" || mode === "interpolation") {
                    next.videos[i].mode = "frames";
                }
            }
        }

        next.stateVersion = 2;
        return next;
    }

    function _migrateState(candidate) {
        var migrated = candidate && typeof candidate === "object" ? _cloneJson(candidate) : {};
        var version = _toStateVersion(migrated && migrated.stateVersion);

        if (version < 1) {
            migrated = _migrateStateToV1(migrated);
            version = 1;
        }
        if (version < 2) {
            migrated = _migrateStateToV2(migrated);
            version = 2;
        }

        if (!migrated || typeof migrated !== "object") {
            migrated = {};
        }
        migrated.stateVersion = LATEST_STATE_VERSION;
        return migrated;
    }

    function _normalizeState(candidate) {
        var input = _migrateState(candidate || {});
        var shots = [];
        var pendingJobs = [];
        var videos = [];
        var images = [];
        var refs = [];
        var i;

        if (input.shots && input.shots instanceof Array) {
            for (i = 0; i < input.shots.length; i += 1) {
                shots.push(_normalizeShot(input.shots[i]));
            }
        }

        if (input.videos && input.videos instanceof Array) {
            for (i = 0; i < input.videos.length; i += 1) {
                videos.push(_normalizeVideo(input.videos[i]));
            }
        }

        if (input.pendingJobs && input.pendingJobs instanceof Array) {
            for (i = 0; i < input.pendingJobs.length; i += 1) {
                pendingJobs.push(_normalizePendingJob(input.pendingJobs[i]));
            }
        }

        if (input.images && input.images instanceof Array) {
            for (i = 0; i < input.images.length; i += 1) {
                images.push(_normalizeImage(input.images[i]));
            }
        }

        if (input.refs && input.refs instanceof Array) {
            for (i = 0; i < input.refs.length; i += 1) {
                refs.push(_normalizeRef(input.refs[i]));
            }
        }

        return {
            stateVersion: LATEST_STATE_VERSION,
            shots: shots,
            selectedShotId: input.selectedShotId || null,
            startShotId: input.startShotId || null,
            endShotId: input.endShotId || null,
            pendingJobs: pendingJobs,
            pendingJobsLease: _normalizePendingJobsLease(input.pendingJobsLease),
            videoGenSettings: _normalizeVideoGenSettings(input.videoGenSettings),
            videoRefs: input.videoRefs && input.videoRefs instanceof Array ? input.videoRefs.map(_normalizeRef) : [],
            videos: videos,
            selectedVideoId: input.selectedVideoId || null,
            images: images,
            selectedImageId: input.selectedImageId || null,
            imageGenSettings: _normalizeImageGenSettings(input.imageGenSettings),
            refs: refs
        };
    }

    function _resolveUserDataDir() {
        var home;
        var platform;
        var env;

        if (!path || !os || typeof process === "undefined") {
            return null;
        }

        env = process.env || {};
        platform = process.platform;
        home = os.homedir ? os.homedir() : env.HOME;

        if (!home) {
            return null;
        }

        if (platform === "win32") {
            return env.APPDATA || path.join(home, "AppData", "Roaming");
        }

        if (platform === "darwin") {
            return path.join(home, "Library", "Application Support");
        }

        return env.XDG_CONFIG_HOME || path.join(home, ".config");
    }

    function _getStoragePaths() {
        var userDataDir = _resolveUserDataDir();
        var veoBridgeDir;
        var stateFile;

        if (!userDataDir || !path) {
            return null;
        }

        veoBridgeDir = path.join(userDataDir, "VeoBridge");
        stateFile = path.join(veoBridgeDir, "state.json");

        return {
            userDataDir: userDataDir,
            veoBridgeDir: veoBridgeDir,
            stateFile: stateFile
        };
    }

    function _ensureStorageDir(storagePaths) {
        var dir;
        var parentDir;

        if (!fs || !storagePaths) {
            return false;
        }

        dir = storagePaths.veoBridgeDir;

        try {
            if (fs.existsSync(dir)) {
                return true;
            }
        } catch (errorExists) {
            return false;
        }

        try {
            parentDir = path.dirname(dir);
            if (parentDir && parentDir !== dir && !fs.existsSync(parentDir)) {
                if (!_ensureStorageDir({ veoBridgeDir: parentDir })) {
                    return false;
                }
            }
            fs.mkdirSync(dir);
            return true;
        } catch (error) {
            _logError("Failed to create storage directory: " + String(error));
            return false;
        }
    }

    function _readMtimeMs(filePath) {
        var stats;
        if (!fs || !filePath) {
            return 0;
        }

        try {
            stats = fs.statSync(filePath);
            return stats && typeof stats.mtimeMs === "number" ? stats.mtimeMs : 0;
        } catch (error) {
            return 0;
        }
    }

    function _writeStateToDisk(nextState) {
        var storagePaths = _getStoragePaths();

        if (!fs || !storagePaths) {
            return false;
        }

        if (!_ensureStorageDir(storagePaths)) {
            return false;
        }

        try {
            fs.writeFileSync(storagePaths.stateFile, JSON.stringify(nextState, null, 2), "utf8");
            lastKnownMtimeMs = _readMtimeMs(storagePaths.stateFile);
            return true;
        } catch (error) {
            _logError("Failed to write state file: " + String(error));
            return false;
        }
    }

    function _readStateFromDisk() {
        var storagePaths = _getStoragePaths();
        var raw;
        var parsed;
        var normalized;

        if (!fs || !storagePaths) {
            return _cloneJson(DEFAULT_STATE);
        }

        if (!_ensureStorageDir(storagePaths)) {
            return _cloneJson(DEFAULT_STATE);
        }

        if (!fs.existsSync(storagePaths.stateFile)) {
            _writeStateToDisk(DEFAULT_STATE);
            return _cloneJson(DEFAULT_STATE);
        }

        try {
            raw = fs.readFileSync(storagePaths.stateFile, "utf8");
            parsed = raw ? JSON.parse(raw) : {};
            normalized = _normalizeState(parsed);
            lastKnownMtimeMs = _readMtimeMs(storagePaths.stateFile);
            return normalized;
        } catch (error) {
            _logError("Failed to read state file, resetting defaults: " + String(error));
            _writeStateToDisk(DEFAULT_STATE);
            return _cloneJson(DEFAULT_STATE);
        }
    }

    function _emitStateChanged() {
        if (typeof api.onStateChanged === "function") {
            try {
                api.onStateChanged(_cloneJson(cachedState));
            } catch (callbackError) {
                _logError("onStateChanged callback failed: " + String(callbackError));
            }
        }
    }

    function _pollStateFileChanges() {
        var storagePaths = _getStoragePaths();
        var currentMtime;

        if (!fs || !storagePaths || !fs.existsSync(storagePaths.stateFile)) {
            return;
        }

        currentMtime = _readMtimeMs(storagePaths.stateFile);
        if (!currentMtime || currentMtime === lastKnownMtimeMs) {
            return;
        }

        lastKnownMtimeMs = currentMtime;
        cachedState = _readStateFromDisk();
        _emitStateChanged();
    }

    function _startPolling() {
        if (pollTimer || typeof global.setInterval !== "function") {
            return;
        }
        pollTimer = global.setInterval(_pollStateFileChanges, POLL_INTERVAL_MS);
    }

    function _parseHostJson(raw) {
        if (typeof raw !== "string") {
            return null;
        }
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    function _flushEnsurePathsWaiters(error, pathsResult) {
        var i;
        var waiter;
        var queue = ensurePathsWaiters.slice(0);

        ensurePathsWaiters = [];
        for (i = 0; i < queue.length; i += 1) {
            waiter = queue[i];
            if (typeof waiter === "function") {
                try {
                    waiter(error, pathsResult);
                } catch (waiterError) {
                    _logError("ensurePaths callback failed: " + String(waiterError));
                }
            }
        }
    }

    var api = {
        onStateChanged: null,

        loadState: function () {
            cachedState = _readStateFromDisk();
            return _cloneJson(cachedState);
        },

        saveState: function (newState) {
            var normalized = _normalizeState(newState);
            if (!_writeStateToDisk(normalized)) {
                return _cloneJson(cachedState || DEFAULT_STATE);
            }
            cachedState = normalized;
            _emitStateChanged();
            return _cloneJson(cachedState);
        },

        updateState: function (patch) {
            var base = _readStateFromDisk();
            var next = {
                stateVersion: base.stateVersion || LATEST_STATE_VERSION,
                shots: base.shots,
                selectedShotId: base.selectedShotId,
                startShotId: base.startShotId,
                endShotId: base.endShotId,
                pendingJobs: base.pendingJobs,
                pendingJobsLease: base.pendingJobsLease,
                videoGenSettings: base.videoGenSettings,
                videoRefs: base.videoRefs,
                videos: base.videos,
                selectedVideoId: base.selectedVideoId,
                images: base.images,
                selectedImageId: base.selectedImageId,
                imageGenSettings: base.imageGenSettings,
                refs: base.refs
            };
            var key;

            cachedState = _cloneJson(base);

            if (patch && typeof patch === "object") {
                for (key in patch) {
                    if (patch.hasOwnProperty(key)) {
                        next[key] = patch[key];
                    }
                }
            }

            return api.saveState(next);
        },

        getState: function () {
            if (!cachedState) {
                cachedState = _readStateFromDisk();
            }
            return _cloneJson(cachedState);
        },

        ensurePaths: function (callback) {
            var localCallback = typeof callback === "function" ? callback : function () {};
            var payload;
            var rawMessage;

            if (cachedPaths) {
                localCallback(null, _cloneJson(cachedPaths));
                return _cloneJson(cachedPaths);
            }

            ensurePathsWaiters.push(localCallback);
            if (isEnsuringPaths) {
                return null;
            }

            isEnsuringPaths = true;

            if (!cs) {
                isEnsuringPaths = false;
                _flushEnsurePathsWaiters(new Error("CSInterface is unavailable"), null);
                return null;
            }

            cs.evalScript("VeoBridge_getPaths()", function (rawResponse) {
                var parsed = _parseHostJson(rawResponse);
                var error = null;

                isEnsuringPaths = false;

                if (!parsed || !parsed.ok || !parsed.paths) {
                    payload = parsed || {};
                    rawMessage = typeof rawResponse === "string" ? rawResponse : "";
                    error = new Error(payload.error || rawMessage || "VeoBridge_getPaths failed");
                    _flushEnsurePathsWaiters(error, null);
                    return;
                }

                cachedPaths = parsed.paths;
                _flushEnsurePathsWaiters(null, _cloneJson(cachedPaths));
            });

            return null;
        }
    };

    fs = _safeRequire("fs");
    path = _safeRequire("path");
    os = _safeRequire("os");
    cs = global.CSInterfaceLite ? new global.CSInterfaceLite() : null;

    cachedState = _readStateFromDisk();
    _startPolling();
    api.ensurePaths();

    global.VeoBridgeState = api;
}(window));
