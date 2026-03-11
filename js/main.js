(function () {
    "use strict";

    var STORAGE_KEY_API_KEY = "veobridge.apiKey";
    var cs = null;
    var isCapturing = false;
    var galleryWindowRef = null;
    var isGalleryOpening = false;
    var galleryOpeningTimer = null;

    function getById(id) {
        return document.getElementById(id);
    }

    function setStatus(text, isError) {
        var status = getById("statusLine");
        if (!status) {
            return;
        }
        status.textContent = text;
        status.className = isError ? "status-line is-error" : "status-line";
    }

    function ensureCs() {
        if (!cs && window.CSInterfaceLite) {
            cs = new window.CSInterfaceLite();
        }
        return cs;
    }

    function readHostEnvironment() {
        var cep = window.__adobe_cep__;
        var raw;

        if (!cep || typeof cep.getHostEnvironment !== "function") {
            return null;
        }

        try {
            raw = cep.getHostEnvironment();
            if (!raw) {
                return null;
            }
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    function getHostOsFamily() {
        var cep = window.__adobe_cep__;
        var osInfo = "";
        var navPlatform = "";
        var navUserAgent = "";

        if (cep && typeof cep.getOSInformation === "function") {
            try {
                osInfo = String(cep.getOSInformation() || "").toLowerCase();
            } catch (osInfoError) {
                osInfo = "";
            }
        }

        if (osInfo.indexOf("windows") >= 0 || osInfo.indexOf("win") >= 0) {
            return "win";
        }
        if (osInfo.indexOf("mac") >= 0 || osInfo.indexOf("darwin") >= 0 || osInfo.indexOf("os x") >= 0) {
            return "mac";
        }

        if (typeof navigator !== "undefined" && navigator) {
            if (navigator.platform) {
                navPlatform = String(navigator.platform).toLowerCase();
            }
            if (navigator.userAgent) {
                navUserAgent = String(navigator.userAgent).toLowerCase();
            }
        }

        if (navPlatform.indexOf("win") >= 0 || navUserAgent.indexOf("windows") >= 0) {
            return "win";
        }
        if (navPlatform.indexOf("mac") >= 0 || navUserAgent.indexOf("mac") >= 0) {
            return "mac";
        }

        return "other";
    }

    function getGalleryOpenStrategyHint(osFamily) {
        if (osFamily === "mac") {
            return "mac:requestOpenExtension";
        }
        if (osFamily === "win") {
            return "win:requestOpenExtension";
        }
        return "other:window.open";
    }

    function withOpenDebug(text, strategy) {
        var label = String(strategy || "");
        if (!label) {
            return text;
        }
        return text + " [open:" + label + "]";
    }

    function beginGalleryOpenAttempt() {
        if (isGalleryOpening) {
            return false;
        }
        isGalleryOpening = true;
        if (galleryOpeningTimer && typeof window.clearTimeout === "function") {
            window.clearTimeout(galleryOpeningTimer);
            galleryOpeningTimer = null;
        }
        if (typeof window.setTimeout === "function") {
            galleryOpeningTimer = window.setTimeout(function () {
                isGalleryOpening = false;
                galleryOpeningTimer = null;
            }, 800);
        }
        return true;
    }

    function endGalleryOpenAttempt() {
        isGalleryOpening = false;
        if (galleryOpeningTimer && typeof window.clearTimeout === "function") {
            window.clearTimeout(galleryOpeningTimer);
            galleryOpeningTimer = null;
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

    function baseName(filePath) {
        var normalized = String(filePath || "").replace(/\\/g, "/");
        var parts = normalized.split("/");
        return parts.length ? parts[parts.length - 1] : normalized;
    }

    function generateShotId() {
        return "shot_" + String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 100000));
    }

    function buildShotFromCapture(captureResult) {
        var now = new Date();
        var payload = captureResult || {};

        return {
            id: generateShotId(),
            path: payload.path || null,
            compName: payload.compName || null,
            frame: typeof payload.frame === "number" ? payload.frame : (typeof payload.time === "number" ? payload.time : null),
            createdAt: now.toISOString ? now.toISOString() : String(now),
            width: typeof payload.width === "number" ? payload.width : null,
            height: typeof payload.height === "number" ? payload.height : null
        };
    }

    function onCaptureClick() {
        var stateApi = window.VeoBridgeState;

        if (isCapturing) {
            setStatus("Capture is already running.", true);
            return;
        }

        if (!stateApi || typeof stateApi.getState !== "function" || typeof stateApi.updateState !== "function") {
            setStatus("State storage is unavailable. Reload extension.", true);
            return;
        }

        isCapturing = true;
        setStatus("Capturing current frame...", false);

        callHost("VeoBridge_captureCurrentFrame()", function (error, payload) {
            var state;
            var shots;
            var shot;

            isCapturing = false;

            if (error) {
                setStatus("Capture failed: " + error.message, true);
                return;
            }

            if (!payload || !payload.path) {
                setStatus("Capture failed: host returned no file path.", true);
                return;
            }

            shot = buildShotFromCapture(payload);
            state = stateApi.getState();
            shots = state.shots ? state.shots.slice(0) : [];
            shots.push(shot);

            stateApi.updateState({
                shots: shots,
                selectedShotId: shot.id
            });

            setStatus("Captured: " + (shot.path ? baseName(shot.path) : shot.id), false);
        });
    }

    function openGalleryWindow() {
        var opened = false;
        var popup = null;
        var bridge = ensureCs();
        var galleryWidth = 1180;
        var galleryHeight = 820;
        var galleryUrl = "gallery.html";
        var settings;
        var features;
        var osFamily = getHostOsFamily();
        var primaryStrategy = getGalleryOpenStrategyHint(osFamily);
        var usedStrategy = "";

        if (!beginGalleryOpenAttempt()) {
            setStatus(withOpenDebug("Opening Gallery...", primaryStrategy), false);
            return;
        }

        if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.loadSettings === "function") {
            try {
                settings = window.VeoBridgeSettings.loadSettings();
                if (settings && settings.window && settings.window.gallery) {
                    if (settings.window.gallery.width) {
                        galleryWidth = parseInt(settings.window.gallery.width, 10) || galleryWidth;
                    }
                    if (settings.window.gallery.height) {
                        galleryHeight = parseInt(settings.window.gallery.height, 10) || galleryHeight;
                    }
                }
            } catch (settingsError) {
                // ignore and use defaults
            }
        }

        if (galleryWidth < 860) {
            galleryWidth = 860;
        }
        if (galleryHeight < 620) {
            galleryHeight = 620;
        }
        features = "width=" + galleryWidth + ",height=" + galleryHeight + ",resizable=yes,scrollbars=yes";
        try {
            if (window.location && window.location.href) {
                galleryUrl = String(window.location.href).replace(/index\.html(?:[?#].*)?$/i, "gallery.html");
            }
        } catch (urlError) {
            galleryUrl = "gallery.html";
        }
        if (!galleryUrl) {
            galleryUrl = "gallery.html";
        }

        if (galleryWindowRef && !galleryWindowRef.closed) {
            popup = galleryWindowRef;
            opened = true;
            usedStrategy = "existing-window";
            try {
                if (typeof popup.resizeTo === "function") {
                    popup.resizeTo(galleryWidth, galleryHeight);
                }
                if (typeof popup.focus === "function") {
                    popup.focus();
                }
            } catch (existingPopupError) {
                // ignore and continue
            }
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Gallery opened.", usedStrategy), false);
            return;
        }

        // macOS path: request OpenExtension with retry pings for reliable single-click open.
        if (osFamily === "mac" && bridge && typeof bridge.requestOpenExtension === "function") {
            try {
                bridge.requestOpenExtension("com.veobridge.gallery", "");
                opened = true;
                usedStrategy = "mac:requestOpenExtension";
                window.setTimeout(function () {
                    try {
                        bridge.requestOpenExtension("com.veobridge.gallery", "");
                    } catch (retryError) {
                        // ignore
                    }
                }, 120);
                window.setTimeout(function () {
                    try {
                        bridge.requestOpenExtension("com.veobridge.gallery", "");
                    } catch (retryError2) {
                        // ignore
                    }
                }, 260);
            } catch (requestOpenError) {
                opened = false;
            }
        }
        if (opened) {
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Gallery opened.", usedStrategy || primaryStrategy), false);
            return;
        }

        // Windows path: request OpenExtension with shorter retry pings.
        if (osFamily === "win" && bridge && typeof bridge.requestOpenExtension === "function") {
            try {
                bridge.requestOpenExtension("com.veobridge.gallery", "");
                opened = true;
                usedStrategy = "win:requestOpenExtension";
                window.setTimeout(function () {
                    try {
                        bridge.requestOpenExtension("com.veobridge.gallery", "");
                    } catch (retryWinError) {
                        // ignore
                    }
                }, 140);
                window.setTimeout(function () {
                    try {
                        bridge.requestOpenExtension("com.veobridge.gallery", "");
                    } catch (retryWinError2) {
                        // ignore
                    }
                }, 320);
            } catch (requestOpenWinError) {
                opened = false;
            }
        }

        if (!opened) {
            // Fallback path when CEP open-extension is unavailable.
            try {
                popup = window.open(galleryUrl, "VeoBridgeGallery", features);
                if (!popup) {
                    popup = window.open("gallery.html", "VeoBridgeGallery", features);
                }
                opened = !!popup;
            } catch (openError) {
                opened = false;
            }
        }

        if (opened) {
            galleryWindowRef = popup;
            if (!usedStrategy) {
                usedStrategy = primaryStrategy;
            }
            try {
                if (popup && typeof popup.resizeTo === "function") {
                    popup.resizeTo(galleryWidth, galleryHeight);
                    window.setTimeout(function () {
                        try {
                            popup.resizeTo(galleryWidth, galleryHeight);
                        } catch (resizeError2) {
                            // ignore
                        }
                    }, 160);
                }
                if (popup && typeof popup.focus === "function") {
                    popup.focus();
                    window.setTimeout(function () {
                        try {
                            popup.focus();
                        } catch (focusError2) {
                            // ignore
                        }
                    }, 80);
                }
                // Windows/CEF sometimes opens a blank named window; force target page if needed.
                if (popup && osFamily === "win") {
                    window.setTimeout(function () {
                        try {
                            if (!popup.closed && popup.location && String(popup.location.href || "").indexOf("gallery.html") < 0) {
                                popup.location.href = "gallery.html";
                            }
                        } catch (hrefError) {
                            // ignore
                        }
                    }, 100);
                }
            } catch (resizeError) {
                // ignore
            }
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Gallery opened.", usedStrategy || primaryStrategy), false);
            return;
        }

        endGalleryOpenAttempt();
        if (osFamily === "mac") {
            setStatus(withOpenDebug("Failed to open Gallery window.", "mac:requestOpenExtension+window.open"), true);
            return;
        }
        setStatus(withOpenDebug("Failed to open Gallery window.", usedStrategy || primaryStrategy), true);
    }

    function openSettingsModal() {
        var modal = getById("settingsModal");
        var input = getById("apiKeyInput");
        var saved = "";
        var shared = null;

        if (!modal || !input) {
            return;
        }

        try {
            saved = window.localStorage.getItem(STORAGE_KEY_API_KEY) || "";
        } catch (error) {
            saved = "";
        }

        if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.loadSettings === "function") {
            try {
                shared = window.VeoBridgeSettings.loadSettings();
                if (shared && shared.apiKey) {
                    saved = String(shared.apiKey);
                }
            } catch (loadSettingsError) {
                // ignore
            }
        }

        input.value = saved;
        modal.hidden = false;
        if (typeof input.focus === "function") {
            input.focus();
        }
    }

    function closeSettingsModal() {
        var modal = getById("settingsModal");
        if (modal) {
            modal.hidden = true;
        }
    }

    function saveSettings() {
        var input = getById("apiKeyInput");
        var value = input ? String(input.value || "") : "";
        var saveError = null;

        try {
            window.localStorage.setItem(STORAGE_KEY_API_KEY, value);
        } catch (error) {
            saveError = error;
        }

        if (window.VeoBridgeSettings && typeof window.VeoBridgeSettings.saveSettings === "function") {
            try {
                window.VeoBridgeSettings.saveSettings({ apiKey: value });
            } catch (settingsError) {
                if (!saveError) {
                    saveError = settingsError;
                }
            }
        }

        closeSettingsModal();

        if (saveError) {
            setStatus("Settings window closed, but API key was not saved: " + String(saveError), true);
            return;
        }

        setStatus("Settings saved.", false);
    }

    function bindActions() {
        var btnCapture = getById("btnCapture");
        var btnOpenGallery = getById("btnOpenGallery");
        var btnSettings = getById("btnSettings");
        var btnSaveApiKey = getById("btnSaveApiKey");
        var btnCloseSettings = getById("btnCloseSettings");
        var settingsModal = getById("settingsModal");

        if (btnCapture) {
            btnCapture.addEventListener("click", onCaptureClick);
        }
        if (btnOpenGallery) {
            btnOpenGallery.addEventListener("click", openGalleryWindow);
        }
        if (btnSettings) {
            btnSettings.addEventListener("click", openSettingsModal);
        }
        if (btnSaveApiKey) {
            btnSaveApiKey.addEventListener("click", saveSettings);
        }
        if (btnCloseSettings) {
            btnCloseSettings.addEventListener("click", closeSettingsModal);
        }

        if (settingsModal) {
            settingsModal.addEventListener("click", function (event) {
                if (event.target === settingsModal) {
                    closeSettingsModal();
                }
            });
        }

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeSettingsModal();
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        bindActions();

        if (!window.VeoBridgeState || typeof window.VeoBridgeState.ensurePaths !== "function") {
            setStatus("VeoBridgeState is unavailable.", true);
            return;
        }

        window.VeoBridgeState.ensurePaths(function (error) {
            if (error) {
                setStatus("Path initialization warning: " + error.message + ". Capture will work when active comp is selected.", false);
                return;
            }
            setStatus("Ready.", false);
        });
    });

    window.addEventListener("error", function (event) {
        var message = event && event.message ? event.message : "Unexpected UI error.";
        setStatus("Unexpected error: " + message, true);
    });

    window.addEventListener("unhandledrejection", function (event) {
        var reason = event && event.reason ? event.reason : "Unknown rejection";
        var message = reason && reason.message ? reason.message : String(reason);
        setStatus("Unexpected async error: " + message, true);
    });
}());
