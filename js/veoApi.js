(function (global) {
    "use strict";

    var API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";
    var DEFAULT_MODEL_ID = "veo-3.1-generate-preview";
    var DEFAULT_IMAGE_MODEL_ID = "gemini-3.1-flash-image-preview";
    var MODEL_OPTIONS = {
        "veo-3.1-generate-preview": "veo-3.1-generate-preview",
        "veo-3.1-fast-generate-preview": "veo-3.1-fast-generate-preview",
        "veo-3.0-generate-001": "veo-3.0-generate-001",
        "veo-3.0-fast-generate-001": "veo-3.0-fast-generate-001",
        "veo-2.0-generate-001": "veo-2.0-generate-001"
    };
    var IMAGE_MODEL_OPTIONS = {
        "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
        "gemini-2.5-flash-image": "gemini-2.5-flash-image"
    };
    var DEFAULT_PREDICT_URL = API_BASE_URL + DEFAULT_MODEL_ID + ":predictLongRunning";
    var DEFAULT_IMAGE_GENERATE_URL = API_BASE_URL + DEFAULT_IMAGE_MODEL_ID + ":generateContent";
    var DEFAULT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;
    var DEFAULT_OPERATION_POLL_INTERVAL_MS = 3000;
    var DEFAULT_MAX_REDIRECTS = 8;
    var DEFAULT_ALLOW_TEXT_ONLY_FALLBACK = true;
    var DEFAULT_VIDEO_MODE = "interpolation";
    var VIDEO_MODE_OPTIONS = {
        "text": "text",
        "image": "image",
        "interpolation": "interpolation",
        "reference": "reference"
    };
    var MAX_IMAGE_REFERENCE_INPUTS = 14;
    var MAX_VIDEO_REFERENCE_INPUTS = 3;
    var TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0hY9sAAAAASUVORK5CYII=";

    var fs = null;
    var path = null;
    var os = null;
    var http = null;
    var https = null;
    var nodeUrl = null;

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

    function _isHttpUrl(value) {
        return typeof value === "string" && /^https?:\/\//i.test(value);
    }

    function _normalizeModelId(modelId) {
        var id = String(modelId || "").replace(/^\s+|\s+$/g, "");
        if (!id) {
            return DEFAULT_MODEL_ID;
        }
        if (MODEL_OPTIONS[id]) {
            return MODEL_OPTIONS[id];
        }
        return id;
    }

    function _normalizeImageModelId(modelId) {
        var id = String(modelId || "").replace(/^\s+|\s+$/g, "");
        if (!id) {
            return DEFAULT_IMAGE_MODEL_ID;
        }
        if (IMAGE_MODEL_OPTIONS[id]) {
            return IMAGE_MODEL_OPTIONS[id];
        }
        return id;
    }

    function _normalizeImageAspectRatio(value) {
        var raw = String(value || "").replace(/^\s+|\s+$/g, "");
        if (raw === "9:16" || raw === "1:1") {
            return raw;
        }
        return "16:9";
    }

    function _normalizeImageSize(value) {
        var raw = String(value || "").replace(/^\s+|\s+$/g, "").toUpperCase();
        if (raw === "2K" || raw === "4K") {
            return raw;
        }
        return "1K";
    }

    function _normalizeAspectRatio(value) {
        var raw = String(value || "").replace(/^\s+|\s+$/g, "");
        if (raw === "9:16") {
            return "9:16";
        }
        return "16:9";
    }

    function _normalizeVideoMode(value) {
        var raw = String(value || "").replace(/^\s+|\s+$/g, "");
        if (VIDEO_MODE_OPTIONS[raw]) {
            return VIDEO_MODE_OPTIONS[raw];
        }
        return DEFAULT_VIDEO_MODE;
    }

    function _normalizeDurationSeconds(value) {
        var num = parseInt(value, 10);
        if (num === 4 || num === 6 || num === 8) {
            return num;
        }
        return 8;
    }

    function _normalizeResolution(value) {
        var raw = String(value || "").replace(/^\s+|\s+$/g, "").toLowerCase();
        if (raw === "1080p" || raw === "4k") {
            return raw;
        }
        return "720p";
    }

    function _getPredictUrlForModel(modelId) {
        var normalizedModel = _normalizeModelId(modelId);
        return API_BASE_URL + normalizedModel + ":predictLongRunning";
    }

    function _getImageGenerateUrlForModel(modelId) {
        var normalizedModel = _normalizeImageModelId(modelId);
        return API_BASE_URL + normalizedModel + ":generateContent";
    }

    function _toFileUrl(fsPath) {
        var normalized = String(fsPath || "").replace(/\\/g, "/");
        if (normalized.charAt(0) !== "/") {
            normalized = "/" + normalized;
        }
        return "file://" + encodeURI(normalized);
    }

    function _stripDataPrefix(dataUrl) {
        return String(dataUrl || "").replace(/^data:[^;]+;base64,/, "");
    }

    function _collapseWhitespace(value) {
        return String(value || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    }

    function _truncate(value, maxLength) {
        var text = String(value || "");
        var limit = typeof maxLength === "number" && maxLength > 0 ? maxLength : 240;
        if (text.length <= limit) {
            return text;
        }
        return text.substring(0, limit) + "...";
    }

    function _createHttpError(statusCode, requestUrl, details) {
        var message = "HTTP " + statusCode + " at " + requestUrl;
        var err;

        if (details) {
            message += ": " + details;
        }

        err = new Error(message);
        err.code = "HTTP_ERROR";
        err.statusCode = statusCode;
        err.url = requestUrl;
        if (details) {
            err.details = details;
        }

        return err;
    }

    function _getErrorMessage(error) {
        if (!error) {
            return "";
        }
        if (error.message) {
            return String(error.message);
        }
        return String(error);
    }

    function _isInlineDataUnsupportedError(error) {
        var message = _getErrorMessage(error);
        if (/(inlineData|bytesBase64Encoded)/i.test(message) && /(isn'?t supported|not supported)/i.test(message)) {
            return true;
        }
        return /image-conditioned/i.test(message) && /(not supported|unsupported)/i.test(message);
    }

    function _isUnsupportedVideoRequestError(error) {
        var message = _getErrorMessage(error);
        return /Unsupported video generation request/i.test(message);
    }

    function _isProbeImageProcessingError(error) {
        var message = _getErrorMessage(error);
        return /Unable to process input image/i.test(message) ||
            /invalid image/i.test(message) ||
            /cannot decode image/i.test(message);
    }

    function _ensureDirRecursive(dirPath) {
        var parent;

        if (!fs || !path) {
            throw new Error("Node fs/path are unavailable.");
        }

        if (fs.existsSync(dirPath)) {
            return;
        }

        parent = path.dirname(dirPath);
        if (parent && parent !== dirPath && !fs.existsSync(parent)) {
            _ensureDirRecursive(parent);
        }

        fs.mkdirSync(dirPath);
    }

    function _resolveUserDataDir() {
        var env;
        var home;
        var platform;

        if (!path || !os || typeof process === "undefined") {
            return null;
        }

        env = process.env || {};
        home = os.homedir ? os.homedir() : env.HOME;
        platform = process.platform;

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

    function _resolveVideosDir() {
        var userDataDir = _resolveUserDataDir();
        if (!userDataDir || !path) {
            return null;
        }
        return path.join(userDataDir, "VeoBridge", "videos");
    }

    function _resolveImagesDir() {
        var userDataDir = _resolveUserDataDir();
        if (!userDataDir || !path) {
            return null;
        }
        return path.join(userDataDir, "VeoBridge", "images");
    }

    function _bufferFromString(value) {
        if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
            return Buffer.from(String(value), "utf8");
        }
        return String(value);
    }

    function _requestWithRedirect(requestUrl, options, redirectCount) {
        var currentRedirects = typeof redirectCount === "number" ? redirectCount : 0;
        var requestOptions = options || {};

        return new Promise(function (resolve, reject) {
            var parsedUrl;
            var client;
            var req;

            if (!_isHttpUrl(requestUrl)) {
                reject(new Error("Invalid URL: " + String(requestUrl)));
                return;
            }

            if (!http || !https || !nodeUrl) {
                reject(new Error("Node networking modules are unavailable."));
                return;
            }

            parsedUrl = nodeUrl.parse(requestUrl);
            client = parsedUrl.protocol === "http:" ? http : https;

            req = client.request({
                protocol: parsedUrl.protocol,
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.path,
                method: requestOptions.method || "GET",
                headers: requestOptions.headers || {}
            }, function (res) {
                var chunks = [];
                var locationHeader = res.headers && res.headers.location;
                var statusCode = res.statusCode || 0;

                if (statusCode >= 300 && statusCode < 400 && locationHeader) {
                    var nextUrl = nodeUrl.resolve(requestUrl, locationHeader);
                    if (currentRedirects >= DEFAULT_MAX_REDIRECTS) {
                        reject(new Error("Too many redirects while requesting: " + requestUrl));
                        return;
                    }

                    _requestWithRedirect(nextUrl, requestOptions, currentRedirects + 1)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                res.on("data", function (chunk) {
                    chunks.push(chunk);
                });

                res.on("end", function () {
                    var body = typeof Buffer !== "undefined" && Buffer && typeof Buffer.concat === "function"
                        ? Buffer.concat(chunks)
                        : chunks.join("");

                    resolve({
                        statusCode: statusCode,
                        headers: res.headers || {},
                        body: body,
                        url: requestUrl
                    });
                });
            });

            req.on("error", function (error) {
                reject(error);
            });

            if (requestOptions.body) {
                req.write(requestOptions.body);
            }
            req.end();
        });
    }

    function _requestJson(requestUrl, options) {
        return _requestWithRedirect(requestUrl, options).then(function (response) {
            var text = response.body && response.body.toString ? response.body.toString("utf8") : String(response.body || "");
            var payload = null;
            var detailText = "";
            var errorNode;

            try {
                payload = text ? JSON.parse(text) : {};
            } catch (error) {
                payload = null;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                errorNode = payload && payload.error ? payload.error : null;
                if (errorNode) {
                    if (typeof errorNode === "string") {
                        detailText = errorNode;
                    } else if (typeof errorNode.message === "string") {
                        detailText = errorNode.message;
                    } else {
                        detailText = JSON.stringify(errorNode);
                    }
                } else if (text) {
                    detailText = _truncate(_collapseWhitespace(text), 320);
                }

                throw _createHttpError(response.statusCode, requestUrl, detailText);
            }

            if (!payload) {
                throw new Error("Invalid JSON response from " + requestUrl);
            }

            return payload;
        });
    }

    function _extractVersionBase(predictUrl) {
        var parsed;
        var match;
        var pathname;

        if (!nodeUrl) {
            return null;
        }

        parsed = nodeUrl.parse(predictUrl);
        if (!parsed || !parsed.protocol || !parsed.host) {
            return null;
        }

        pathname = parsed.pathname || "";
        match = pathname.match(/(\/v[0-9]+(?:beta[0-9]*)?)/i);
        if (!match) {
            return parsed.protocol + "//" + parsed.host;
        }

        return parsed.protocol + "//" + parsed.host + match[1];
    }

    function _resolveOperationUrl(predictUrl, operationNameOrUrl) {
        var value = String(operationNameOrUrl || "");
        var versionBase;
        var originBase;

        if (_isHttpUrl(value)) {
            return value;
        }

        versionBase = _extractVersionBase(predictUrl);
        if (!versionBase) {
            throw new Error("Unable to resolve operation URL.");
        }
        originBase = versionBase.replace(/\/v[0-9]+(?:beta[0-9]*)?$/i, "");

        if (value.indexOf("/") === 0) {
            return originBase + value;
        }

        if (/^v[0-9]+/i.test(value)) {
            return originBase + "/" + value;
        }

        if (value.indexOf("operations/") === 0) {
            return versionBase + "/" + value;
        }

        if (value.indexOf("/operations/") !== -1) {
            return versionBase + "/" + value;
        }

        return versionBase + "/operations/" + value;
    }

    function _sleep(ms) {
        return new Promise(function (resolve) {
            global.setTimeout(resolve, ms);
        });
    }

    function _collectUris(node, results) {
        var key;
        var value;
        var i;
        var lowerKey;

        if (!node) {
            return;
        }

        if (node instanceof Array) {
            for (i = 0; i < node.length; i += 1) {
                _collectUris(node[i], results);
            }
            return;
        }

        if (typeof node !== "object") {
            return;
        }

        for (key in node) {
            if (!node.hasOwnProperty(key)) {
                continue;
            }
            value = node[key];
            lowerKey = String(key).toLowerCase();

            if (typeof value === "string" && lowerKey === "uri") {
                results.push(value);
                continue;
            }

            if (value && typeof value === "object") {
                _collectUris(value, results);
            }
        }
    }

    function _extractVideoUri(operationPayload) {
        var allUris = [];
        var i;
        var candidate;
        var lower;

        _collectUris(operationPayload, allUris);

        for (i = 0; i < allUris.length; i += 1) {
            candidate = allUris[i];
            lower = String(candidate).toLowerCase();

            if (_isHttpUrl(candidate) && (lower.indexOf(".mp4") !== -1 || lower.indexOf("video") !== -1)) {
                return candidate;
            }
        }

        for (i = 0; i < allUris.length; i += 1) {
            candidate = allUris[i];
            if (_isHttpUrl(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    function _normalizeProgressPercent(value) {
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

    function _extractOperationProgressPercent(operationPayload) {
        var metadata = operationPayload && operationPayload.metadata ? operationPayload.metadata : null;
        var candidates;
        var i;
        var direct;
        var found = null;

        candidates = [
            metadata && metadata.progressPercent,
            metadata && metadata.progress_percent,
            metadata && metadata.completionPercent,
            metadata && metadata.percentComplete,
            metadata && metadata.progress && metadata.progress.percent,
            metadata && metadata.progress && metadata.progress.percentComplete
        ];

        for (i = 0; i < candidates.length; i += 1) {
            direct = _normalizeProgressPercent(candidates[i]);
            if (direct !== null) {
                return direct;
            }
        }

        function scan(node, depth) {
            var key;
            var value;
            var lowerKey;
            var nested;

            if (found !== null || !node || depth > 6) {
                return;
            }

            if (node instanceof Array) {
                for (var idx = 0; idx < node.length; idx += 1) {
                    scan(node[idx], depth + 1);
                    if (found !== null) {
                        return;
                    }
                }
                return;
            }

            if (typeof node !== "object") {
                return;
            }

            for (key in node) {
                if (!node.hasOwnProperty(key)) {
                    continue;
                }
                value = node[key];
                lowerKey = String(key).toLowerCase();

                if (lowerKey === "progresspercent" || lowerKey === "progress_percent" || lowerKey === "completionpercent" || lowerKey === "percentcomplete" || lowerKey === "percent") {
                    nested = _normalizeProgressPercent(value);
                    if (nested !== null) {
                        found = nested;
                        return;
                    }
                }

                if ((lowerKey.indexOf("progress") !== -1 || lowerKey.indexOf("percent") !== -1) && typeof value !== "object") {
                    nested = _normalizeProgressPercent(value);
                    if (nested !== null) {
                        found = nested;
                        return;
                    }
                }

                if (value && typeof value === "object") {
                    scan(value, depth + 1);
                    if (found !== null) {
                        return;
                    }
                }
            }
        }

        scan(metadata || operationPayload, 0);
        return found;
    }

    function _basenameFromUrl(fileUrl) {
        var parsed;
        var pathname;
        var base;

        if (!nodeUrl || !path) {
            return null;
        }

        try {
            parsed = nodeUrl.parse(fileUrl);
            pathname = parsed.pathname || "";
            base = path.basename(pathname);
            if (!base) {
                return null;
            }
            return decodeURIComponent(base);
        } catch (error) {
            return null;
        }
    }

    function _timestampString() {
        var d = new Date();
        function pad2(n) {
            return n < 10 ? "0" + n : String(n);
        }

        return String(d.getFullYear()) +
            pad2(d.getMonth() + 1) +
            pad2(d.getDate()) + "_" +
            pad2(d.getHours()) +
            pad2(d.getMinutes()) +
            pad2(d.getSeconds());
    }

    function _safeFileName(name) {
        return String(name || "video.mp4")
            .replace(/[\\\/:\*\?"<>\|]/g, "_")
            .replace(/\s+/g, "_");
    }

    function _buildPredictImagePayload(base64Data, mimeType) {
        return {
            bytesBase64Encoded: String(base64Data || ""),
            mimeType: String(mimeType || "image/png")
        };
    }

    function _buildPredictRequestBody(input) {
        var mode = _normalizeVideoMode(input.mode);
        var body = {
            instances: [{
                prompt: input.prompt
            }]
        };
        var normalizedAspectRatio = _normalizeAspectRatio(input.aspectRatio);
        var hasDuration = input.durationSeconds !== undefined && input.durationSeconds !== null;
        var hasResolution = input.resolution !== undefined && input.resolution !== null && String(input.resolution) !== "";
        var normalizedDuration = hasDuration ? _normalizeDurationSeconds(input.durationSeconds) : null;
        var normalizedResolution = hasResolution ? _normalizeResolution(input.resolution) : "";
        var i;
        var refItem;

        body.parameters = body.parameters || {};
        body.parameters.aspectRatio = normalizedAspectRatio;
        if (hasDuration) {
            body.parameters.durationSeconds = normalizedDuration;
        }
        if (hasResolution) {
            body.parameters.resolution = normalizedResolution;
        }

        if ((mode === "image" || mode === "interpolation") && input.startImageBase64) {
            body.instances[0].image = _buildPredictImagePayload(input.startImageBase64, input.mimeType);
        }

        if (mode === "interpolation" && input.endImageBase64) {
            body.instances[0].lastFrame = _buildPredictImagePayload(input.endImageBase64, input.mimeType);
        }

        if (mode === "reference" && input.references && input.references.length) {
            var referenceTarget;
            if (input.referenceInParameters) {
                body.parameters.referenceImages = [];
                referenceTarget = body.parameters.referenceImages;
            } else {
                body.instances[0].referenceImages = [];
                referenceTarget = body.instances[0].referenceImages;
            }
            for (i = 0; i < input.references.length; i += 1) {
                refItem = input.references[i];
                referenceTarget.push({
                    image: _buildPredictImagePayload(refItem.data, refItem.mimeType),
                    referenceType: "asset"
                });
            }
        }

        if (hasDuration && (mode === "reference" || normalizedResolution === "1080p" || normalizedResolution === "4k")) {
            body.parameters.durationSeconds = 8;
        }

        if (mode !== "text") {
            // Per Veo docs, image-based generation requires this value.
            body.parameters.personGeneration = "allow_adult";
        }

        return body;
    }

    function _guessImageMimeTypeFromPath(fsPath) {
        var lower = String(fsPath || "").toLowerCase();
        if (/\.jpe?g$/.test(lower)) {
            return "image/jpeg";
        }
        if (/\.webp$/.test(lower)) {
            return "image/webp";
        }
        return "image/png";
    }

    function _buildImageGenerateRequestBody(input, includeImageConfig, includeImageSize) {
        var parts = [];
        var i;
        var refItem;
        var body;

        parts.push({ text: input.prompt });

        for (i = 0; i < input.references.length; i += 1) {
            refItem = input.references[i];
            parts.push({
                inlineData: {
                    mimeType: refItem.mimeType,
                    data: refItem.data
                }
            });
        }

        body = {
            contents: [{
                role: "user",
                parts: parts
            }],
            generationConfig: {
                responseModalities: ["TEXT", "IMAGE"]
            }
        };

        if (includeImageConfig) {
            body.generationConfig.imageConfig = {
                aspectRatio: _normalizeImageAspectRatio(input.aspectRatio)
            };
            if (includeImageSize) {
                body.generationConfig.imageConfig.imageSize = _normalizeImageSize(input.imageSize);
            }
        }

        return body;
    }

    function _collectInlineImages(node, results) {
        var key;
        var value;
        var i;
        var lowerMime;

        if (!node) {
            return;
        }

        if (node instanceof Array) {
            for (i = 0; i < node.length; i += 1) {
                _collectInlineImages(node[i], results);
            }
            return;
        }

        if (typeof node !== "object") {
            return;
        }

        if (node.inlineData && typeof node.inlineData === "object" && typeof node.inlineData.data === "string") {
            lowerMime = String(node.inlineData.mimeType || "").toLowerCase();
            if (lowerMime.indexOf("image/") === 0) {
                results.push({
                    mimeType: node.inlineData.mimeType || "image/png",
                    data: node.inlineData.data
                });
            }
        }

        for (key in node) {
            if (!node.hasOwnProperty(key)) {
                continue;
            }
            value = node[key];
            if (value && typeof value === "object") {
                _collectInlineImages(value, results);
            }
        }
    }

    function _extractImageInlineData(generatePayload) {
        var images = [];
        _collectInlineImages(generatePayload, images);
        if (!images.length) {
            return null;
        }
        return images[0];
    }

    function _extensionFromMimeType(mimeType) {
        var lower = String(mimeType || "").toLowerCase();
        if (lower === "image/jpeg" || lower === "image/jpg") {
            return ".jpg";
        }
        if (lower === "image/webp") {
            return ".webp";
        }
        return ".png";
    }

    function _bufferFromBase64(value) {
        if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
            return Buffer.from(String(value || ""), "base64");
        }
        throw new Error("Base64 decoding requires Node Buffer support.");
    }

    function _saveGeneratedImage(base64Data, mimeType, preferredImagesDir) {
        var imagesDir = preferredImagesDir || _resolveImagesDir();
        var ext = _extensionFromMimeType(mimeType);
        var fileName = _safeFileName("img_" + _timestampString() + ext);
        var filePath;

        if (!imagesDir || !fs || !path) {
            return Promise.reject(new Error("Unable to resolve images directory."));
        }

        _ensureDirRecursive(imagesDir);
        filePath = path.join(imagesDir, fileName);

        if (fs.existsSync(filePath)) {
            filePath = path.join(imagesDir, _safeFileName("img_" + _timestampString() + "_" + String(Math.floor(Math.random() * 10000)) + ext));
        }

        fs.writeFileSync(filePath, _bufferFromBase64(base64Data));
        return Promise.resolve(filePath);
    }

    function _downloadToVideosDir(videoUri, apiKey, preferredVideosDir) {
        var videosDir = preferredVideosDir || _resolveVideosDir();
        var baseName;
        var finalName;
        var finalPath;
        var responseHeaders = {};

        if (!videosDir || !fs || !path) {
            return Promise.reject(new Error("Unable to resolve videos directory."));
        }

        _ensureDirRecursive(videosDir);

        baseName = _basenameFromUrl(videoUri) || ("veo_" + _timestampString() + ".mp4");
        baseName = _safeFileName(baseName);
        if (!/\.mp4$/i.test(baseName)) {
            baseName += ".mp4";
        }

        finalName = baseName;
        finalPath = path.join(videosDir, finalName);

        if (fs.existsSync(finalPath)) {
            finalName = baseName.replace(/\.mp4$/i, "") + "_" + _timestampString() + ".mp4";
            finalPath = path.join(videosDir, finalName);
        }

        if (apiKey) {
            responseHeaders["x-goog-api-key"] = apiKey;
        }

        return _requestWithRedirect(videoUri, {
            method: "GET",
            headers: responseHeaders
        }).then(function (response) {
            var text;
            var detail;

            if (response.statusCode < 200 || response.statusCode >= 300) {
                text = response.body && response.body.toString ? response.body.toString("utf8") : "";
                detail = text ? _truncate(_collapseWhitespace(text), 320) : "Download endpoint returned non-success status.";
                throw _createHttpError(response.statusCode, videoUri, detail);
            }

            fs.writeFileSync(finalPath, response.body);
            return finalPath;
        });
    }

    function downscaleToBase64(fsPath, maxSide, mimeType) {
        var targetMaxSide = typeof maxSide === "number" && maxSide > 0 ? maxSide : 1080;
        var outputMimeType = mimeType || "image/png";

        return new Promise(function (resolve, reject) {
            var img;
            var canvas;
            var ctx;
            var scale;
            var width;
            var height;
            var dataUrl;

            if (!fsPath) {
                reject(new Error("Image path is required."));
                return;
            }

            if (typeof Image === "undefined" || typeof document === "undefined") {
                reject(new Error("Image downscaling requires browser DOM APIs."));
                return;
            }

            img = new Image();
            img.onload = function () {
                width = img.naturalWidth || img.width;
                height = img.naturalHeight || img.height;

                if (!width || !height) {
                    reject(new Error("Image dimensions are invalid."));
                    return;
                }

                scale = Math.min(1, targetMaxSide / Math.max(width, height));
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));

                canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("Unable to create 2D canvas context."));
                    return;
                }

                ctx.drawImage(img, 0, 0, width, height);
                dataUrl = canvas.toDataURL(outputMimeType);
                resolve(_stripDataPrefix(dataUrl));
            };

            img.onerror = function () {
                reject(new Error("Failed to load image: " + fsPath));
            };

            img.src = _toFileUrl(fsPath);
        });
    }

    function generateVideo(input) {
        var options = input || {};
        var apiKey = options.apiKey;
        var prompt = options.prompt;
        var startShotPath = options.startShotPath;
        var endShotPath = options.endShotPath;
        var refsList = options.referenceImages || [];
        var modelId = _normalizeModelId(options.modelId || DEFAULT_MODEL_ID);
        var predictUrl = options.predictUrl || _getPredictUrlForModel(modelId);
        var pollIntervalMs = typeof options.pollIntervalMs === "number" ? options.pollIntervalMs : DEFAULT_OPERATION_POLL_INTERVAL_MS;
        var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_OPERATION_TIMEOUT_MS;
        var mode = _normalizeVideoMode(options.mode || DEFAULT_VIDEO_MODE);
        var mimeType = options.mimeType || _guessImageMimeTypeFromPath(startShotPath || endShotPath || "");
        var aspectRatio = _normalizeAspectRatio(options.aspectRatio || "16:9");
        var preferredVideosDir = options.videosDir ? String(options.videosDir) : "";
        var allowTextOnlyFallback = options.allowTextOnlyFallback;
        var emitStatus = typeof options.onStatus === "function" ? options.onStatus : function () {};
        var emitOperation = typeof options.onOperation === "function" ? options.onOperation : function () {};
        var resumeOperationName = options.resumeOperationName || options.operationName || null;
        var resumeOperationUrl = options.resumeOperationUrl || options.operationUrl || null;
        var startTime = new Date().getTime();
        var postHeaders;
        var operationName = null;
        var operationUrl = null;
        var lastOperationPayload = null;
        var requestMode = mode;
        var fallbackReason = null;
        var stage = "Uploading";
        var normalizedRefs = [];
        var hasResumeOperation = false;

        if (typeof allowTextOnlyFallback !== "boolean") {
            allowTextOnlyFallback = false;
        }

        if (!apiKey || !String(apiKey).replace(/^\s+|\s+$/g, "")) {
            return Promise.reject(new Error("API key is required."));
        }
        if (!prompt || !String(prompt).replace(/^\s+|\s+$/g, "")) {
            return Promise.reject(new Error("Prompt is required."));
        }
        if (!_isHttpUrl(predictUrl)) {
            return Promise.reject(new Error("predictUrl must be an absolute http(s) URL."));
        }
        hasResumeOperation = !!(resumeOperationName || resumeOperationUrl);

        if (hasResumeOperation) {
            try {
                if (!resumeOperationUrl && resumeOperationName) {
                    resumeOperationUrl = _resolveOperationUrl(predictUrl, resumeOperationName);
                } else if (resumeOperationUrl) {
                    resumeOperationUrl = _resolveOperationUrl(predictUrl, resumeOperationUrl);
                }
            } catch (resumeError) {
                return Promise.reject(resumeError);
            }
        } else {
            if (mode === "image" || mode === "interpolation") {
                if (!startShotPath) {
                    return Promise.reject(new Error("startShotPath is required for mode: " + mode + "."));
                }
            }
            if (mode === "interpolation" && !endShotPath) {
                return Promise.reject(new Error("endShotPath is required for interpolation mode."));
            }
            if (mode === "reference") {
                if (!(refsList instanceof Array) || !refsList.length) {
                    return Promise.reject(new Error("referenceImages is required for reference mode."));
                }
                if (refsList.length > MAX_VIDEO_REFERENCE_INPUTS) {
                    return Promise.reject(new Error("Too many reference images. Limit is " + MAX_VIDEO_REFERENCE_INPUTS + "."));
                }
            }
        }

        postHeaders = {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
        };

        function notifyOperation() {
            try {
                emitOperation({
                    operationName: operationName || null,
                    operationUrl: operationUrl || null,
                    mode: mode,
                    requestMode: requestMode || mode,
                    fallbackReason: fallbackReason || null
                });
            } catch (operationCallbackError) {
                // ignore callback errors
            }
        }

        function pollOperation() {
            var elapsedMs = new Date().getTime() - startTime;
            if (elapsedMs > timeoutMs) {
                throw new Error("Operation timed out after " + timeoutMs + "ms.");
            }

            return _requestJson(operationUrl, {
                method: "GET",
                headers: {
                    "x-goog-api-key": apiKey
                }
            }).then(function (operationPayload) {
                var operationError;
                var videoUri;
                var progressPercent;

                lastOperationPayload = operationPayload;
                if (!operationPayload.done) {
                    progressPercent = _extractOperationProgressPercent(operationPayload);
                    emitStatus("Polling", {
                        progressPercent: progressPercent
                    });
                    return _sleep(pollIntervalMs).then(pollOperation);
                }

                if (operationPayload.error) {
                    operationError = operationPayload.error.message || JSON.stringify(operationPayload.error);
                    throw new Error("Operation failed: " + operationError);
                }

                videoUri = _extractVideoUri(operationPayload);
                if (!videoUri) {
                    throw new Error("Operation completed but video.uri was not found.");
                }

                stage = "Downloading";
                emitStatus("Downloading", {
                    progressPercent: 96
                });
                return _downloadToVideosDir(videoUri, apiKey, preferredVideosDir).then(function (downloadedPath) {
                    return {
                        downloadedPath: downloadedPath,
                        videoUri: videoUri,
                        operationName: operationName,
                        operationUrl: operationUrl,
                        mode: mode,
                        requestMode: requestMode,
                        fallbackReason: fallbackReason,
                        operation: lastOperationPayload
                    };
                });
            });
        }

        function resumeFromOperation() {
            operationName = resumeOperationName || resumeOperationUrl || null;
            operationUrl = resumeOperationUrl;
            if (!operationUrl) {
                throw new Error("resumeOperationUrl is required to resume video operation.");
            }

            if (options.requestMode) {
                requestMode = String(options.requestMode);
            }
            if (options.fallbackReason) {
                fallbackReason = String(options.fallbackReason);
            }

            stage = "Polling";
            emitStatus("Polling", {
                progressPercent: 40
            });
            notifyOperation();
            return pollOperation();
        }

        emitStatus(hasResumeOperation ? "Polling" : "Uploading", {
            progressPercent: hasResumeOperation ? 40 : 8
        });

        function buildRefs() {
            var chain = Promise.resolve();
            var i;

            function pushRef(ref) {
                var refPath;
                var refMime;
                if (!ref) {
                    return Promise.resolve();
                }

                if (typeof ref === "string") {
                    refPath = ref;
                    refMime = _guessImageMimeTypeFromPath(refPath);
                } else {
                    refPath = ref.path || "";
                    refMime = ref.mimeType || _guessImageMimeTypeFromPath(refPath);
                }

                if (!refPath) {
                    return Promise.reject(new Error("Reference image path is required."));
                }

                return downscaleToBase64(refPath, 1080, refMime).then(function (base64Data) {
                    normalizedRefs.push({
                        mimeType: refMime,
                        data: base64Data
                    });
                });
            }

            for (i = 0; i < refsList.length; i += 1) {
                (function (refItem) {
                    chain = chain.then(function () {
                        return pushRef(refItem);
                    });
                }(refsList[i]));
            }

            return chain;
        }

        function postPredict(startBase64, endBase64, extra) {
            var opts = extra || {};
            var body = _buildPredictRequestBody({
                mode: mode,
                prompt: prompt,
                mimeType: mimeType,
                aspectRatio: aspectRatio,
                startImageBase64: startBase64,
                endImageBase64: endBase64,
                references: normalizedRefs,
                referenceInParameters: !!opts.referenceInParameters
            });

            return _requestJson(predictUrl, {
                method: "POST",
                headers: postHeaders,
                body: _bufferFromString(JSON.stringify(body))
            }).then(function (operationResponse) {
                requestMode = mode;
                fallbackReason = null;
                return operationResponse;
            }, function (uploadError) {
                var textOnlyBody;
                var fallbackReferenceBody;
                var canTryReferencePlacementFallback = mode === "reference" &&
                    !opts.referenceInParameters &&
                    (_isUnsupportedVideoRequestError(uploadError) || /referenceImages/i.test(_getErrorMessage(uploadError)));
                var shouldFallback = allowTextOnlyFallback &&
                    mode !== "text" &&
                    (_isInlineDataUnsupportedError(uploadError) || _isUnsupportedVideoRequestError(uploadError));

                if (canTryReferencePlacementFallback) {
                    emitStatus("Uploading (reference format fallback)", {
                        progressPercent: 12
                    });
                    fallbackReferenceBody = _buildPredictRequestBody({
                        mode: mode,
                        prompt: prompt,
                        mimeType: mimeType,
                        aspectRatio: aspectRatio,
                        startImageBase64: startBase64,
                        endImageBase64: endBase64,
                        references: normalizedRefs,
                        referenceInParameters: true
                    });
                    return _requestJson(predictUrl, {
                        method: "POST",
                        headers: postHeaders,
                        body: _bufferFromString(JSON.stringify(fallbackReferenceBody))
                    }).then(function (fallbackResponse) {
                        requestMode = "reference_fallback_parameters";
                        fallbackReason = _getErrorMessage(uploadError);
                        return fallbackResponse;
                    });
                }

                if (!shouldFallback) {
                    throw uploadError;
                }

                requestMode = "text_only_fallback";
                fallbackReason = _getErrorMessage(uploadError);
                emitStatus("Uploading (text-only fallback)", {
                    progressPercent: 12
                });

                textOnlyBody = _buildPredictRequestBody({
                    mode: "text",
                    prompt: prompt,
                    aspectRatio: aspectRatio
                });

                return _requestJson(predictUrl, {
                    method: "POST",
                    headers: postHeaders,
                    body: _bufferFromString(JSON.stringify(textOnlyBody))
                });
            });
        }

        function buildRequestAndPost() {
            if (mode === "text") {
                return postPredict(null, null);
            }
            if (mode === "reference") {
                return buildRefs().then(function () {
                    return postPredict(null, null);
                });
            }
            if (mode === "image") {
                return downscaleToBase64(startShotPath, 1080, mimeType).then(function (startBase64) {
                    return postPredict(startBase64, null);
                });
            }
            return downscaleToBase64(startShotPath, 1080, mimeType)
                .then(function (startBase64) {
                    return downscaleToBase64(endShotPath, 1080, mimeType)
                        .then(function (endBase64) {
                            return postPredict(startBase64, endBase64);
                        });
                });
        }
        return (hasResumeOperation ? Promise.resolve().then(resumeFromOperation) : buildRequestAndPost()
            .then(function (operationResponse) {
                operationName = operationResponse.name || operationResponse.operation || null;
                if (!operationName) {
                    throw new Error("predictLongRunning did not return operation name.");
                }

                operationUrl = _resolveOperationUrl(predictUrl, operationName);
                stage = "Polling";
                emitStatus("Polling", {
                    progressPercent: 40
                });
                notifyOperation();
                return pollOperation();
            }))
            .then(function (result) {
                return result;
            }, function (error) {
                var message = error && error.message ? error.message : String(error);
                if (/(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up)/i.test(message)) {
                    message = "Network error while contacting Gemini API. Check internet/VPN/firewall and retry.";
                }
                if (/lastFrame/i.test(message) && /(isn'?t supported|not supported)/i.test(message)) {
                    message = "Model doesn't support lastFrame. Switch to Veo 3.1 endpoint.";
                }
                if (/(inlineData|bytesBase64Encoded)/i.test(message) && /(isn'?t supported|not supported)/i.test(message)) {
                    message = "Your key/project doesn't support image-conditioned mode (first/last/reference images) for this model. Use Text mode or request Veo 3.1 image input access.";
                }
                if (/Unsupported video generation request/i.test(message)) {
                    message = "Unsupported video generation request. Verify Veo 3.1 endpoint and mode-specific fields (image/lastFrame/referenceImages).";
                }
                if (/referenceImages\.style/i.test(message) || (/referenceType/i.test(message) && /style/i.test(message))) {
                    message = "Veo 3.1 reference mode supports only referenceType='asset'. Remove style references or switch model.";
                }
                if (/referenceImages/i.test(message) && /(isn'?t supported|not supported)/i.test(message)) {
                    message = "Model/key doesn't support referenceImages for this endpoint. Try Image/Interpolation mode or use a project with reference image access.";
                }
                if (/HTTP 401/i.test(message)) {
                    message = "Unauthorized (401). Check API key value in Settings.";
                }
                if (/HTTP 403/i.test(message)) {
                    message = "Forbidden (403). API key/project has no access to this model or method.";
                }
                if (/HTTP 429/i.test(message)) {
                    message = "Rate limit reached (429). Wait and retry or reduce sample count.";
                }
                throw new Error(stage + " failed: " + message);
            });
    }

    function probeVideoCapabilities(input) {
        var options = input || {};
        var apiKey = options.apiKey;
        var modelId = _normalizeModelId(options.modelId || DEFAULT_MODEL_ID);
        var predictUrl = options.predictUrl || _getPredictUrlForModel(modelId);
        var headers;
        var textBody;
        var inlineBody;

        if (!apiKey || !String(apiKey).replace(/^\s+|\s+$/g, "")) {
            return Promise.reject(new Error("API key is required."));
        }
        if (!_isHttpUrl(predictUrl)) {
            return Promise.reject(new Error("predictUrl must be an absolute http(s) URL."));
        }

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
        };

        textBody = _buildPredictRequestBody({
            mode: "text",
            prompt: "capability probe",
            aspectRatio: "16:9"
        });

        inlineBody = _buildPredictRequestBody({
            mode: "interpolation",
            prompt: "capability probe",
            mimeType: "image/png",
            aspectRatio: "16:9",
            startImageBase64: TINY_PNG_BASE64,
            endImageBase64: TINY_PNG_BASE64
        });

        return _requestJson(predictUrl, {
            method: "POST",
            headers: headers,
            body: _bufferFromString(JSON.stringify(textBody))
        }).then(function () {
            return _requestJson(predictUrl, {
                method: "POST",
                headers: headers,
                body: _bufferFromString(JSON.stringify(inlineBody))
            }).then(function () {
                return {
                    ok: true,
                    textToVideo: true,
                    inlineData: true,
                    modelId: modelId
                };
            }, function (inlineError) {
                var inlineMessage = _getErrorMessage(inlineError);
                if (_isInlineDataUnsupportedError(inlineError) || _isUnsupportedVideoRequestError(inlineError)) {
                    return {
                        ok: true,
                        textToVideo: true,
                        inlineData: false,
                        modelId: modelId,
                        reason: inlineMessage
                    };
                }
                if (_isProbeImageProcessingError(inlineError)) {
                    return {
                        ok: true,
                        textToVideo: true,
                        inlineData: true,
                        modelId: modelId,
                        probeInconclusive: true,
                        reason: inlineMessage
                    };
                }
                throw inlineError;
            });
        });
    }

    function generateImage(input) {
        var options = input || {};
        var apiKey = options.apiKey;
        var prompt = options.prompt;
        var refs = options.referenceImages || [];
        var modelId = _normalizeImageModelId(options.modelId || DEFAULT_IMAGE_MODEL_ID);
        var requestUrl = options.requestUrl || _getImageGenerateUrlForModel(modelId);
        var aspectRatio = _normalizeImageAspectRatio(options.aspectRatio || "1:1");
        var imageSize = _normalizeImageSize(options.imageSize || "1K");
        var preferredImagesDir = options.imagesDir ? String(options.imagesDir) : "";
        var emitStatus = typeof options.onStatus === "function" ? options.onStatus : function () {};
        var stage = "Uploading";
        var refsList = refs instanceof Array ? refs.slice(0) : [];
        var normalizedRefs = [];

        if (!apiKey || !String(apiKey).replace(/^\s+|\s+$/g, "")) {
            return Promise.reject(new Error("API key is required."));
        }
        if (!prompt || !String(prompt).replace(/^\s+|\s+$/g, "")) {
            return Promise.reject(new Error("Prompt is required."));
        }
        if (!_isHttpUrl(requestUrl)) {
            return Promise.reject(new Error("requestUrl must be an absolute http(s) URL."));
        }
        if (refsList.length > MAX_IMAGE_REFERENCE_INPUTS) {
            return Promise.reject(new Error("Too many reference images. Limit is " + MAX_IMAGE_REFERENCE_INPUTS + "."));
        }

        emitStatus("Uploading", {
            progressPercent: 8
        });

        function buildRefs() {
            var chain = Promise.resolve();
            var i;

            function pushRef(ref) {
                var refPath;
                var refMime;
                if (!ref) {
                    return Promise.resolve();
                }

                if (typeof ref === "string") {
                    refPath = ref;
                    refMime = _guessImageMimeTypeFromPath(refPath);
                } else {
                    refPath = ref.path || "";
                    refMime = ref.mimeType || _guessImageMimeTypeFromPath(refPath);
                }

                if (!refPath) {
                    return Promise.reject(new Error("Reference image path is required."));
                }

                return downscaleToBase64(refPath, 1536, refMime).then(function (base64Data) {
                    normalizedRefs.push({
                        mimeType: refMime,
                        data: base64Data
                    });
                });
            }

            for (i = 0; i < refsList.length; i += 1) {
                (function (refItem) {
                    chain = chain.then(function () {
                        return pushRef(refItem);
                    });
                }(refsList[i]));
            }

            return chain;
        }

        function requestWithFallbacks() {
            var headers = {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey
            };

            function send(includeImageConfig, includeImageSize) {
                var body = _buildImageGenerateRequestBody({
                    prompt: prompt,
                    references: normalizedRefs,
                    aspectRatio: aspectRatio,
                    imageSize: imageSize
                }, includeImageConfig, includeImageSize);

                return _requestJson(requestUrl, {
                    method: "POST",
                    headers: headers,
                    body: _bufferFromString(JSON.stringify(body))
                });
            }

            stage = "Generating";
            emitStatus("Generating", {
                progressPercent: 44
            });

            return send(true, true).then(function (payload) {
                return payload;
            }, function (firstError) {
                var firstMessage = _getErrorMessage(firstError);
                if (!/imageConfig|imageSize|Unsupported|INVALID_ARGUMENT/i.test(firstMessage)) {
                    throw firstError;
                }
                return send(true, false).then(function (payload2) {
                    return payload2;
                }, function (secondError) {
                    var secondMessage = _getErrorMessage(secondError);
                    if (!/imageConfig|Unsupported|INVALID_ARGUMENT/i.test(secondMessage)) {
                        throw secondError;
                    }
                    return send(false, false);
                });
            });
        }

        return buildRefs()
            .then(function () {
                return requestWithFallbacks();
            })
            .then(function (payload) {
                var imageData;

                imageData = _extractImageInlineData(payload);
                if (!imageData || !imageData.data) {
                    throw new Error("Image response did not contain inlineData.");
                }

                stage = "Downloading";
                emitStatus("Downloading", {
                    progressPercent: 92
                });

                return _saveGeneratedImage(imageData.data, imageData.mimeType, preferredImagesDir).then(function (savedPath) {
                    return {
                        downloadedPath: savedPath,
                        path: savedPath,
                        mimeType: imageData.mimeType || "image/png",
                        modelId: modelId,
                        aspectRatio: aspectRatio,
                        imageSize: imageSize,
                        response: payload
                    };
                });
            })
            .then(null, function (error) {
                var message = _getErrorMessage(error);
                if (/(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up)/i.test(message)) {
                    message = "Network error while contacting Gemini API. Check internet/VPN/firewall and retry.";
                }
                if (/HTTP 401/i.test(message)) {
                    message = "Unauthorized (401). Check API key value in Settings.";
                }
                if (/HTTP 403/i.test(message)) {
                    message = "Forbidden (403). API key/project has no access to this image model or method.";
                }
                if (/HTTP 429/i.test(message)) {
                    message = "Rate limit reached (429). Wait and retry.";
                }
                if (/Image response did not contain inlineData/i.test(message)) {
                    message = "Model response did not include an image. Try another prompt or fewer reference images.";
                }
                throw new Error(stage + " failed: " + message);
            });
    }

    fs = _safeRequire("fs");
    path = _safeRequire("path");
    os = _safeRequire("os");
    http = _safeRequire("http");
    https = _safeRequire("https");
    nodeUrl = _safeRequire("url");

    global.VeoApi = {
        isConfigured: function (apiKey) {
            return !!(apiKey && String(apiKey).replace(/^\s+|\s+$/g, ""));
        },
        downscaleToBase64: downscaleToBase64,
        probeVideoCapabilities: probeVideoCapabilities,
        generateVideo: generateVideo,
        generateImage: generateImage,
        DEFAULT_PREDICT_URL: DEFAULT_PREDICT_URL,
        DEFAULT_IMAGE_GENERATE_URL: DEFAULT_IMAGE_GENERATE_URL,
        DEFAULT_MODEL_ID: DEFAULT_MODEL_ID,
        DEFAULT_IMAGE_MODEL_ID: DEFAULT_IMAGE_MODEL_ID,
        MODEL_OPTIONS: MODEL_OPTIONS,
        IMAGE_MODEL_OPTIONS: IMAGE_MODEL_OPTIONS,
        getPredictUrlForModel: _getPredictUrlForModel,
        getImageGenerateUrlForModel: _getImageGenerateUrlForModel
    };
}(window));
