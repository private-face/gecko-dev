/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Ci = Components.interfaces;
const Cu = Components.utils;

this.EXPORTED_SYMBOLS = [ "OmniboxSearch" ];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ExtensionUtils.jsm");
Cu.import("resource://gre/modules/EventEmitter.jsm");
Cu.import("resource://gre/modules/ExtensionCommon.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "ExtensionParent",
                                  "resource://gre/modules/ExtensionParent.jsm");

const { promiseEvent } = ExtensionUtils;
const { SingletonEventManager } = ExtensionCommon;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const DEFAULT_MAX_RESULTS = 20;

class OmniboxSearchOverride extends EventEmitter {
  constructor(ominboxURL, windowTracker) {
    super();
    this._overridesMap = new Map();
    this._omniboxURL = ominboxURL;
    this._windowTracker = windowTracker;
    this.maxResults = DEFAULT_MAX_RESULTS;
    this._init();
  }

  _init() {
    this.onWindowOpened = this._onWindowOpened.bind(this);
    this.onWindowClosed = this._onWindowClosed.bind(this);
    this._windowTracker.addOpenListener(this.onWindowOpened);
    this._windowTracker.addCloseListener(this.onWindowClosed);
    for(let window of this._windowTracker.browserWindows()) {
      this.onWindowOpened(window);
    }
  }

  destroy() {
    for(let [window, browser] of this._overridesMap.entries()) {
      browser.destroy();
    }
    this._overridesMap.clear();
    this._windowTracker.removeCloseListener(this.onWindowClosed);
    this._windowTracker.removeOpenListener(this.onWindowOpened);
  }

  _onWindowOpened(window) {
    const browser = new Browser(window, this._omniboxURL, this);
    if (browser.isOverrideAllowed) {
      this._overridesMap.set(window, browser);
    }
  }

  _onWindowClosed(window) {
    const browser = this._overridesMap.get(window);
    if (browser) {
      browser.destroy();
      this._overridesMap.delete(window);
    }
  }

  _getBrowser(id, context) {
    let window = null;
    if (id === null) {
      if (context.viewType === "background") {
        // There is no 'default' omnibox for background page, 
        // you have to specify windowId.
        return Promise.reject({ message: "Missing window ID." });
      } else {
        window = context.currentWindow;
      }
    } else {
      window = this._windowTracker.getWindow(id, context);
    }
    if (!window) {
      return Promise.reject({ message: `Invalid window ID: ${id}` });
    }
    const browser = this._overridesMap.get(window);
    if (!browser) {
      return Promise.reject({ message: "No omnibox override exists for this window." });
    }
    return Promise.resolve(browser);
  }

  _generateEventManager(eventName, context) {
    const name = eventName[0].toUpperCase() + eventName.slice(1);

    return new SingletonEventManager(context, `omnibox.on${name}`, fire => {
      const listener = (eventName, window, details) => {
        const id = this._windowTracker.getId(window);
        if (context.viewType === "background" || context.windowId === id) {
          if (details) {
            details.windowId = id;
            fire.async(details);
          } else {
            fire.async();
          }
        }
      };
      this.on(eventName, listener);
      return () => {
        this.off(eventName, listener);
      }
    }).api();
  }

  getAPI(context) {
    return {
      get: (opt_windowId) => {
        return this._getBrowser(opt_windowId, context)
          .then((browser) => {
            const details = browser.getOverrideDetails();
            details.windowId = opt_windowId === null ? context.windowId : opt_windowId;
            return details;
          });
      },

      update: (opt_windowId, details) => {
        return this._getBrowser(opt_windowId, context)
          .then(browser => browser.updateOverrideDetails(details));
      },

      setMaxResults: (maxResults) => {
        this.maxResults = maxResults;
        return Promise.resolve(maxResults);
      },

      getMaxResults: () => {
        return Promise.resolve(this.maxResults);
      },

      focus: (opt_windowId) => {
        return this._getBrowser(opt_windowId, context)
          .then(browser => browser.focus());
      },

      blur: (opt_windowId) => {
        return this._getBrowser(opt_windowId, context)
          .then(browser => browser.blur());
      },

      enter: (opt_windowId) => {
        return this._getBrowser(opt_windowId, context)
          .then(browser => browser.enter());
      },

      onInput: this._generateEventManager("input", context),
      onKeydown: this._generateEventManager("keydown", context),
      onFocus: this._generateEventManager("focus", context),
      onBlur: this._generateEventManager("blur", context),
      onReset: this._generateEventManager("reset", context),
      onResults: this._generateEventManager("results", context),
    };
  }
}

