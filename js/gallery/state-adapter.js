(function (global) {
    "use strict";

    if (!global.VeoBridgeGalleryModules) {
        global.VeoBridgeGalleryModules = {};
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

    function _cloneJson(value, fallback) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return typeof fallback === "undefined" ? null : fallback;
        }
    }

    function _resolveStateFilePath(path, os) {
        var env;
        var home;
        var platform;
        var userDataDir;

        if (!path || !os || typeof process === "undefined") {
            return "";
        }

        env = process.env || {};
        platform = process.platform;
        home = os.homedir ? os.homedir() : env.HOME;
        if (!home) {
            return "";
        }

        if (platform === "win32") {
            userDataDir = env.APPDATA || path.join(home, "AppData", "Roaming");
        } else if (platform === "darwin") {
            userDataDir = path.join(home, "Library", "Application Support");
        } else {
            userDataDir = env.XDG_CONFIG_HOME || path.join(home, ".config");
        }

        if (!userDataDir) {
            return "";
        }

        return path.join(userDataDir, "VeoBridge", "state.json");
    }

    function create(options) {
        var opts = options || {};
        var stateApi = opts.stateApi || global.VeoBridgeState || null;
        var logger = typeof opts.logger === "function" ? opts.logger : null;
        var fs = _safeRequire("fs");
        var path = _safeRequire("path");
        var os = _safeRequire("os");

        function _log(level, message, extra) {
            if (!logger) {
                return;
            }
            try {
                logger(level, message, extra || null);
            } catch (error) {
                // Intentionally ignore logger failures.
            }
        }

        function _assertApiMethod(methodName) {
            if (!stateApi || typeof stateApi[methodName] !== "function") {
                throw new Error("VeoBridgeState." + methodName + " is unavailable.");
            }
        }

        function getState() {
            _assertApiMethod("getState");
            return stateApi.getState();
        }

        function updateState(patch) {
            _assertApiMethod("updateState");
            _log("debug", "state.update", { keys: Object.keys(patch || {}) });
            return stateApi.updateState(patch || {});
        }

        function loadState() {
            if (!stateApi || typeof stateApi.loadState !== "function") {
                return getState();
            }
            return stateApi.loadState();
        }

        function saveState(nextState) {
            _assertApiMethod("saveState");
            _log("debug", "state.save", {
                hasState: !!nextState
            });
            return stateApi.saveState(nextState || {});
        }

        function getStateFilePath() {
            return _resolveStateFilePath(path, os);
        }

        function readStateFileRaw() {
            var stateFilePath = getStateFilePath();

            if (!stateFilePath || !fs || typeof fs.readFileSync !== "function") {
                return "";
            }
            try {
                return String(fs.readFileSync(stateFilePath, "utf8") || "");
            } catch (error) {
                return "";
            }
        }

        function getSnapshotForDiagnostics() {
            var currentState = null;
            var stateFilePath = getStateFilePath();
            var rawState = readStateFileRaw();

            try {
                currentState = getState();
            } catch (error) {
                currentState = null;
            }

            return {
                stateFilePath: stateFilePath,
                state: _cloneJson(currentState, null),
                rawState: rawState
            };
        }

        return {
            getState: getState,
            updateState: updateState,
            loadState: loadState,
            saveState: saveState,
            getStateFilePath: getStateFilePath,
            readStateFileRaw: readStateFileRaw,
            getSnapshotForDiagnostics: getSnapshotForDiagnostics
        };
    }

    global.VeoBridgeGalleryModules.stateAdapter = {
        create: create
    };
}(window));
