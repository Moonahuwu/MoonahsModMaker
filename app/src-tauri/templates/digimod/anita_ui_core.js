var AnitaUILogger = (function() {
    "use strict";  

    return function(debugMode) {
        const cache = {
            lastMessages: {},
            spamCount: {}
        };

        return {
            setDebugMode: function(enabled) {
                debugMode = enabled;
            },

            info: function(message) {
                if (debugMode) {
                    $.Msg("[Anita-UI] " + message);
                }
            },

            warn: function(message) {
                if (debugMode) {
                    $.Msg("[Anita-UI] WARNING: " + message);
                }
            },

            error: function(message) {
                $.Msg("[Anita-UI] ERROR: " + message);
            },

            debug: function(message, allowRepeat) {
                if (!debugMode) return;
                
                if (!allowRepeat) {
                    if (cache.lastMessages[message]) {
                        cache.spamCount[message] = (cache.spamCount[message] || 0) + 1;
                        return;
                    }
                    
                    cache.lastMessages[message] = true;
                }
                
                $.Msg("[Anita-UI] DEBUG: " + message);
            },

            debugThrottled: function(message, threshold) {
                if (!debugMode) return;
                
                threshold = threshold || 10;
                cache.spamCount[message] = (cache.spamCount[message] || 0) + 1;
                
                if (cache.spamCount[message] % threshold === 1) {
                    $.Msg("[Anita-UI] DEBUG: " + message + " (x" + cache.spamCount[message] + ")");
                }
            },

            event: function(eventName, data) {
                if (debugMode) {
                    $.Msg("[Anita-UI] EVENT: " + eventName + " | Data: " + JSON.stringify(data));
                }
            },

            showSpamSummary: function() {
                if (!debugMode) return;
                
                var hasSpam = false;
                for (var msg in cache.spamCount) {
                    if (cache.spamCount[msg] > 1) {
                        if (!hasSpam) {
                            $.Msg("[Anita-UI] === REPEATED MESSAGES SUMMARY ===");
                            hasSpam = true;
                        }
                        $.Msg("[Anita-UI] - " + msg + " (x" + cache.spamCount[msg] + ")");
                    }
                }
                if (hasSpam) {
                    $.Msg("[Anita-UI] ====================================");
                }
            },

            clearCache: function() {
                cache.lastMessages = {};
                cache.spamCount = {};
            }
        };
    };
})();