this.OmniboxSearch = {
  _activeOverride: null,
  _overridesQueue: [],

  _activateNext() {
    if (this._overridesQueue.length === 0) {
      this._activeOverride = null;
      return;
    }

    const {id, url, windowTracker} = this._overridesQueue.shift();
    const override = new OmniboxSearchOverride(url, windowTracker);
    this._activeOverride = { id, override };
  },

  get hasActiveOverride() {
    return Boolean(this._activeOverride);
  },

  register(id, url, windowTracker) {
    this._overridesQueue.push({
      id, url, windowTracker
    });
    if (!this.hasActiveOverride) {
      this._activateNext();
    }
  },

  unregister(id) {
    if (this._activeOverride && this._activeOverride.id === id) {
      this._activeOverride.override.destroy();
      this._activateNext();
    } else {
      const index = this._overridesQueue.findIndex(o => o.id === id);
      if (index !== -1) {
        this._overridesQueue.splice(index, 1);
      }
    }
  },

  getAPI(context) {
    return this.hasActiveOverride ? 
      this._activeOverride.override.getAPI(context) : {};
  }
};

function Browser(win, omniboxURL, owner) {
  this._window = win;
  this._tempPanel = this.document.getElementById("mainPopupSet");
  this._popup = this.document.getElementById("PopupAutoCompleteRichResult");
  this._urlbar = win.gURLBar;

  this.isOverrideAllowed = this._popup.requestAutocompletePopupOverride(this, {
    _invalidate: this._invalidate.bind(this)
  });

  if (this.isOverrideAllowed) {
    this._owner = owner;
    this._browser = this._createBrowser(this._tempPanel, omniboxURL);
    this._urlbar.addEventListener("keydown", this);
    this._urlbar.addEventListener("input", this);
    this._urlbar.addEventListener("focus", this);
    this._urlbar.addEventListener("blur", this);  
    this._popup.addEventListener("popupshown", this);
  }
}

