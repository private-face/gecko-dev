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

const {
  promiseEvent,
} = ExtensionUtils;

const { SingletonEventManager } = ExtensionCommon;

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

const BrowserWindows = new WeakMap();

class OmniboxSearchOverride extends EventEmitter {
  constructor() {
    super();
    this.maxResults = 20;
  }

  register(url, windowTracker) {
    this.windowTracker = windowTracker;
    BrowserListener.init(url);
  }

  reset() {
    BrowserListener.destroy();
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
      window = this.windowTracker.getWindow(id, context);
    }
    if (!window) {
      return Promise.reject({ message: `Invalid window ID: ${id}` });
    }
    const browser = BrowserWindows.get(window);
    if (!browser) {
      return Promise.reject({ message: "No omnibox override exists for this window." });
    }
    return Promise.resolve(browser);
  }

  _generateEventManager(eventName, context) {
    const name = eventName[0].toUpperCase() + eventName.slice(1);

    return new SingletonEventManager(context, `omnibox.on${name}`, fire => {
      const listener = (eventName, window, details) => {
        const id = this.windowTracker.getId(window);
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

const omniboxSearch = new OmniboxSearchOverride;

this.OmniboxSearch = omniboxSearch;

this.BrowserListener = {
  init(omniboxURL) {
    if (this.browsers) {
      return;
    }
    this.omniboxURL = omniboxURL;
    this.browsers = new Set();
    // TODO see if we could make use of windowTracker events here
    // see:   windowTracker.addOpenListener(this._handleWindowOpen);
    //        windowTracker.addCloseListener(this._handleWindowClose);
    // instead of doing everything ourselves 
    this.registerOpenBrowserWindows();
    Services.ww.registerNotification(this);
  },

  destroy() {
    if (!this.browsers) {
      return;
    }
    Services.ww.unregisterNotification(this);
    for (let browser of this.browsers) {
      browser.destroy();
    }
    this.browsers.clear();
    delete this.browsers;
  },

  registerOpenBrowserWindows() {
    let wins = Services.ww.getWindowEnumerator();
    while (wins.hasMoreElements()) {
      let win = wins.getNext().QueryInterface(Ci.nsIDOMWindow);
      this.registerPossibleBrowserWindow(win);
    }
  },

  registerPossibleBrowserWindow(win) {
    promiseWindowLoaded(win).then(() => {
      if (isValidBrowserWindow(win)) {
        this.browsers.add(new Browser(win, this.omniboxURL));
      }
    });
  },

  observe(subj, topic, data) {
    let win = subj.QueryInterface(Ci.nsIDOMWindow);
    if (!win) {
      return;
    }
    if (topic == "domwindowopened") {
      this.registerPossibleBrowserWindow(win);
    } else if (topic == "domwindowclosed") {
      for (let browser of this.browsers) {
        if (browser.window == win) {
          browser.destroy();
          this.browsers.delete(browser);
          break;
        }
      }
    }
  },
};

function isValidBrowserWindow(win) {
  return !win.closed &&
         win.toolbar.visible &&
         win.document.documentElement.getAttribute("windowtype") ==
           "navigator:browser";
}

function promiseWindowLoaded(win, callback) {
  return new Promise(resolve => {
    if (win.document.readyState == "complete") {
      resolve();
      return;
    }
    win.addEventListener("load", function onLoad(event) {
      if (event.target == win.document) {
        win.removeEventListener("load", onLoad, true);
        win.setTimeout(resolve);
      }
    }, true);
  });
}

function Browser(win, omniboxURL) {
  if (BrowserWindows.has(win)) {
    return BrowserWindows.get(win);
  }
  this.window = win;
  this.tempPanel = this.document.getElementById("mainPopupSet");
  this.p = this.document.getElementById("PopupAutoCompleteRichResult");
  this._urlbar = win.gURLBar;

  this.isOverrideAllowed = this.p.requestAutocompletePopupOverride(this, {
    _invalidate: this._invalidate.bind(this)
  });

  if (this.isOverrideAllowed) {
    this.browser = this._createBrowser(this.tempPanel, omniboxURL);
    this._urlbar.addEventListener("keydown", this);
    this._urlbar.addEventListener("input", this);
    this._urlbar.addEventListener("focus", this);
    this._urlbar.addEventListener("blur", this);  
    this.p.addEventListener("popupshown", this);
    BrowserWindows.set(this.window, this);
  }
}

Browser.prototype = {
  get document() {
    return this.window.document;
  },

  destroy() {
    if (!this.isOverrideAllowed) {
      return;
    }

    this.p.releaseAutocompletePopupOverride(this);
    this._destroyBrowser(this.browser);
    this._urlbar.removeEventListener("keydown", this);
    this._urlbar.removeEventListener("input", this);
    this._urlbar.removeEventListener("focus", this);
    this._urlbar.removeEventListener("blur", this);
    this.p.removeEventListener("popupshown", this);
    BrowserWindows.delete(this.window, this);
    this.p.style.height = "";
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
    const browser = this.browser;
    const viewNode = this.document.getAnonymousElementByAttribute(this.p, 
      "anonid", "popupoverride");
    this.browser = this._createBrowser(viewNode);
    this.browser.swapDocShells(browser);
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
        this.p.removeEventListener("popupshown", this);
        break;
      case "focus":
      case "blur":
        omniboxSearch.emit(event.type, this.window);
        break;
      case "input":
        omniboxSearch.emit(event.type, this.window, {
          value: this.value
        });
        break;
      case "keydown":
        omniboxSearch.emit(event.type, this.window, 
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
      if (modifiableProps.indexOf(prop) !== -1) {
        this[prop] = value;
      }
    }
  },

  // This is called by the popup directly.  It overrides the popup's own
  // _invalidate method.
  _invalidate() {
    let controller = this.p.mInput.controller;

    if(this._currentUrlbarValue !== controller.searchString){
      this._currentIndex = 0;
      omniboxSearch.emit("reset", this.window);
      this._currentUrlbarValue = controller.searchString;
    }
    this._appendCurrentResult();
  },

  // This emulates the popup's own _appendCurrentResult method, except instead
  // of appending results to the popup, it emits "result" events.
  _appendCurrentResult() {
    const controller = this.p.mInput.controller;
    const maxResults = Math.min(omniboxSearch.maxResults, this.p._matchCount);

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

    omniboxSearch.emit("results", this.window, {
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
    return this.browser.getBoundingClientRect().height;
  },

  set height(val) {
    this.p.style.height = val + "px";
    this.browser.style.height = val + "px";
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