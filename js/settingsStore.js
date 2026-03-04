(function (global) {
    "use strict";

    var fs = null;
    var path = null;
    var os = null;

    var DEFAULT_SETTINGS = {
        apiKey: "",
        modelId: "veo-3.1-generate-preview",
        aspectRatio: "16:9",
        window: {
            gallery: {
                width: 1180,
                height: 820
            }
        },
        layout: {
            gallery: {
                video: {
                    colRatio: 0.54,
                    leftTopRatio: 0.42,
                    rightTopRatio: 0.68
                },
                image: {
                    colRatio: 0.54,
                    leftTopRatio: 0.34,
                    leftMidRatio: 0.28,
                    rightTopRatio: 0.7
                }
            }
        }
    };

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

    function _clone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
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

    function _getSettingsFilePath() {
        var userDataDir = _resolveUserDataDir();
        if (!userDataDir || !path) {
            return null;
        }
        return path.join(userDataDir, "VeoBridge", "settings.json");
    }

    function _ensureDirRecursive(dirPath) {
        var parent;

        if (!fs || !path || !dirPath) {
            return false;
        }

        try {
            if (fs.existsSync(dirPath)) {
                return true;
            }
        } catch (errorExists) {
            return false;
        }

        parent = path.dirname(dirPath);
        if (parent && parent !== dirPath) {
            if (!_ensureDirRecursive(parent)) {
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

    function _normalize(raw) {
        var input = raw || {};
        var aspectRatio = input.aspectRatio ? String(input.aspectRatio) : DEFAULT_SETTINGS.aspectRatio;
        var windowSettings = _normalizeWindow(input.window);
        var layout = _normalizeLayout(input.layout);
        if (aspectRatio !== "16:9" && aspectRatio !== "9:16") {
            aspectRatio = DEFAULT_SETTINGS.aspectRatio;
        }
        return {
            apiKey: input.apiKey ? String(input.apiKey) : "",
            modelId: input.modelId ? String(input.modelId) : DEFAULT_SETTINGS.modelId,
            aspectRatio: aspectRatio,
            window: windowSettings,
            layout: layout
        };
    }

    function _clamp(value, min, max, fallback) {
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

    function _deepMerge(baseValue, patchValue) {
        var out = {};
        var key;

        if (!patchValue || typeof patchValue !== "object" || patchValue instanceof Array) {
            return patchValue;
        }

        if (!baseValue || typeof baseValue !== "object" || baseValue instanceof Array) {
            baseValue = {};
        }

        for (key in baseValue) {
            if (baseValue.hasOwnProperty(key)) {
                out[key] = baseValue[key];
            }
        }

        for (key in patchValue) {
            if (!patchValue.hasOwnProperty(key)) {
                continue;
            }
            if (patchValue[key] && typeof patchValue[key] === "object" && !(patchValue[key] instanceof Array)) {
                out[key] = _deepMerge(out[key], patchValue[key]);
            } else {
                out[key] = patchValue[key];
            }
        }

        return out;
    }

    function _normalizeWindow(windowCandidate) {
        var input = windowCandidate || {};
        var gallery = input.gallery || {};
        return {
            gallery: {
                width: _clamp(gallery.width, 860, 2800, DEFAULT_SETTINGS.window.gallery.width),
                height: _clamp(gallery.height, 620, 1800, DEFAULT_SETTINGS.window.gallery.height)
            }
        };
    }

    function _normalizeLayout(layoutCandidate) {
        var input = layoutCandidate || {};
        var gallery = input.gallery || {};
        var video = gallery.video || {};
        var image = gallery.image || {};
        var leftTop;
        var leftMid;
        var maxMid;

        leftTop = _clamp(image.leftTopRatio, 0.18, 0.65, DEFAULT_SETTINGS.layout.gallery.image.leftTopRatio);
        leftMid = _clamp(image.leftMidRatio, 0.14, 0.62, DEFAULT_SETTINGS.layout.gallery.image.leftMidRatio);
        maxMid = 0.82 - leftTop;
        if (leftMid > maxMid) {
            leftMid = maxMid;
        }
        if (leftMid < 0.14) {
            leftMid = 0.14;
        }

        return {
            gallery: {
                video: {
                    colRatio: _clamp(video.colRatio, 0.32, 0.76, DEFAULT_SETTINGS.layout.gallery.video.colRatio),
                    leftTopRatio: _clamp(video.leftTopRatio, 0.24, 0.72, DEFAULT_SETTINGS.layout.gallery.video.leftTopRatio),
                    rightTopRatio: _clamp(video.rightTopRatio, 0.35, 0.86, DEFAULT_SETTINGS.layout.gallery.video.rightTopRatio)
                },
                image: {
                    colRatio: _clamp(image.colRatio, 0.32, 0.76, DEFAULT_SETTINGS.layout.gallery.image.colRatio),
                    leftTopRatio: leftTop,
                    leftMidRatio: leftMid,
                    rightTopRatio: _clamp(image.rightTopRatio, 0.35, 0.86, DEFAULT_SETTINGS.layout.gallery.image.rightTopRatio)
                }
            }
        };
    }

    function loadSettings() {
        var filePath = _getSettingsFilePath();
        var raw;
        var parsed;

        if (!fs || !filePath) {
            return _clone(DEFAULT_SETTINGS);
        }

        try {
            if (!fs.existsSync(filePath)) {
                return _clone(DEFAULT_SETTINGS);
            }
        } catch (existsError) {
            return _clone(DEFAULT_SETTINGS);
        }

        try {
            raw = fs.readFileSync(filePath, "utf8");
            parsed = raw ? JSON.parse(raw) : {};
            return _normalize(parsed);
        } catch (error) {
            return _clone(DEFAULT_SETTINGS);
        }
    }

    function saveSettings(patch) {
        patch = patch || {};
        var current = loadSettings();
        var mergedLayout = typeof patch.layout !== "undefined" ? _deepMerge(current.layout, patch.layout) : current.layout;
        var mergedWindow = typeof patch.window !== "undefined" ? _deepMerge(current.window, patch.window) : current.window;
        var next = _normalize({
            apiKey: typeof patch.apiKey !== "undefined" ? patch.apiKey : current.apiKey,
            modelId: typeof patch.modelId !== "undefined" ? patch.modelId : current.modelId,
            aspectRatio: typeof patch.aspectRatio !== "undefined" ? patch.aspectRatio : current.aspectRatio,
            window: mergedWindow,
            layout: mergedLayout
        });
        var filePath = _getSettingsFilePath();
        var dirPath;

        if (!fs || !path || !filePath) {
            return _clone(next);
        }

        dirPath = path.dirname(filePath);
        if (!_ensureDirRecursive(dirPath)) {
            return _clone(next);
        }

        try {
            fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
        } catch (error) {
            return _clone(next);
        }

        return _clone(next);
    }

    fs = _safeRequire("fs");
    path = _safeRequire("path");
    os = _safeRequire("os");

    global.VeoBridgeSettings = {
        loadSettings: loadSettings,
        saveSettings: saveSettings
    };
}(window));
