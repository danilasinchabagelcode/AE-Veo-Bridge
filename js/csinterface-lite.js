(function (global) {
    "use strict";

    if (global.CSInterfaceLite) {
        return;
    }

    function getCepHost() {
        if (global.__adobe_cep__) {
            return global.__adobe_cep__;
        }
        return null;
    }

    // Create a minimal CSInterface shim when Adobe's helper file is not bundled.
    if (!global.CSInterface && getCepHost()) {
        global.CSInterface = function CSInterface() {};

        global.CSInterface.prototype.evalScript = function (script, callback) {
            var cep = getCepHost();
            if (!cep || typeof cep.evalScript !== "function") {
                if (typeof callback === "function") {
                    callback("CSInterface is unavailable");
                }
                return;
            }
            cep.evalScript(script, callback || function () {});
        };

        global.CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
            var cep = getCepHost();
            if (!cep || typeof cep.requestOpenExtension !== "function") {
                return;
            }
            cep.requestOpenExtension(extensionId, params || "");
        };

        global.CSInterface.prototype.closeExtension = function () {
            var cep = getCepHost();
            if (!cep || typeof cep.closeExtension !== "function") {
                return;
            }
            cep.closeExtension();
        };

        global.CSInterface.prototype.resizeContent = function (width, height) {
            var cep = getCepHost();
            if (!cep || typeof cep.resizeContent !== "function") {
                return;
            }
            cep.resizeContent(Number(width) || 0, Number(height) || 0);
        };
    }

    function CSInterfaceLite() {
        this.instance = global.CSInterface ? new global.CSInterface() : null;
    }

    CSInterfaceLite.prototype.evalScript = function (script, callback) {
        var cep;

        if (this.instance && typeof this.instance.evalScript === "function") {
            this.instance.evalScript(script, callback);
            return;
        }

        cep = getCepHost();
        if (cep && typeof cep.evalScript === "function") {
            cep.evalScript(script, callback || function () {});
            return;
        }

        if (typeof callback === "function") {
            callback("CSInterface is unavailable");
        }
    };

    CSInterfaceLite.prototype.requestOpenExtension = function (extensionId, params) {
        var cep;

        if (this.instance && typeof this.instance.requestOpenExtension === "function") {
            this.instance.requestOpenExtension(extensionId, params || "");
            return;
        }

        cep = getCepHost();
        if (cep && typeof cep.requestOpenExtension === "function") {
            cep.requestOpenExtension(extensionId, params || "");
        }
    };

    CSInterfaceLite.prototype.closeExtension = function () {
        var cep;

        if (this.instance && typeof this.instance.closeExtension === "function") {
            this.instance.closeExtension();
            return;
        }

        cep = getCepHost();
        if (cep && typeof cep.closeExtension === "function") {
            cep.closeExtension();
        }
    };

    CSInterfaceLite.prototype.resizeContent = function (width, height) {
        var cep;

        if (this.instance && typeof this.instance.resizeContent === "function") {
            this.instance.resizeContent(width, height);
            return;
        }

        cep = getCepHost();
        if (cep && typeof cep.resizeContent === "function") {
            cep.resizeContent(Number(width) || 0, Number(height) || 0);
        }
    };

    global.CSInterfaceLite = CSInterfaceLite;
}(window));
