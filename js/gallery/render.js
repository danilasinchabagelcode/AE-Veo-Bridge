(function (global) {
    "use strict";

    if (!global.VeoBridgeGalleryModules) {
        global.VeoBridgeGalleryModules = {};
    }

    function create(options) {
        var opts = options || {};
        var getById = typeof opts.getById === "function" ? opts.getById : function () { return null; };
        var logger = typeof opts.logger === "function" ? opts.logger : null;

        function _log(level, message, extra) {
            if (!logger) {
                return;
            }
            try {
                logger(level, message, extra || null);
            } catch (error) {
                // Ignore logger issues.
            }
        }

        function setLine(id, text, isError, className) {
            var el = getById(id);
            var nextText = String(typeof text === "undefined" ? "" : text);
            if (!el) {
                return;
            }
            el.textContent = nextText;
            if (className) {
                el.className = isError ? className + " is-error" : className;
            }
            _log(isError ? "error" : "info", "ui.status." + id, {
                text: nextText
            });
        }

        return {
            setLine: setLine
        };
    }

    global.VeoBridgeGalleryModules.render = {
        create: create
    };
}(window));
