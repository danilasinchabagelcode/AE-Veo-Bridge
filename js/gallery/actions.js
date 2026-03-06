(function (global) {
    "use strict";

    if (!global.VeoBridgeGalleryModules) {
        global.VeoBridgeGalleryModules = {};
    }

    var LOG_LIMIT = 800;

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

    function _timestampTag() {
        var now = new Date();
        function pad2(value) {
            return value < 10 ? "0" + String(value) : String(value);
        }
        return String(now.getFullYear()) +
            pad2(now.getMonth() + 1) +
            pad2(now.getDate()) + "_" +
            pad2(now.getHours()) +
            pad2(now.getMinutes()) +
            pad2(now.getSeconds());
    }

    function _resolveUserDataDir(path, os) {
        var env;
        var home;
        var platform;

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
            return env.APPDATA || path.join(home, "AppData", "Roaming");
        }
        if (platform === "darwin") {
            return path.join(home, "Library", "Application Support");
        }
        return env.XDG_CONFIG_HOME || path.join(home, ".config");
    }

    function _ensureDirRecursive(fs, path, dirPath) {
        var parentDir;
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
        parentDir = path.dirname(dirPath);
        if (parentDir && parentDir !== dirPath) {
            if (!_ensureDirRecursive(fs, path, parentDir)) {
                return false;
            }
        }
        try {
            fs.mkdirSync(dirPath);
            return true;
        } catch (mkdirError) {
            try {
                return fs.existsSync(dirPath);
            } catch (errorCheck) {
                return false;
            }
        }
    }

    function _removeDirRecursive(fs, path, dirPath) {
        var entries;
        var i;
        var child;
        var stats;

        if (!fs || !path || !dirPath) {
            return;
        }

        try {
            if (typeof fs.rmSync === "function") {
                fs.rmSync(dirPath, { recursive: true, force: true });
                return;
            }
        } catch (rmSyncError) {
            // Fallback below.
        }

        try {
            if (!fs.existsSync(dirPath)) {
                return;
            }
            entries = fs.readdirSync(dirPath);
        } catch (readError) {
            return;
        }

        for (i = 0; i < entries.length; i += 1) {
            child = path.join(dirPath, entries[i]);
            try {
                stats = fs.statSync(child);
            } catch (statError) {
                continue;
            }

            if (stats && stats.isDirectory && stats.isDirectory()) {
                _removeDirRecursive(fs, path, child);
                continue;
            }
            try {
                fs.unlinkSync(child);
            } catch (unlinkError) {
                // Continue best-effort cleanup.
            }
        }

        try {
            fs.rmdirSync(dirPath);
        } catch (rmdirError) {
            // Continue best-effort cleanup.
        }
    }

    function _writeJson(fs, filePath, data) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    }

    function _escapePowerShellLiteral(value) {
        return String(value || "").replace(/'/g, "''");
    }

    function _buildEnvironmentSnapshot() {
        var hostEnvironmentRaw = "";
        var hostEnvironment = null;

        if (global.__adobe_cep__ && typeof global.__adobe_cep__.getHostEnvironment === "function") {
            try {
                hostEnvironmentRaw = String(global.__adobe_cep__.getHostEnvironment() || "");
                hostEnvironment = hostEnvironmentRaw ? JSON.parse(hostEnvironmentRaw) : null;
            } catch (error) {
                hostEnvironment = null;
            }
        }

        return {
            capturedAt: (new Date()).toISOString(),
            locale: typeof navigator !== "undefined" ? navigator.language || "" : "",
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent || "" : "",
            platform: typeof navigator !== "undefined" ? navigator.platform || "" : "",
            process: (typeof process !== "undefined" && process) ? {
                platform: process.platform || "",
                arch: process.arch || "",
                versions: _cloneJson(process.versions || {}, {})
            } : null,
            hostEnvironment: hostEnvironment,
            hostEnvironmentRaw: hostEnvironmentRaw
        };
    }

    function create(options) {
        var opts = options || {};
        var getById = typeof opts.getById === "function" ? opts.getById : function () { return null; };
        var setStatus = typeof opts.setStatus === "function" ? opts.setStatus : function () {};
        var stateAdapter = opts.stateAdapter || null;
        var queueAdapter = opts.queueAdapter || null;
        var getLoadedSettings = typeof opts.getLoadedSettings === "function" ? opts.getLoadedSettings : function () { return null; };
        var getHostPaths = typeof opts.getHostPaths === "function" ? opts.getHostPaths : function () { return null; };
        var revealPathInExplorer = typeof opts.revealPathInExplorer === "function" ? opts.revealPathInExplorer : null;
        var fs = _safeRequire("fs");
        var path = _safeRequire("path");
        var os = _safeRequire("os");
        var childProcess = _safeRequire("child_process");
        var logs = [];

        function appendLog(level, message, payload) {
            var entry = {
                ts: (new Date()).toISOString(),
                level: String(level || "info"),
                message: String(message || ""),
                payload: payload ? _cloneJson(payload, null) : null
            };
            logs.push(entry);
            if (logs.length > LOG_LIMIT) {
                logs = logs.slice(logs.length - LOG_LIMIT);
            }
        }

        function getRecentLogs() {
            return _cloneJson(logs, []);
        }

        function openDiagnosticsModal() {
            var modal = getById("diagnosticsConfirmModal");
            if (!modal) {
                exportDiagnostics();
                return;
            }
            modal.hidden = false;
        }

        function closeDiagnosticsModal() {
            var modal = getById("diagnosticsConfirmModal");
            if (!modal) {
                return;
            }
            modal.hidden = true;
        }

        function createZipFromDirectory(sourceDir, targetZipPath) {
            var psCommand;
            var zipResult;
            if (!childProcess || !path || !fs || !sourceDir || !targetZipPath) {
                return false;
            }

            try {
                if (typeof fs.existsSync === "function" && fs.existsSync(targetZipPath)) {
                    fs.unlinkSync(targetZipPath);
                }
            } catch (unlinkError) {
                // Continue.
            }

            if (typeof process !== "undefined" && process && process.platform === "win32") {
                psCommand = "Compress-Archive -Path '" +
                    _escapePowerShellLiteral(path.join(sourceDir, "*")) +
                    "' -DestinationPath '" +
                    _escapePowerShellLiteral(targetZipPath) +
                    "' -Force";
                zipResult = childProcess.spawnSync("powershell.exe", [
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    psCommand
                ], {
                    windowsHide: true
                });
                return !zipResult.error && zipResult.status === 0 && fs.existsSync(targetZipPath);
            }

            zipResult = childProcess.spawnSync("zip", [
                "-r",
                "-q",
                targetZipPath,
                "."
            ], {
                cwd: sourceDir
            });
            return !zipResult.error && zipResult.status === 0 && fs.existsSync(targetZipPath);
        }

        function buildQueueSummary(stateSnapshot) {
            if (queueAdapter && typeof queueAdapter.buildDiagnosticsSummary === "function") {
                try {
                    return queueAdapter.buildDiagnosticsSummary(stateSnapshot || {});
                } catch (error) {
                    return null;
                }
            }
            return null;
        }

        function exportDiagnostics() {
            var userDataDir;
            var bridgeDir;
            var diagnosticsDir;
            var tag;
            var stagingDir;
            var zipPath;
            var stateSnapshot;
            var rawState;
            var parsedRawState;
            var settingsSnapshot;
            var envSnapshot;
            var queueSummary;
            var createdAt = (new Date()).toISOString();
            var manifest;
            var revealed;

            closeDiagnosticsModal();
            appendLog("info", "diagnostics.export.start", null);

            if (!fs || !path || !os || !childProcess) {
                setStatus("Diagnostics export is unavailable in this environment.", true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "NODE_MODULES_UNAVAILABLE"
                });
                return;
            }

            userDataDir = _resolveUserDataDir(path, os);
            if (!userDataDir) {
                setStatus("Diagnostics export failed: userData path is unavailable.", true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "USERDATA_UNAVAILABLE"
                });
                return;
            }

            bridgeDir = path.join(userDataDir, "VeoBridge");
            diagnosticsDir = path.join(bridgeDir, "diagnostics");
            if (!_ensureDirRecursive(fs, path, diagnosticsDir)) {
                setStatus("Diagnostics export failed: unable to create diagnostics folder.", true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "DIAG_DIR_CREATE_FAILED",
                    diagnosticsDir: diagnosticsDir
                });
                return;
            }

            tag = _timestampTag();
            stagingDir = path.join(diagnosticsDir, "_tmp_" + tag + "_" + String(Math.floor(Math.random() * 100000)));
            zipPath = path.join(diagnosticsDir, "veobridge_diagnostics_" + tag + ".zip");

            if (!_ensureDirRecursive(fs, path, stagingDir)) {
                setStatus("Diagnostics export failed: unable to create temp folder.", true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "STAGING_DIR_CREATE_FAILED",
                    stagingDir: stagingDir
                });
                return;
            }

            try {
                stateSnapshot = stateAdapter && typeof stateAdapter.getState === "function"
                    ? stateAdapter.getState()
                    : null;
                rawState = stateAdapter && typeof stateAdapter.readStateFileRaw === "function"
                    ? stateAdapter.readStateFileRaw()
                    : "";
                parsedRawState = null;
                if (rawState) {
                    try {
                        parsedRawState = JSON.parse(rawState);
                    } catch (parseStateError) {
                        parsedRawState = null;
                    }
                }

                settingsSnapshot = _cloneJson(getLoadedSettings() || {}, {});
                envSnapshot = _buildEnvironmentSnapshot();
                queueSummary = buildQueueSummary(stateSnapshot);
                manifest = {
                    name: "VeoBridge Diagnostics",
                    createdAt: createdAt,
                    version: "1.0.0",
                    includes: [
                        "manifest.json",
                        "environment.json",
                        "settings.json",
                        "state.snapshot.json",
                        "state.raw.json",
                        "queue.summary.json",
                        "logs.json"
                    ]
                };

                _writeJson(fs, path.join(stagingDir, "manifest.json"), manifest);
                _writeJson(fs, path.join(stagingDir, "environment.json"), {
                    environment: envSnapshot,
                    hostPaths: _cloneJson(getHostPaths() || null, null)
                });
                _writeJson(fs, path.join(stagingDir, "settings.json"), settingsSnapshot);
                _writeJson(fs, path.join(stagingDir, "state.snapshot.json"), _cloneJson(stateSnapshot, null));
                _writeJson(fs, path.join(stagingDir, "state.raw.json"), {
                    rawText: rawState || "",
                    parsed: parsedRawState
                });
                _writeJson(fs, path.join(stagingDir, "queue.summary.json"), _cloneJson(queueSummary, null));
                _writeJson(fs, path.join(stagingDir, "logs.json"), {
                    logs: getRecentLogs()
                });
            } catch (writeError) {
                _removeDirRecursive(fs, path, stagingDir);
                setStatus("Diagnostics export failed: " + String(writeError && writeError.message ? writeError.message : writeError), true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "WRITE_FAILED",
                    message: String(writeError)
                });
                return;
            }

            if (!createZipFromDirectory(stagingDir, zipPath)) {
                setStatus("Diagnostics export failed: unable to create zip archive.", true);
                appendLog("error", "diagnostics.export.failed", {
                    reason: "ZIP_FAILED",
                    stagingDir: stagingDir,
                    zipPath: zipPath
                });
                return;
            }

            _removeDirRecursive(fs, path, stagingDir);
            appendLog("info", "diagnostics.export.done", {
                zipPath: zipPath
            });

            revealed = false;
            if (revealPathInExplorer) {
                try {
                    revealed = !!revealPathInExplorer(zipPath);
                } catch (revealError) {
                    revealed = false;
                }
            }

            if (revealed) {
                setStatus("Diagnostics exported: " + zipPath, false);
            } else {
                setStatus("Diagnostics exported (open manually): " + zipPath, false);
            }
        }

        function bindUi() {
            var btnOpen = getById("btnDiagnostics");
            var btnCancel = getById("btnDiagnosticsCancel");
            var btnExport = getById("btnDiagnosticsExport");
            var modal = getById("diagnosticsConfirmModal");

            if (btnOpen) {
                btnOpen.addEventListener("click", openDiagnosticsModal);
            }
            if (btnCancel) {
                btnCancel.addEventListener("click", closeDiagnosticsModal);
            }
            if (btnExport) {
                btnExport.addEventListener("click", exportDiagnostics);
            }
            if (modal) {
                modal.addEventListener("click", function (event) {
                    if (event && event.target === modal) {
                        closeDiagnosticsModal();
                    }
                });
            }
        }

        return {
            bindUi: bindUi,
            appendLog: appendLog,
            getRecentLogs: getRecentLogs,
            openDiagnosticsModal: openDiagnosticsModal,
            closeDiagnosticsModal: closeDiagnosticsModal,
            exportDiagnostics: exportDiagnostics
        };
    }

    global.VeoBridgeGalleryModules.actions = {
        create: create
    };
}(window));