Browser.prototype = {
  get document() {
    return this._window.document;
  },

  destroy() {
    if (!this.isOverrideAllowed) {
      return;
    }

    this._owner = null;
    this._popup.releaseAutocompletePopupOverride(this);
    this._destroyBrowser(this._browser);
    this._urlbar.removeEventListener("keydown", this);
    this._urlbar.removeEventListener("input", this);
    this._urlbar.removeEventListener("focus", this);
    this._urlbar.removeEventListener("blur", this);
    this._popup.removeEventListener("popupshown", this);
    this._popup.style.height = "";
  },

  _createBrowser(viewNode, omniboxURL = null) {
    const browser = this.document.createElementNS(XUL_NS, "browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("class", "webextension-omnibox-browser");
    browser.setAttribute("webextension-view-type", "popup");
    browser.setAttribute("tooltip", "aHTMLTooltip");
    browser.setAttribute("contextmenu", "contentAreaContextMenu");
    browser.setAttribute("autocompletepopup", "PopupAutoComplete");
    browser.setAttribute("flex", "1");

    const readyPromise = promiseEvent(browser, "load");
    viewNode.appendChild(browser);

    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);

    if (!omniboxURL) {
      browser.messageManager.addMessageListener("Extension:BrowserResized", this);
      return browser;
    }

    readyPromise.then(() => {
      let mm = browser.messageManager;
      mm.loadFrameScript("chrome://browser/content/content.js", true);
      mm.loadFrameScript(
        "chrome://extensions/content/ext-browser-content.js", false);
      mm.sendAsyncMessage("Extension:InitBrowser", {
        allowScriptsToClose: true,
        blockParser: false,
        fixedWidth: false,
        maxWidth: Infinity,
        maxHeight: Infinity,
        stylesheets: [],
        isInline: false
      });
      browser.loadURI(omniboxURL);
    });

    return browser;
  },

  _destroyBrowser(browser) {
    const mm = browser.messageManager;
    if (mm) {
      mm.removeMessageListener("Extension:BrowserResized", this);
    }
    browser.remove();
  },

  _attach() {
    const browser = this._browser;
    const viewNode = this.document.getAnonymousElementByAttribute(this._popup, 
      "anonid", "popupoverride");
    this._browser = this._createBrowser(viewNode);
    this._browser.swapDocShells(browser);
    this._destroyBrowser(browser);
  },

  _getUrlbarEventDetails(event) {
    let properties = [
      "altKey",
      "code",
      "ctrlKey",
      "key",
      "metaKey",
      "shiftKey",
    ];
    return properties.reduce((memo, prop) => {
      memo[prop] = event[prop];
      return memo;
    }, {});
  },

  handleEvent(event) {
    switch(event.type) {
      case "popupshown":
        this._attach();
        this._popup.removeEventListener("popupshown", this);
        break;
      case "focus":
      case "blur":
        this._owner.emit(event.type, this._window);
        break;
      case "input":
        this._owner.emit(event.type, this._window, {
          value: this.value
        });
        break;
      case "keydown":
        this._owner.emit(event.type, this._window, 
          this._getUrlbarEventDetails(event));  
        break;
    }
  },

  receiveMessage({name, data}) {
    if (name === "Extension:BrowserResized") {
      this.height = data.height;
    }
  },

  getOverrideDetails() {
    return {
      height: this.height,
      value: this.value,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
    };
  },

  updateOverrideDetails(details) {
    const modifiableProps = ["value", "selectionStart", "selectionEnd", "height"];
    for (let [prop, value] of Object.entries(details)) {
      // TODO make sure json schema takes care of the arguments validation and 
      // remove this check.
      if (modifiableProps.indexOf(prop) !== -1) {
        this[prop] = value;
      }
    }
  },

  // This is called by the popup directly.  It overrides the popup's own
  // _invalidate method.
  _invalidate() {
    let controller = this._popup.mInput.controller;

    if(this._currentUrlbarValue !== controller.searchString){
      this._currentIndex = 0;
      this._owner.emit("reset", this._window);
      this._currentUrlbarValue = controller.searchString;
    }
    this._appendCurrentResult();
  },

  // This emulates the popup's own _appendCurrentResult method, except instead
  // of appending results to the popup, it emits "result" events.
  _appendCurrentResult() {
    const controller = this._popup.mInput.controller;
    const maxResults = Math.min(this._owner.maxResults, this._popup._matchCount);

    const results = [];
    for(let index = 0; index < maxResults; index++) {
      const url = controller.getValueAt(index);
      results.push({
        url: url,
        image: controller.getImageAt(index),
        title: controller.getCommentAt(index),
        type: controller.getStyleAt(index),
        action: this._urlbar._parseActionUrl(url)
      });
    }

    this._owner.emit("results", this._window, {
      results,
      searchStatus: controller.searchStatus,
      query: controller.searchString.trim()
    });
  },

  focus() {
    this._urlbar.focus();
  },

  blur() {
    this._urlbar.blur();
  },

  enter() {
    this._urlbar.handleCommand();
  },

  get height() {
    return this._browser.getBoundingClientRect().height;
  },

  set height(val) {
    this._popup.style.height = val + "px";
    this._browser.style.height = val + "px";
  },

  get value() {
    return this._urlbar.value;
  },

  set value(val) {
    this._urlbar.value = val;
  },

  get selectionStart() {
    return this._urlbar.selectionStart;
  },

  set selectionStart(val) {
    this._urlbar.selectionStart = val;
  },

  get selectionEnd() {
    return this._urlbar.selectionEnd;
  },

  set selectionEnd(val) {
    this._urlbar.selectionEnd = val;
  }
};