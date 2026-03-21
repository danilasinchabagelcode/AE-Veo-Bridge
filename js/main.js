(function () {
    "use strict";

    var STORAGE_KEY_API_KEY = "veobridge.apiKey";
    var cs = null;
    var isCapturing = false;
    var isCreatingComp = false;
    var isGalleryOpening = false;
    var galleryOpeningTimer = null;
    var hasGalleryReadySignal = false;
    var galleryReadyListenerBound = false;
    var GALLERY_READY_EVENT = "veobridge.gallery.ready";
    var COLOR_PRESETS = {
        Green: { r: 0, g: 255, b: 0, hex: "#00ff00" },
        Blue: { r: 0, g: 0, b: 255, hex: "#0000ff" },
        Magenta: { r: 255, g: 0, b: 255, hex: "#ff00ff" }
    };
    var createCompColorState = {
        h: 120,
        s: 100,
        v: 100,
        r: 0,
        g: 255,
        b: 0,
        hex: "#00FF00"
    };
    var createCompColorDragMode = "";

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

    function getGalleryOpenStrategyHint() {
        return "cep:requestOpenExtension";
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
                setStatus(withOpenDebug("Gallery opening timed out.", getGalleryOpenStrategyHint()), true);
                isGalleryOpening = false;
                galleryOpeningTimer = null;
            }, 3000);
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

    function toScriptString(value) {
        return JSON.stringify(String(value == null ? "" : value));
    }

    function getRatioSpec(ratioValue) {
        if (ratioValue === "1x1") {
            return { label: "1x1", width: 1080, height: 1080 };
        }
        if (ratioValue === "9x16") {
            return { label: "9x16", width: 1080, height: 1920 };
        }
        return { label: "16x9", width: 1920, height: 1080 };
    }

    function clampColorChannel(value) {
        var numeric = parseInt(value, 10);
        if (!(numeric >= 0)) {
            numeric = 0;
        }
        if (numeric > 255) {
            numeric = 255;
        }
        return numeric;
    }

    function clampHue(value) {
        var numeric = parseFloat(value);
        if (!isFinite(numeric)) {
            numeric = 0;
        }
        if (numeric < 0) {
            numeric = 0;
        }
        if (numeric > 360) {
            numeric = 360;
        }
        return numeric;
    }

    function clampPercent(value) {
        var numeric = parseFloat(value);
        if (!isFinite(numeric)) {
            numeric = 0;
        }
        if (numeric < 0) {
            numeric = 0;
        }
        if (numeric > 100) {
            numeric = 100;
        }
        return numeric;
    }

    function rgbToHex(rgb) {
        function channelToHex(value) {
            var hex = clampColorChannel(value).toString(16);
            return hex.length < 2 ? "0" + hex : hex;
        }

        return ("#" + channelToHex(rgb.r) + channelToHex(rgb.g) + channelToHex(rgb.b)).toUpperCase();
    }

    function hexToRgbSafe(hexValue) {
        var normalized = String(hexValue || "").replace(/[^0-9a-f]/gi, "");
        if (normalized.length === 3) {
            normalized = normalized.charAt(0) + normalized.charAt(0) +
                normalized.charAt(1) + normalized.charAt(1) +
                normalized.charAt(2) + normalized.charAt(2);
        }
        if (normalized.length !== 6) {
            return null;
        }
        return {
            r: parseInt(normalized.substring(0, 2), 16),
            g: parseInt(normalized.substring(2, 4), 16),
            b: parseInt(normalized.substring(4, 6), 16)
        };
    }

    function hsvToRgb(h, s, v) {
        var hue = clampHue(h);
        var sat = clampPercent(s) / 100;
        var val = clampPercent(v) / 100;
        var c = val * sat;
        var x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
        var m = val - c;
        var r1 = 0;
        var g1 = 0;
        var b1 = 0;

        if (hue < 60) {
            r1 = c; g1 = x; b1 = 0;
        } else if (hue < 120) {
            r1 = x; g1 = c; b1 = 0;
        } else if (hue < 180) {
            r1 = 0; g1 = c; b1 = x;
        } else if (hue < 240) {
            r1 = 0; g1 = x; b1 = c;
        } else if (hue < 300) {
            r1 = x; g1 = 0; b1 = c;
        } else {
            r1 = c; g1 = 0; b1 = x;
        }

        return {
            r: Math.round((r1 + m) * 255),
            g: Math.round((g1 + m) * 255),
            b: Math.round((b1 + m) * 255)
        };
    }

    function rgbToHsv(r, g, b) {
        var red = clampColorChannel(r) / 255;
        var green = clampColorChannel(g) / 255;
        var blue = clampColorChannel(b) / 255;
        var max = Math.max(red, green, blue);
        var min = Math.min(red, green, blue);
        var delta = max - min;
        var hue = 0;
        var sat = max === 0 ? 0 : delta / max;
        var val = max;

        if (delta !== 0) {
            if (max === red) {
                hue = 60 * (((green - blue) / delta) % 6);
            } else if (max === green) {
                hue = 60 * (((blue - red) / delta) + 2);
            } else {
                hue = 60 * (((red - green) / delta) + 4);
            }
        }

        if (hue < 0) {
            hue += 360;
        }

        return {
            h: Math.round(hue),
            s: Math.round(sat * 100),
            v: Math.round(val * 100)
        };
    }

    function getCreateCompCustomColor() {
        return {
            r: createCompColorState.r,
            g: createCompColorState.g,
            b: createCompColorState.b
        };
    }

    function renderCreateCompSvCanvas() {
        var canvas = getById("createCompSvCanvas");
        var context;
        var width;
        var height;
        var hueColor;
        var whiteGradient;
        var blackGradient;
        var x;
        var y;

        if (!canvas || !canvas.getContext) {
            return;
        }
        context = canvas.getContext("2d");
        width = canvas.width;
        height = canvas.height;
        hueColor = hsvToRgb(createCompColorState.h, 100, 100);

        context.clearRect(0, 0, width, height);
        context.fillStyle = rgbToHex(hueColor);
        context.fillRect(0, 0, width, height);

        whiteGradient = context.createLinearGradient(0, 0, width, 0);
        whiteGradient.addColorStop(0, "#FFFFFF");
        whiteGradient.addColorStop(1, "rgba(255,255,255,0)");
        context.fillStyle = whiteGradient;
        context.fillRect(0, 0, width, height);

        blackGradient = context.createLinearGradient(0, 0, 0, height);
        blackGradient.addColorStop(0, "rgba(0,0,0,0)");
        blackGradient.addColorStop(1, "#000000");
        context.fillStyle = blackGradient;
        context.fillRect(0, 0, width, height);

        x = Math.round((createCompColorState.s / 100) * (width - 1));
        y = Math.round(((100 - createCompColorState.v) / 100) * (height - 1));
        context.strokeStyle = "#FFFFFF";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(x, y, 6, 0, Math.PI * 2, false);
        context.stroke();
        context.strokeStyle = "rgba(0,0,0,0.8)";
        context.lineWidth = 1;
        context.beginPath();
        context.arc(x, y, 8, 0, Math.PI * 2, false);
        context.stroke();
    }

    function renderCreateCompHueCanvas() {
        var canvas = getById("createCompHueCanvas");
        var context;
        var height;
        var gradient;
        var markerY;

        if (!canvas || !canvas.getContext) {
            return;
        }
        context = canvas.getContext("2d");
        height = canvas.height;
        gradient = context.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, "#FF0000");
        gradient.addColorStop(0.17, "#FFFF00");
        gradient.addColorStop(0.33, "#00FF00");
        gradient.addColorStop(0.5, "#00FFFF");
        gradient.addColorStop(0.67, "#0000FF");
        gradient.addColorStop(0.83, "#FF00FF");
        gradient.addColorStop(1, "#FF0000");
        context.clearRect(0, 0, canvas.width, height);
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, height);

        markerY = Math.round((createCompColorState.h / 360) * (height - 1));
        context.strokeStyle = "#FFFFFF";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(0, markerY);
        context.lineTo(canvas.width, markerY);
        context.stroke();
        context.strokeStyle = "rgba(0,0,0,0.8)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, markerY - 2);
        context.lineTo(canvas.width, markerY - 2);
        context.stroke();
    }

    function syncCreateCompPickerUi() {
        var swatch = getById("btnColorSwatch");
        var preview = getById("createCompColorPreview");
        var hexInput = getById("bgColorHexInput");
        var hInput = getById("bgColorHInput");
        var sInput = getById("bgColorSInput");
        var vInput = getById("bgColorVInput");
        var rInput = getById("bgColorRInput");
        var gInput = getById("bgColorGInput");
        var bInput = getById("bgColorBInput");

        if (swatch) {
            swatch.style.backgroundColor = createCompColorState.hex;
        }
        if (preview) {
            preview.style.backgroundColor = createCompColorState.hex;
        }
        if (hexInput) {
            hexInput.value = createCompColorState.hex.replace(/^#/, "");
        }
        if (hInput) {
            hInput.value = String(Math.round(createCompColorState.h));
        }
        if (sInput) {
            sInput.value = String(Math.round(createCompColorState.s));
        }
        if (vInput) {
            vInput.value = String(Math.round(createCompColorState.v));
        }
        if (rInput) {
            rInput.value = String(createCompColorState.r);
        }
        if (gInput) {
            gInput.value = String(createCompColorState.g);
        }
        if (bInput) {
            bInput.value = String(createCompColorState.b);
        }
        renderCreateCompSvCanvas();
        renderCreateCompHueCanvas();
    }

    function setCreateCompCustomColor(rgb) {
        var hsv;
        rgb = {
            r: clampColorChannel(rgb && rgb.r),
            g: clampColorChannel(rgb && rgb.g),
            b: clampColorChannel(rgb && rgb.b)
        };
        hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        createCompColorState.h = hsv.h;
        createCompColorState.s = hsv.s;
        createCompColorState.v = hsv.v;
        createCompColorState.r = rgb.r;
        createCompColorState.g = rgb.g;
        createCompColorState.b = rgb.b;
        createCompColorState.hex = rgbToHex(rgb);
        syncCreateCompPickerUi();
    }

    function setCreateCompColorFromHsv(h, s, v) {
        var rgb = hsvToRgb(h, s, v);
        createCompColorState.h = clampHue(h);
        createCompColorState.s = clampPercent(s);
        createCompColorState.v = clampPercent(v);
        createCompColorState.r = rgb.r;
        createCompColorState.g = rgb.g;
        createCompColorState.b = rgb.b;
        createCompColorState.hex = rgbToHex(rgb);
        syncCreateCompPickerUi();
    }

    function getEventPoint(event) {
        if (!event) {
            return { x: 0, y: 0 };
        }
        return {
            x: typeof event.clientX === "number" ? event.clientX : 0,
            y: typeof event.clientY === "number" ? event.clientY : 0
        };
    }

    function updateCreateCompSvFromEvent(event) {
        var canvas = getById("createCompSvCanvas");
        var rect;
        var point;
        var x;
        var y;
        if (!canvas) {
            return;
        }
        rect = canvas.getBoundingClientRect();
        point = getEventPoint(event);
        x = Math.max(0, Math.min(rect.width, point.x - rect.left));
        y = Math.max(0, Math.min(rect.height, point.y - rect.top));
        setCreateCompColorFromHsv(
            createCompColorState.h,
            (x / rect.width) * 100,
            100 - ((y / rect.height) * 100)
        );
    }

    function updateCreateCompHueFromEvent(event) {
        var canvas = getById("createCompHueCanvas");
        var rect;
        var point;
        var y;
        if (!canvas) {
            return;
        }
        rect = canvas.getBoundingClientRect();
        point = getEventPoint(event);
        y = Math.max(0, Math.min(rect.height, point.y - rect.top));
        setCreateCompColorFromHsv(
            (y / rect.height) * 360,
            createCompColorState.s,
            createCompColorState.v
        );
    }

    function openCreateCompColorPopover() {
        var popover = getById("createCompColorPopover");
        if (!popover) {
            return;
        }
        popover.hidden = false;
    }

    function closeCreateCompColorPopover() {
        var popover = getById("createCompColorPopover");
        if (!popover) {
            return;
        }
        popover.hidden = true;
    }

    function syncCreateCompColorUi() {
        var select = getById("bgColorSelect");
        var swatch = getById("btnColorSwatch");
        var preset;

        if (!select || !swatch) {
            return;
        }

        if (select.value === "Custom") {
            swatch.disabled = false;
            return;
        }

        preset = COLOR_PRESETS[select.value] || COLOR_PRESETS.Green;
        setCreateCompCustomColor(preset);
        swatch.disabled = true;
        closeCreateCompColorPopover();
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

    function requestGalleryOpen() {
        var bridge = ensureCs();
        if (!bridge || typeof bridge.requestOpenExtension !== "function") {
            throw new Error("CSInterface requestOpenExtension is unavailable");
        }
        bridge.requestOpenExtension("com.veobridge.gallery", "");
    }

    function onGalleryReadyEvent() {
        hasGalleryReadySignal = true;
        if (!isGalleryOpening) {
            return;
        }
        try {
            requestGalleryOpen();
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Gallery opened.", "cep:handshake"), false);
        } catch (error) {
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Failed to open Gallery window.", "cep:handshake"), true);
        }
    }

    function bindGalleryReadyListener() {
        var bridge = ensureCs();
        if (galleryReadyListenerBound || !bridge || typeof bridge.addEventListener !== "function") {
            return;
        }
        bridge.addEventListener(GALLERY_READY_EVENT, onGalleryReadyEvent);
        galleryReadyListenerBound = true;
    }

    function openGalleryWindow() {
        var primaryStrategy = getGalleryOpenStrategyHint();

        if (!beginGalleryOpenAttempt()) {
            setStatus(withOpenDebug("Opening Gallery...", primaryStrategy), false);
            return;
        }

        try {
            requestGalleryOpen();
            if (hasGalleryReadySignal) {
                endGalleryOpenAttempt();
                setStatus(withOpenDebug("Gallery opened.", "cep:direct"), false);
                return;
            }
            setStatus(withOpenDebug("Opening Gallery...", primaryStrategy), false);
        } catch (error) {
            endGalleryOpenAttempt();
            setStatus(withOpenDebug("Failed to open Gallery window.", primaryStrategy), true);
        }
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

    function openCreateCompModal() {
        var modal = getById("createCompModal");
        var ratioSelect = getById("ratioSelect");
        var bgColorSelect = getById("bgColorSelect");

        if (!modal) {
            return;
        }

        if (ratioSelect) {
            ratioSelect.value = "16x9";
        }
        if (bgColorSelect) {
            bgColorSelect.value = "Green";
        }
        setCreateCompCustomColor(COLOR_PRESETS.Green);
        closeCreateCompColorPopover();
        syncCreateCompColorUi();
        modal.hidden = false;
    }

    function closeSettingsModal() {
        var modal = getById("settingsModal");
        if (modal) {
            modal.hidden = true;
        }
    }

    function closeCreateCompModal() {
        var modal = getById("createCompModal");
        if (modal) {
            modal.hidden = true;
        }
        closeCreateCompColorPopover();
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

    function submitCreateComp() {
        var ratioSelect = getById("ratioSelect");
        var bgColorSelect = getById("bgColorSelect");
        var ratioSpec;
        var colorLabel;
        var color;
        var script;

        if (isCreatingComp) {
            setStatus("Composition creation is already running.", true);
            return;
        }
        if (!ratioSelect || !bgColorSelect) {
            setStatus("Create Composition UI is unavailable.", true);
            return;
        }

        ratioSpec = getRatioSpec(ratioSelect.value);
        colorLabel = bgColorSelect.value === "Custom" ? "Custom" : bgColorSelect.value;
        if (bgColorSelect.value === "Custom") {
            color = getCreateCompCustomColor();
        } else {
            color = COLOR_PRESETS[bgColorSelect.value] || COLOR_PRESETS.Green;
        }

        script = "VeoBridge_createCompWithBackground(" +
            toScriptString(ratioSpec.label) + "," +
            toScriptString(colorLabel) + "," +
            String(ratioSpec.width) + "," +
            String(ratioSpec.height) + "," +
            String(color.r) + "," +
            String(color.g) + "," +
            String(color.b) +
            ")";

        isCreatingComp = true;
        setStatus("Creating composition...", false);
        callHost(script, function (error, payload) {
            isCreatingComp = false;
            if (error) {
                setStatus("Create Composition failed: " + error.message, true);
                return;
            }
            closeCreateCompModal();
            setStatus("Created: " + String(payload && payload.compName ? payload.compName : ratioSpec.label + "_" + colorLabel), false);
        });
    }

    function bindActions() {
        var btnCapture = getById("btnCapture");
        var btnOpenGallery = getById("btnOpenGallery");
        var btnCreateComp = getById("btnCreateComp");
        var btnSettings = getById("btnSettings");
        var btnSaveApiKey = getById("btnSaveApiKey");
        var btnCloseSettings = getById("btnCloseSettings");
        var btnSubmitCreateComp = getById("btnSubmitCreateComp");
        var btnColorSwatch = getById("btnColorSwatch");
        var settingsModal = getById("settingsModal");
        var createCompModal = getById("createCompModal");
        var bgColorSelect = getById("bgColorSelect");
        var svCanvas = getById("createCompSvCanvas");
        var hueCanvas = getById("createCompHueCanvas");
        var hexInput = getById("bgColorHexInput");
        var hInput = getById("bgColorHInput");
        var sInput = getById("bgColorSInput");
        var vInput = getById("bgColorVInput");
        var rInput = getById("bgColorRInput");
        var gInput = getById("bgColorGInput");
        var bInput = getById("bgColorBInput");
        var onColorDragMove;
        var onColorDragEnd;

        if (btnCapture) {
            btnCapture.addEventListener("click", onCaptureClick);
        }
        if (btnOpenGallery) {
            btnOpenGallery.addEventListener("click", openGalleryWindow);
        }
        if (btnCreateComp) {
            btnCreateComp.addEventListener("click", openCreateCompModal);
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
        if (btnSubmitCreateComp) {
            btnSubmitCreateComp.addEventListener("click", submitCreateComp);
        }
        if (bgColorSelect) {
            bgColorSelect.addEventListener("change", function () {
                syncCreateCompColorUi();
                if (bgColorSelect.value === "Custom") {
                    openCreateCompColorPopover();
                    if (hexInput && typeof hexInput.focus === "function") {
                        hexInput.focus();
                    }
                }
            });
        }
        if (btnColorSwatch) {
            btnColorSwatch.addEventListener("click", function () {
                if (bgColorSelect && bgColorSelect.value !== "Custom") {
                    return;
                }
                openCreateCompColorPopover();
            });
        }
        if (svCanvas) {
            svCanvas.addEventListener("mousedown", function (event) {
                if (bgColorSelect && bgColorSelect.value !== "Custom") {
                    return;
                }
                createCompColorDragMode = "sv";
                updateCreateCompSvFromEvent(event);
                event.preventDefault();
            });
        }
        if (hueCanvas) {
            hueCanvas.addEventListener("mousedown", function (event) {
                if (bgColorSelect && bgColorSelect.value !== "Custom") {
                    return;
                }
                createCompColorDragMode = "hue";
                updateCreateCompHueFromEvent(event);
                event.preventDefault();
            });
        }
        if (hexInput) {
            hexInput.addEventListener("input", function () {
                var rgb = hexToRgbSafe(hexInput.value);
                if (!rgb) {
                    return;
                }
                setCreateCompCustomColor(rgb);
            });
        }
        function onHsvInputChange() {
            setCreateCompColorFromHsv(
                hInput ? hInput.value : 0,
                sInput ? sInput.value : 0,
                vInput ? vInput.value : 0
            );
        }
        function onRgbInputChange() {
            setCreateCompCustomColor({
                r: rInput ? rInput.value : 0,
                g: gInput ? gInput.value : 255,
                b: bInput ? bInput.value : 0
            });
        }
        if (hInput) {
            hInput.addEventListener("input", onHsvInputChange);
        }
        if (sInput) {
            sInput.addEventListener("input", onHsvInputChange);
        }
        if (vInput) {
            vInput.addEventListener("input", onHsvInputChange);
        }
        if (rInput) {
            rInput.addEventListener("input", onRgbInputChange);
        }
        if (gInput) {
            gInput.addEventListener("input", onRgbInputChange);
        }
        if (bInput) {
            bInput.addEventListener("input", onRgbInputChange);
        }
        onColorDragMove = function (event) {
            if (createCompColorDragMode === "sv") {
                updateCreateCompSvFromEvent(event);
            } else if (createCompColorDragMode === "hue") {
                updateCreateCompHueFromEvent(event);
            }
        };
        onColorDragEnd = function () {
            createCompColorDragMode = "";
        };
        document.addEventListener("mousemove", onColorDragMove);
        document.addEventListener("mouseup", onColorDragEnd);

        if (settingsModal) {
            settingsModal.addEventListener("click", function (event) {
                if (event.target === settingsModal) {
                    closeSettingsModal();
                }
            });
        }
        if (createCompModal) {
            createCompModal.addEventListener("click", function (event) {
                var popover = getById("createCompColorPopover");
                if (popover && !popover.hidden && event.target !== popover && !popover.contains(event.target) && event.target !== btnColorSwatch) {
                    closeCreateCompColorPopover();
                }
                if (event.target === createCompModal) {
                    closeCreateCompModal();
                }
            });
        }

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeCreateCompColorPopover();
                closeSettingsModal();
                closeCreateCompModal();
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        bindGalleryReadyListener();
        bindActions();
        setCreateCompCustomColor(COLOR_PRESETS.Green);

        if (!window.VeoBridgeState || typeof window.VeoBridgeState.ensurePaths !== "function") {
            setStatus("VeoBridgeState is unavailable.", true);
            return;
        }

        window.VeoBridgeState.ensurePaths(function (error) {
            if (error) {
                setStatus("Path initialization warning: " + error.message + ". Capture will work when active comp is selected.", false);
                return;
            }
            setStatus("Ready. Media library is stored in userData/VeoBridge.", false);
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
