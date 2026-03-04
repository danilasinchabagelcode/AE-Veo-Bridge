(function () {
    "use strict";

    if (!$.global.VeoBridgeHost) {
        $.global.VeoBridgeHost = {};
    }

    function _escapeJsonString(value) {
        var str = String(value);
        return str
            .replace(/\\/g, "\\\\")
            .replace(/"/g, "\\\"")
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t")
            .replace(/\f/g, "\\f")
            .replace(/\x08/g, "\\b");
    }

    function _jsonStringify(value) {
        var i;
        var out;
        var key;

        if (value === null) {
            return "null";
        }

        if (typeof JSON !== "undefined" && JSON && JSON.stringify) {
            try {
                return JSON.stringify(value);
            } catch (jsonError) {
                // Fall through to manual serializer.
            }
        }

        if (typeof value === "string") {
            return "\"" + _escapeJsonString(value) + "\"";
        }

        if (typeof value === "number") {
            if (isFinite(value)) {
                return String(value);
            }
            return "null";
        }

        if (typeof value === "boolean") {
            return value ? "true" : "false";
        }

        if (value instanceof Array) {
            out = [];
            for (i = 0; i < value.length; i += 1) {
                out.push(_jsonStringify(value[i]));
            }
            return "[" + out.join(",") + "]";
        }

        if (typeof value === "object") {
            out = [];
            for (key in value) {
                if (value.hasOwnProperty(key) && typeof value[key] !== "undefined") {
                    out.push("\"" + _escapeJsonString(key) + "\":" + _jsonStringify(value[key]));
                }
            }
            return "{" + out.join(",") + "}";
        }

        return "null";
    }

    function _makeResult(ok, data) {
        var result = { ok: !!ok };
        var key;

        if (data) {
            for (key in data) {
                if (data.hasOwnProperty(key)) {
                    result[key] = data[key];
                }
            }
        }

        return _jsonStringify(result);
    }

    function _makeError(code, message, extra) {
        var payload = {
            code: code || "UNKNOWN_ERROR",
            error: message || "Unexpected error."
        };
        var key;

        if (extra) {
            for (key in extra) {
                if (extra.hasOwnProperty(key)) {
                    payload[key] = extra[key];
                }
            }
        }

        return _makeResult(false, payload);
    }

    function _safeTrim(value) {
        return String(value).replace(/^\s+|\s+$/g, "");
    }

    function _joinPath(left, right) {
        var l = String(left);
        if (l.charAt(l.length - 1) === "/" || l.charAt(l.length - 1) === "\\") {
            return l + right;
        }
        return l + "/" + right;
    }

    function _ensureFolder(folderPath) {
        var folder = new Folder(folderPath);
        var parent;

        if (folder.exists) {
            return folder;
        }

        parent = folder.parent;
        if (parent && !parent.exists) {
            if (!_ensureFolder(parent.fsName)) {
                return null;
            }
        }

        if (!folder.create() && !folder.exists) {
            return null;
        }
        return folder;
    }

    function _sanitizeFileName(name) {
        return String(name)
            .replace(/[\\\/:\*\?"<>\|]/g, "_")
            .replace(/\s+/g, "_");
    }

    function _timestamp() {
        var d = new Date();
        function pad2(num) {
            return (num < 10 ? "0" : "") + num;
        }

        return String(d.getFullYear()) +
            pad2(d.getMonth() + 1) +
            pad2(d.getDate()) + "_" +
            pad2(d.getHours()) +
            pad2(d.getMinutes()) +
            pad2(d.getSeconds());
    }

    function _getActiveComp() {
        var item;
        if (!app || !app.project) {
            return null;
        }

        item = app.project.activeItem;
        try {
            if (item && (item instanceof CompItem)) {
                return item;
            }
        } catch (compError) {
            return null;
        }

        return null;
    }

    function _resolveDiskPaths() {
        var baseFolder;
        var bridgeFolder;
        var generatedFolder;
        var framesFolder;

        if (!app || !app.project) {
            return null;
        }

        if (app.project.file) {
            baseFolder = app.project.file.parent;
        } else {
            baseFolder = Folder.temp;
        }

        bridgeFolder = _ensureFolder(_joinPath(baseFolder.fsName, "VeoBridge"));
        if (!bridgeFolder) {
            return null;
        }

        generatedFolder = _ensureFolder(_joinPath(bridgeFolder.fsName, "Generated"));
        if (!generatedFolder) {
            return null;
        }

        framesFolder = _ensureFolder(_joinPath(bridgeFolder.fsName, "Frames"));
        if (!framesFolder) {
            return null;
        }

        return {
            baseDir: baseFolder.fsName,
            bridgeDir: bridgeFolder.fsName,
            generatedDir: generatedFolder.fsName,
            framesDir: framesFolder.fsName,
            projectSaved: !!app.project.file
        };
    }

    function _findChildFolder(parentFolder, folderName) {
        var i;
        var item;
        var items;

        if (!app || !app.project || !parentFolder) {
            return null;
        }

        items = app.project.items;
        for (i = 1; i <= items.length; i += 1) {
            item = items[i];
            try {
                if (item &&
                    (item instanceof FolderItem) &&
                    item.parentFolder === parentFolder &&
                    item.name === folderName) {
                    return item;
                }
            } catch (folderScanError) {
                // Ignore unsupported item comparisons.
            }
        }

        return null;
    }

    function _getOrCreateChildFolder(parentFolder, folderName) {
        var folder = _findChildFolder(parentFolder, folderName);

        if (folder) {
            return folder;
        }

        folder = app.project.items.addFolder(folderName);
        folder.parentFolder = parentFolder;
        return folder;
    }

    function _ensureProjectFolders() {
        var root;
        var veoFolder;
        var generatedFolder;

        if (!app || !app.project) {
            return null;
        }

        root = app.project.rootFolder;
        veoFolder = _getOrCreateChildFolder(root, "VeoBridge");
        generatedFolder = _getOrCreateChildFolder(veoFolder, "Generated");

        return {
            veoFolder: veoFolder,
            generatedFolder: generatedFolder
        };
    }

    function _normalizeIncomingPath(inputPath) {
        var path = _safeTrim(inputPath);

        if (path.indexOf("file:///") === 0) {
            path = path.substring(8);
        } else if (path.indexOf("file://") === 0) {
            path = path.substring(7);
        }

        try {
            path = decodeURI(path);
        } catch (decodeError) {
            // Keep original value when decode fails.
        }

        return path;
    }

    function _isMp4Path(path) {
        var normalized = String(path).toLowerCase();
        return normalized.length >= 4 && normalized.substring(normalized.length - 4) === ".mp4";
    }

    function _isImagePath(path) {
        var normalized = String(path).toLowerCase();
        return /\.(png|jpg|jpeg|webp)$/.test(normalized);
    }

    function _findNewestMp4InFolder(folderPath) {
        var folder = new Folder(folderPath);
        var entries;
        var newest = null;
        var i;
        var fileObj;

        if (!folder.exists) {
            return null;
        }

        try {
            entries = folder.getFiles("*.mp4");
        } catch (scanError) {
            return null;
        }

        for (i = 0; i < entries.length; i += 1) {
            fileObj = entries[i];
            if (!(fileObj instanceof File)) {
                continue;
            }
            if (!newest || fileObj.modified.getTime() > newest.modified.getTime()) {
                newest = fileObj;
            }
        }

        return newest;
    }

    function _findNewestImageInFolder(folderPath) {
        var folder = new Folder(folderPath);
        var entries;
        var newest = null;
        var i;
        var fileObj;

        if (!folder.exists) {
            return null;
        }

        try {
            entries = folder.getFiles();
        } catch (scanError) {
            return null;
        }

        for (i = 0; i < entries.length; i += 1) {
            fileObj = entries[i];
            if (!(fileObj instanceof File)) {
                continue;
            }
            if (!_isImagePath(fileObj.fsName)) {
                continue;
            }
            if (!newest || fileObj.modified.getTime() > newest.modified.getTime()) {
                newest = fileObj;
            }
        }

        return newest;
    }

    function _sleepMs(ms) {
        if (typeof $ !== "undefined" && $ && typeof $.sleep === "function") {
            $.sleep(ms);
        }
    }

    function _waitForFile(fileObj, timeoutMs) {
        var waited = 0;
        var step = 100;
        var maxWait = typeof timeoutMs === "number" ? timeoutMs : 800;

        while (waited < maxWait) {
            if (fileObj.exists) {
                return true;
            }
            _sleepMs(step);
            waited += step;
        }
        return fileObj.exists;
    }

    function _listPngFiles(folderPath) {
        var folder = new Folder(folderPath);
        var entries;
        var result = [];
        var i;

        if (!folder.exists) {
            return result;
        }

        try {
            entries = folder.getFiles("*.png");
        } catch (scanError) {
            return result;
        }

        for (i = 0; i < entries.length; i += 1) {
            if (entries[i] && (entries[i] instanceof File)) {
                result.push(entries[i]);
            }
        }
        return result;
    }

    function _findNewFile(beforeFiles, afterFiles) {
        var seen = {};
        var i;
        var f;

        for (i = 0; i < beforeFiles.length; i += 1) {
            f = beforeFiles[i];
            seen[f.fsName] = true;
        }

        for (i = 0; i < afterFiles.length; i += 1) {
            f = afterFiles[i];
            if (!seen[f.fsName]) {
                return f;
            }
        }

        return null;
    }

    function _attemptCaptureFrame(comp, targetFile) {
        var beforeFiles;
        var afterFiles;
        var discovered;
        var errors = [];

        beforeFiles = _listPngFiles(targetFile.parent.fsName);

        try {
            comp.saveFrameToPng(comp.time, targetFile.fsName);
        } catch (e1) {
            errors.push("fsName: " + String(e1));
        }
        if (_waitForFile(targetFile, 900)) {
            return { file: targetFile, details: errors.join(" | ") };
        }

        afterFiles = _listPngFiles(targetFile.parent.fsName);
        discovered = _findNewFile(beforeFiles, afterFiles);
        if (discovered) {
            return { file: discovered, details: errors.join(" | ") };
        }

        beforeFiles = afterFiles;
        try {
            comp.saveFrameToPng(comp.time, targetFile.absoluteURI);
        } catch (e2) {
            errors.push("absoluteURI: " + String(e2));
        }
        if (_waitForFile(targetFile, 900)) {
            return { file: targetFile, details: errors.join(" | ") };
        }

        afterFiles = _listPngFiles(targetFile.parent.fsName);
        discovered = _findNewFile(beforeFiles, afterFiles);
        if (discovered) {
            return { file: discovered, details: errors.join(" | ") };
        }

        beforeFiles = afterFiles;
        try {
            comp.saveFrameToPng(comp.time, targetFile);
        } catch (e3) {
            errors.push("fileObject: " + String(e3));
        }
        if (_waitForFile(targetFile, 900)) {
            return { file: targetFile, details: errors.join(" | ") };
        }

        afterFiles = _listPngFiles(targetFile.parent.fsName);
        discovered = _findNewFile(beforeFiles, afterFiles);
        if (discovered) {
            return { file: discovered, details: errors.join(" | ") };
        }

        return {
            file: null,
            details: errors.length ? errors.join(" | ") : "No PNG file detected after saveFrameToPng attempts."
        };
    }

    $.global.VeoBridgeHost.ping = function () {
        return "pong";
    };

    $.global.VeoBridge_getPaths = function () {
        var comp = _getActiveComp();
        var paths;

        if (!comp) {
            return _makeError("NO_ACTIVE_COMP", "Active composition is required.");
        }

        paths = _resolveDiskPaths();
        if (!paths) {
            return _makeError("PATH_INIT_FAILED", "Unable to prepare VeoBridge folders on disk.");
        }

        return _makeResult(true, {
            paths: paths,
            comp: {
                name: comp.name,
                time: comp.time,
                frameRate: comp.frameRate
            }
        });
    };

    $.global.VeoBridge_captureCurrentFrame = function () {
        var comp = _getActiveComp();
        var paths;
        var filename;
        var outputPath;
        var outputFile;
        var captureAttempt;
        var fallbackFramesFolder;
        var fallbackOutputPath;
        var fallbackOutputFile;
        var firstErrorDetails;
        var secondErrorDetails;
        var frameIndex;

        if (!comp) {
            return _makeError("NO_ACTIVE_COMP", "Active composition is required.");
        }

        paths = _resolveDiskPaths();
        if (!paths) {
            return _makeError("PATH_INIT_FAILED", "Unable to prepare VeoBridge folders on disk.");
        }

        filename = _sanitizeFileName(comp.name) + "_" + _timestamp() + ".png";
        outputPath = _joinPath(paths.framesDir, filename);
        outputFile = new File(outputPath);

        captureAttempt = _attemptCaptureFrame(comp, outputFile);
        if (captureAttempt.file) {
            outputFile = captureAttempt.file;
        } else {
            firstErrorDetails = captureAttempt.details;
            fallbackFramesFolder = _ensureFolder(_joinPath(_joinPath(Folder.temp.fsName, "VeoBridge"), "Frames"));

            if (!fallbackFramesFolder) {
                return _makeError("CAPTURE_FAILED", "Failed to capture frame.", {
                    details: firstErrorDetails
                });
            }

            fallbackOutputPath = _joinPath(fallbackFramesFolder.fsName, filename);
            fallbackOutputFile = new File(fallbackOutputPath);
            captureAttempt = _attemptCaptureFrame(comp, fallbackOutputFile);

            if (captureAttempt.file) {
                outputFile = captureAttempt.file;
            } else {
                secondErrorDetails = captureAttempt.details;
                return _makeError("CAPTURE_FAILED", "Failed to capture frame.", {
                    details: "Primary: " + firstErrorDetails + " | Fallback: " + secondErrorDetails
                });
            }
        }

        if (!outputFile.exists) {
            return _makeError("CAPTURE_NOT_FOUND", "Frame capture command completed, but output file was not found.", {
                path: outputFile.fsName,
                details: captureAttempt && captureAttempt.details ? captureAttempt.details : "Output file missing after capture."
            });
        }

        frameIndex = Math.round(comp.time * comp.frameRate);

        return _makeResult(true, {
            path: outputFile.fsName,
            name: outputFile.name,
            time: comp.time,
            frame: frameIndex,
            compName: comp.name,
            width: comp.width,
            height: comp.height
        });
    };

    $.global.VeoBridge_importVideo = function (path) {
        var normalizedPath;
        var file;
        var folderProbe;
        var newestMp4InFolder;
        var importOptions;
        var importedItem;
        var projectFolders;

        if (!app || !app.project) {
            return _makeError("NO_PROJECT", "After Effects project is not available.");
        }

        if (typeof path !== "string" || _safeTrim(path) === "") {
            return _makeError("INVALID_PATH", "Video path is required.");
        }

        normalizedPath = _normalizeIncomingPath(path);
        file = new File(normalizedPath);
        folderProbe = new Folder(normalizedPath);

        // Always prefer direct file import when a valid .mp4 file path is provided.
        if (file.exists && _isMp4Path(file.fsName)) {
            // Keep file as-is.
        } else if (folderProbe.exists) {
            newestMp4InFolder = _findNewestMp4InFolder(folderProbe.fsName);
            if (!newestMp4InFolder) {
                return _makeError("INVALID_FILE", "Expected a file path, but received a folder path without .mp4 files.", {
                    path: folderProbe.fsName
                });
            }
            file = newestMp4InFolder;
        } else if (_isMp4Path(normalizedPath) && !file.exists) {
            return _makeError("FILE_NOT_FOUND", "Video file not found.", {
                path: normalizedPath
            });
        } else if (!_isMp4Path(normalizedPath)) {
            return _makeError("INVALID_EXTENSION", "Only .mp4 files are supported.", {
                path: normalizedPath
            });
        } else {
            return _makeError("INVALID_PATH", "Unable to resolve import path as file or folder.", {
                path: normalizedPath
            });
        }

        projectFolders = _ensureProjectFolders();
        if (!projectFolders || !projectFolders.generatedFolder) {
            return _makeError("PROJECT_FOLDER_FAILED", "Unable to prepare VeoBridge/Generated folder in Project panel.");
        }

        try {
            importOptions = new ImportOptions(file);
        } catch (importOptionsError) {
            return _makeError("IMPORT_OPTIONS_FAILED", "Failed to create import options.", {
                details: String(importOptionsError)
            });
        }

        try {
            importedItem = app.project.importFile(importOptions);
        } catch (importError) {
            return _makeError("IMPORT_FAILED", "Failed to import video file.", {
                details: String(importError)
            });
        }

        if (!importedItem) {
            return _makeError("IMPORT_FAILED", "After Effects did not return an imported item.");
        }

        importedItem.parentFolder = projectFolders.generatedFolder;

        return _makeResult(true, {
            itemId: importedItem.id,
            itemName: importedItem.name,
            path: file.fsName,
            projectFolder: "VeoBridge/Generated"
        });
    };

    $.global.VeoBridge_importImage = function (path) {
        var normalizedPath;
        var file;
        var folderProbe;
        var newestImageInFolder;
        var importOptions;
        var importedItem;
        var projectFolders;

        if (!app || !app.project) {
            return _makeError("NO_PROJECT", "After Effects project is not available.");
        }

        if (typeof path !== "string" || _safeTrim(path) === "") {
            return _makeError("INVALID_PATH", "Image path is required.");
        }

        normalizedPath = _normalizeIncomingPath(path);
        file = new File(normalizedPath);
        folderProbe = new Folder(normalizedPath);

        if (file.exists && _isImagePath(file.fsName)) {
            // Keep file as-is.
        } else if (folderProbe.exists) {
            newestImageInFolder = _findNewestImageInFolder(folderProbe.fsName);
            if (!newestImageInFolder) {
                return _makeError("INVALID_FILE", "Expected an image file path, but received a folder path without supported images.", {
                    path: folderProbe.fsName
                });
            }
            file = newestImageInFolder;
        } else if (_isImagePath(normalizedPath) && !file.exists) {
            return _makeError("FILE_NOT_FOUND", "Image file not found.", {
                path: normalizedPath
            });
        } else if (!_isImagePath(normalizedPath)) {
            return _makeError("INVALID_EXTENSION", "Only .png, .jpg, .jpeg, .webp files are supported.", {
                path: normalizedPath
            });
        } else {
            return _makeError("INVALID_PATH", "Unable to resolve import path as file or folder.", {
                path: normalizedPath
            });
        }

        projectFolders = _ensureProjectFolders();
        if (!projectFolders || !projectFolders.generatedFolder) {
            return _makeError("PROJECT_FOLDER_FAILED", "Unable to prepare VeoBridge/Generated folder in Project panel.");
        }

        try {
            importOptions = new ImportOptions(file);
        } catch (importOptionsError) {
            return _makeError("IMPORT_OPTIONS_FAILED", "Failed to create import options.", {
                details: String(importOptionsError)
            });
        }

        try {
            importedItem = app.project.importFile(importOptions);
        } catch (importError) {
            return _makeError("IMPORT_FAILED", "Failed to import image file.", {
                details: String(importError)
            });
        }

        if (!importedItem) {
            return _makeError("IMPORT_FAILED", "After Effects did not return an imported item.");
        }

        importedItem.parentFolder = projectFolders.generatedFolder;

        return _makeResult(true, {
            itemId: importedItem.id,
            itemName: importedItem.name,
            path: file.fsName,
            projectFolder: "VeoBridge/Generated"
        });
    };
}());