(function() {
    "use strict";

    const CONFIG = {
        DEBUG_MODE: false,
        
        IDS: {
            WINDOW: "AnitaUI_Window",
            BACKDROP: "AnitaUI_Backdrop",
            NAVBAR: "AnitaUI_NavBar",
            CONTENT: "AnitaUI_ContentArea",
            OVERLAY_BTN: "AnitaOverlayBtn",
            HUD_ROOT: "Hud"
        },
        CLASSES: {
            ESCAPE_MENU: "ShowEscapeMenu",
            OPEN: "Open",
            ACTIVE: "Active",
            VISIBLE: "Visible",
            CHECKED: "Checked"
        },
        EVENTS: {
            COMMS: "ClientUI_FireOutput",
            MAGIC_WORD: "ANITA_REGISTER",
            UPDATE: "ANITA_UPDATE"
        },
        UI: {
            TAB_MAX_CHARS: 17,
            MONITOR_INTERVAL: 0.05
        }
    };

    const Logger = AnitaUILogger(CONFIG.DEBUG_MODE);

    function emitUpdate(modTitle, settingId, newValue) {
        var payload = {
            magic_word: "ANITA_UPDATE",
            mod_title: modTitle,
            setting_id: settingId,
            value: newValue
        };
        $.DispatchEvent("ClientUI_FireOutput", JSON.stringify(payload));
    }

    const AnitaComponents = {
        createToggle: function(parent, config, modTitle) {
            const row = $.CreatePanel("Panel", parent, "");
            row.AddClass("AnitaToggleRow");
            
            const btn = $.CreatePanel("Button", row, "");
            btn.AddClass("AnitaToggleBtn");

            const lbl = $.CreatePanel("Label", row, "");
            lbl.text = config.label || "Option";
            lbl.AddClass("AnitaLabel");

            const box = $.CreatePanel("Panel", row, "");
            box.AddClass("AnitaCheckBox");
            
            const tick = $.CreatePanel("Panel", box, "");
            tick.AddClass("AnitaCheckMark");
            
            let isOn = (config.currentValue !== undefined) ? config.currentValue : (config.defaultValue || false);
            
            const updateState = (active) => row.SetHasClass("Checked", active);
            updateState(isOn);
            
            btn.SetPanelEvent("onactivate", () => {
                isOn = !isOn;
                updateState(isOn);

                config.currentValue = isOn;

                if (config.id) emitUpdate(modTitle, config.id, isOn);
                if (config.onChange) config.onChange(isOn);
            });
        },

        createStepper: function (parent, config, modTitle) {
            const row = $.CreatePanel("Panel", parent, "");
            row.AddClass("AnitaRow");
            const lbl = $.CreatePanel("Label", row, "");
            lbl.text = config.label || "Value";
            lbl.AddClass("AnitaLabel");
            const controls = $.CreatePanel("Panel", row, "");
            controls.AddClass("AnitaStepperControls");
            const btnM = $.CreatePanel("Button", controls, "");
            btnM.AddClass("AnitaStepBtn");
            $.CreatePanel("Label", btnM, "less").text = "-";
            const input = $.CreatePanel("TextEntry", controls, "");
            input.AddClass("AnitaStepInput");
            const btnP = $.CreatePanel("Button", controls, "");
            btnP.AddClass("AnitaStepBtn");
            $.CreatePanel("Label", btnP, "").text = "+";

            let val = (config.currentValue !== undefined) ? config.currentValue : (config.defaultValue || 0);
            const step = config.step || 1;
            const isFloat = !Number.isInteger(step);
            input.text = isFloat ? val.toFixed(2) : val;

            function update(newVal) {
                if (isFloat) newVal = parseFloat(newVal.toFixed(2)); else newVal = Math.round(newVal);
                val = newVal;
                config.currentValue = val;
                input.text = val.toString();
                if (config.onChange) config.onChange(val);
                if (config.id && modTitle) {
                    emitUpdate(modTitle, config.id, val);
                }
            }

            input.SetPanelEvent("ontextentrychange", () => {
                let v = parseFloat(input.text);
                if (!isNaN(v)) {
                    val = v;
                    config.currentValue = v;
                }
            });

            input.SetPanelEvent("oncancel", () => {
                AnitaRenderer.toggle(false);
            });

            btnM.SetPanelEvent("onactivate", () => update(val - step));
            btnP.SetPanelEvent("onactivate", () => update(val + step));

            input.SetPanelEvent("oninputsubmit", () => {
                update(val);
                $.DispatchEvent("DropInputFocus", input);
                AnitaRenderer.mainWindow.SetFocus();
            });

            input.SetPanelEvent("onfocusout", () => {
                update(val);
            });

            return row;
        },

        createButton: function (parent, config, modTitle) {
            const btn = $.CreatePanel("Button", parent, "");
            btn.AddClass("AnitaActionBtn");
            const lbl = $.CreatePanel("Label", btn, "");
            lbl.text = config.label || "Action";

            btn.SetPanelEvent("onactivate", () => {
                if (config.onClick) config.onClick();

                if (config.id && modTitle) {
                    emitUpdate(modTitle, config.id, true);
                }

                btn.AddClass("Activated");
                $.Schedule(0.1, () => btn.RemoveClass("Activated"));
            });
            return btn; 
        },

        createCycler: function(parent, config, modTitle) {
            const row = $.CreatePanel("Panel", parent, "");
            row.AddClass("AnitaRow");

            const lbl = $.CreatePanel("Label", row, "");
            lbl.text = config.label || "Cycle";
            lbl.AddClass("AnitaLabel");

            const btn = $.CreatePanel("Button", row, "");
            btn.AddClass("AnitaCyclerBtn");

            const valLbl = $.CreatePanel("Label", btn, "");
            
            const options = config.options || ["OFF", "ON"];
            
            let idx = (config.currentValue !== undefined) ? config.currentValue : (config.defaultValue || 0);
            
            if (idx < 0 || idx >= options.length) idx = 0;

            const updateVisuals = () => {
                valLbl.text = options[idx];
            };
            
            updateVisuals();

            btn.SetPanelEvent("onactivate", () => {
                idx = (idx + 1) % options.length;
                updateVisuals();
                
                config.currentValue = idx;

                if (config.id && modTitle) {
                    emitUpdate(modTitle, config.id, idx);
                }
                
                if (config.onChange) config.onChange(idx, options[idx]);
            });

            return row;
        },
    };

    const AnitaRenderer = {
        mainWindow: null,
        backdrop: null,
        navBar: null,
        menuArea: null,
        contentArea: null,
        isOpen: false, 

        initWindow: function (root) {
            if (root.FindChildTraverse(CONFIG.IDS.WINDOW)) root.FindChildTraverse(CONFIG.IDS.WINDOW).DeleteAsync(0);
            if (root.FindChildTraverse(CONFIG.IDS.BACKDROP)) root.FindChildTraverse(CONFIG.IDS.BACKDROP).DeleteAsync(0);

            this.backdrop = $.CreatePanel("Panel", root, CONFIG.IDS.BACKDROP);
            this.backdrop.AddClass("AnitaBackdrop");
            this.backdrop.SetPanelEvent("onactivate", () => this.toggle(false));

            this.mainWindow = $.CreatePanel("Panel", root, CONFIG.IDS.WINDOW);
            this.mainWindow.AddClass("AnitaWindow");

            this.mainWindow.canfocus = true;
            this.mainWindow.SetPanelEvent("oncancel", () => this.toggle(false));

            this.mainWindow.SetPanelEvent("onactivate", () => {
                this.mainWindow.SetFocus();
            });

            this.navBar = $.CreatePanel("Panel", this.mainWindow, CONFIG.IDS.NAVBAR);
            this.navBar.AddClass("AnitaNavBar");

            const closeBtn = $.CreatePanel("Button", this.navBar, "");
            closeBtn.AddClass("AnitaCloseBtn");
            closeBtn.SetPanelEvent("onactivate", () => this.toggle(false));

            const sep = $.CreatePanel("Label", this.navBar, "");
            sep.text = "/";
            sep.AddClass("AnitaTabSeparator");

            this.menuArea = this.navBar;
            this.contentArea = $.CreatePanel("Panel", this.mainWindow, CONFIG.IDS.CONTENT);
            this.contentArea.AddClass("AnitaContentArea");
        },

        toggle: function (forceState) {
            if (!this.mainWindow || !this.backdrop) return;
            this.isOpen = (forceState !== undefined) ? forceState : !this.isOpen;

            this.mainWindow.SetHasClass(CONFIG.CLASSES.OPEN, this.isOpen);
            this.mainWindow.hittest = this.isOpen;
            this.backdrop.SetHasClass(CONFIG.CLASSES.OPEN, this.isOpen);
            this.backdrop.hittest = this.isOpen;

            if (this.isOpen) {
                this.mainWindow.SetFocus();
            } else {
                $.DispatchEvent("DropInputFocus", this.mainWindow);

                let root = $.GetContextPanel();
                while (root.GetParent()) root = root.GetParent();
                root.SetFocus();
            }
        },

        addTab: function(modTitle, onClick) {
            let displayTitle = modTitle;
            const MAX_CHARS = CONFIG.UI.TAB_MAX_CHARS;
            if (displayTitle.length > MAX_CHARS) displayTitle = displayTitle.substring(0, MAX_CHARS) + "...";

            const btn = $.CreatePanel("Button", this.menuArea, "");
            btn.AddClass("AnitaTabBtn");
            const lbl = $.CreatePanel("Label", btn, "");
            lbl.text = displayTitle;

            const sep = $.CreatePanel("Label", this.menuArea, "");
            sep.text = "/"; sep.AddClass("AnitaTabSeparator");

            btn.SetPanelEvent("onactivate", () => {
                this.menuArea.Children().forEach(c => { 
                    if(c.paneltype === "Button" && !c.BHasClass("AnitaCloseBtn")) c.RemoveClass("Active"); 
                });
                btn.AddClass("Active");
                onClick();
            });

            if (this.menuArea.GetChildCount() <= 4) { 
                btn.AddClass("Active"); onClick(); 
            }
        },

        renderModSettings: function (config) {
            this.contentArea.RemoveAndDeleteChildren();

            this.contentArea.canfocus = true;
            this.contentArea.SetPanelEvent("onactivate", () => this.contentArea.SetFocus());

            const container = $.CreatePanel("Panel", this.contentArea, "");
            container.AddClass("ModContainer");
            container.canfocus = true;

            const bgShield = $.CreatePanel("Panel", container, "BackgroundShield");
            bgShield.style.width = "100%";
            bgShield.style.height = "100%";
            bgShield.style.ignoreParentFlow = "true";
            bgShield.style.zIndex = "-1";
            bgShield.hittest = true;

            const syncAll = () => {
                if (config.elements) {
                    config.elements.forEach(el => {
                        if (el.id && el.currentValue !== undefined) {
                            emitUpdate(config.title, el.id, el.currentValue);
                        }
                    });
                }
            };

            bgShield.SetPanelEvent("onmouseover", () => {
                syncAll();
            });

            bgShield.SetPanelEvent("onactivate", () => {
                container.SetFocus();
                syncAll();
            });

            const title = $.CreatePanel("Label", container, "");
            title.text = config.title; title.AddClass("SectionHeader");
            const line = $.CreatePanel("Panel", container, ""); line.AddClass("SectionHeaderLine");

            if (config.description) {
                const desc = $.CreatePanel("Label", container, "");
                desc.text = config.description; desc.AddClass("ModDescription");
            }

            if (config.elements) {
                config.elements.forEach(el => {
                    switch (el.type) {
                        case "toggle": AnitaComponents.createToggle(container, el, config.title); break;
                        case "stepper": AnitaComponents.createStepper(container, el, config.title); break;
                        case "button": AnitaComponents.createButton(container, el, config.title); break;
                        case "cycler": AnitaComponents.createCycler(container, el, config.title); break;
                    }
                });
            }
        }
    };

    const AnitaCore = {
        registeredMods: [],
        
        init: function() {
            const root = this.getRoot($.GetContextPanel());
            Logger.info("Initializing Anita-UI Core");
            
            AnitaRenderer.initWindow(root);

            root.AnitaUI = {
                Register: (config) => this.registerMod(config),
                Toggle: () => AnitaRenderer.toggle(),
                IsReady: () => true,
                SetDebugMode: (enabled) => {
                    CONFIG.DEBUG_MODE = enabled;
                    Logger.setDebugMode(enabled);
                    Logger.info("Debug Mode " + (enabled ? "enabled" : "disabled"));
                },
                ShowSpamSummary: () => {
                    Logger.showSpamSummary();
                },
                ClearLogCache: () => {
                    Logger.clearCache();
                    Logger.info("Log cache cleared");
                }
            };

            this.setupEventListener();
            this.createOverlayButton(root);
            this.monitorEscapeMenu(root);
            
            Logger.info("Anita-UI Core initialized successfully");

            $.DispatchEvent("ClientUI_FireOutput", JSON.stringify({
                magic_word: "ANITA_ALIVE"
            }));
        },

        registerMod: function(config) {
            for(let i=0; i<this.registeredMods.length; i++) {
                if(this.registeredMods[i].title === config.title) {
                    Logger.debugThrottled("Mod already registered: " + config.title, 200);
                    return;
                }
            }
            this.registeredMods.push(config); 

            AnitaRenderer.addTab(config.title, () => {
                AnitaRenderer.renderModSettings(config);
            });
            this.updateWindowWidth();
            Logger.info("Mod registered: " + config.title);

            $.DispatchEvent("ClientUI_FireOutput", JSON.stringify({
                magic_word: "ANITA_HANDSHAKE",
                mod_title: config.title
            }));
            Logger.info("Sent HANDSHAKE to mod: " + config.title);
        },

        updateWindowWidth: function () {
            if (!AnitaRenderer.mainWindow) return;

            const count = this.registeredMods.length; 
            const width = count <= 4 ? (count * 300) : null;

            if (width) {
                AnitaRenderer.mainWindow.style.minWidth = width + "px";
            } else {
                AnitaRenderer.mainWindow.style.minWidth = "90%";
            }
        },

        setupEventListener: function() {
            try {
                $.RegisterForUnhandledEvent("ClientUI_FireOutput", (payload) => {
                    try {
                        let data = (typeof payload === 'string') ? JSON.parse(payload) : payload;
                        if (data && data.magic_word === "ANITA_REGISTER") {
                            this.registerMod(data.config);
                            Logger.debugThrottled("Event received: REGISTER for " + data.config.title, 200);
                        }
                    } catch(e) {
                        Logger.debugThrottled("Malformed event received", 200);
                    }
                });
                Logger.info("Event listener configured");
            } catch(e) {
                Logger.error("Error setting up listener: " + e);
            }
        },

        createOverlayButton: function(parent) {
            if (parent.FindChildTraverse(CONFIG.IDS.OVERLAY_BTN)) parent.FindChildTraverse(CONFIG.IDS.OVERLAY_BTN).DeleteAsync(0);

            const btn = $.CreatePanel("Button", parent, CONFIG.IDS.OVERLAY_BTN);
            btn.AddClass("AnitaOverlayBtn");
            
            btn.SetPanelEvent("onmouseover", () => $.DispatchEvent("UIShowTextTooltip", btn, "Anita-UI Settings"));
            btn.SetPanelEvent("onmouseout", () => $.DispatchEvent("UIHideTextTooltip", btn));
            
            btn.SetPanelEvent("onactivate", () => AnitaRenderer.toggle());
        },

        monitorEscapeMenu: function(root) {
            // Full-tree FindChildTraverse at 20Hz causes frame hitches; cache
            // both panels and only re-search (on a slower tick) after one has
            // been destroyed.
            let hudPanel = this._hudPanel;
            let btn = this._overlayBtn;
            if (!hudPanel || !(hudPanel.IsValid && hudPanel.IsValid())) {
                hudPanel = root.FindChildTraverse(CONFIG.IDS.HUD_ROOT);
                if (!hudPanel) {
                    let p = $.GetContextPanel();
                    while (p) {
                        if (p.id === CONFIG.IDS.HUD_ROOT) { hudPanel = p; break; }
                        p = p.GetParent();
                    }
                }
                this._hudPanel = hudPanel;
            }
            if (!btn || !(btn.IsValid && btn.IsValid())) {
                btn = root.FindChildTraverse(CONFIG.IDS.OVERLAY_BTN);
                this._overlayBtn = btn;
            }

            if (hudPanel && btn) {
                const isMenuOpen = hudPanel.BHasClass(CONFIG.CLASSES.ESCAPE_MENU);
                btn.SetHasClass(CONFIG.CLASSES.VISIBLE, isMenuOpen);
                btn.hittest = isMenuOpen;

                if (!isMenuOpen && AnitaRenderer.isOpen) {
                    AnitaRenderer.toggle(false);
                    Logger.debug("Window closed by escape menu");
                }
            }

            $.Schedule(hudPanel && btn ? 0.05 : 0.5, () => this.monitorEscapeMenu(root));
        },

        getRoot: function(p) {
            while (p.GetParent && p.GetParent()) p = p.GetParent();
            return p;
        }
    };

    AnitaCore.init();

})();
