/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Ci = Components.interfaces;
const Cu = Components.utils;

/* exported OmniboxOverrideManager */

this.EXPORTED_SYMBOLS = [ "OmniboxOverrideManager" ];

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

Components.utils.import("resource://gre/modules/Console.jsm");
const console = new ConsoleAPI();

/**
 * Keeps track of opened/closed browser windows creating/destroying instances of
 * CustomOmnibox for them. Exposes common API for manipulating override documents.
 *
 * Only one instance of OmniboxOverride is created per extension and only one 
 * should be active at a time (OmniboxOverrideManager takes care of it).
 */
class OmniboxOverride extends EventEmitter {
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
    for(let [window, omnibox] of this._overridesMap.entries()) {
      omnibox.destroy();
    }
    this._overridesMap.clear();
    this._windowTracker.removeCloseListener(this.onWindowClosed);
    this._windowTracker.removeOpenListener(this.onWindowOpened);
  }

  _onWindowOpened(window) {
    const omnibox = new CustomOmnibox(window, this._omniboxURL, this);
    this._overridesMap.set(window, omnibox);
  }

  _onWindowClosed(window) {
    const omnibox = this._overridesMap.get(window);
    if (omnibox) {
      omnibox.destroy();
      this._overridesMap.delete(window);
    }
  }

  /**
   * Returns an instance of CustomOmnibox for browser window with given ID/context.
   * If window ID is null, context.currentWindow assumed. It throws if request
   * was made from "background" context without spcifying window ID.
   *
   * @param {integer|null} id
   * @param {BaseContext} context
   * @return {Promise<CustomOmnibox>}
   * @private
   */
  _getOmnibox(id, context) {
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
    const omnibox = this._overridesMap.get(window);
    if (!omnibox) {
      return Promise.reject({ message: "No omnibox override exists for this window." });
    }
    return Promise.resolve(omnibox);
  }

  /**
   * Generates a SingletonEventManager for given eventName and context.
   * Background scripts see events from every window, while other see only 
   * form their context.
   * 
   * @param  {string} eventName
   * @param  {BaseContext} context
   * @return {function}
   */
  _generateEventManager(eventName, context) {
    const name = eventName[0].toUpperCase() + eventName.slice(1);

    return new SingletonEventManager(context, `omnibox.on${name}`, fire => {
      const listener = (eventName, window, details = {}) => {
        const id = this._windowTracker.getId(window);
        if (context.viewType === "background" || context.windowId === id) {
          details.windowId = id;
          fire.async(details);
        }
      };
      this.on(eventName, listener);
      return () => {
        this.off(eventName, listener);
      }
    }).api();
  }

  /**
   * Provides API for manipulating omniboxes. 
   * If methods are called from non-background context window ID can be omitted.
   *
   * @param {BaseContext} context
   * @return {object} API
   */
  getAPI(context) {
    return {
      get: (opt_windowId) => {
        return this._getOmnibox(opt_windowId, context)
          .then((omnibox) => {
            const details = omnibox.getOverrideDetails();
            details.windowId = opt_windowId === null ? context.windowId : opt_windowId;
            return details;
          });
      },

      update: (opt_windowId, details) => {
        return this._getOmnibox(opt_windowId, context)
          .then(omnibox => omnibox.updateOverrideDetails(details));
      },

      setMaxResults: (maxResults) => {
        this.maxResults = maxResults;
        return Promise.resolve(maxResults);
      },

      getMaxResults: () => {
        return Promise.resolve(this.maxResults);
      },

      focus: (opt_windowId) => {
        return this._getOmnibox(opt_windowId, context)
          .then(omnibox => omnibox.focus());
      },

      blur: (opt_windowId) => {
        return this._getOmnibox(opt_windowId, context)
          .then(omnibox => omnibox.blur());
      },

      enter: (opt_windowId) => {
        return this._getOmnibox(opt_windowId, context)
          .then(omnibox => omnibox.enter());
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

/**
 * Handles overriding the omnibox for given browser window by injecting a Browser element 
 * into the original autocomplete popup and redefining urlbar-rich-result-popup's 
 * "_invalidate" method.
 *
 * One instance of CustomOmnibox is created per each browser window.
 * All events are emitted to the parent OmniboxOverride object and handled there.
 */
class CustomOmnibox {
  constructor(win, omniboxURL, owner) {
    this._window = win;
    this._tempPanel = this.document.getElementById("mainPopupSet");
    this._popup = this.document.getElementById("PopupAutoCompleteRichResult");
    this._urlbar = win.gURLBar;
    this._owner = owner;
    this._init(omniboxURL);
  }
  get document() {
    return this._window.document;
  }

  _init(omniboxURL) {
    this._popup.requestAutocompletePopupOverride({
      _invalidate: this._invalidate.bind(this)
    });
    // Original autocomplete popup is lazily initialized. In order for 
    // override document to be accessible immediately from extension 
    // create a temporary Browser element inside mainPopupSet.
    // Later on it will be attached to a real popup.
    this._browser = this._createBrowser(this._tempPanel, omniboxURL);
    this._urlbar.addEventListener("keydown", this);
    this._urlbar.addEventListener("input", this);
    this._urlbar.addEventListener("focus", this);
    this._urlbar.addEventListener("blur", this);  
    this._popup.addEventListener("popupshown", this);
  }

  destroy() {
    this._owner = null;
    this._popup.releaseAutocompletePopupOverride();
    this._destroyBrowser(this._browser);
    this._urlbar.removeEventListener("keydown", this);
    this._urlbar.removeEventListener("input", this);
    this._urlbar.removeEventListener("focus", this);
    this._urlbar.removeEventListener("blur", this);
    this._popup.removeEventListener("popupshown", this);
    this._popup.style.height = "";
  }

  _createBrowser(viewNode, omniboxURL = null) {
    const browser = this.document.createElementNS(XUL_NS, "browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("class", "webextension-omnibox-browser");
    browser.setAttribute("webextension-view-type", "popup");
    browser.setAttribute("flex", "1");
    browser.style.MozUserFocus = "ignore";

    browser.addEventListener("focus", (e) => {
      console.log('focus:', e);
    });

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
  }

  _destroyBrowser(browser) {
    const mm = browser.messageManager;
    if (mm) {
      mm.removeMessageListener("Extension:BrowserResized", this);
    }
    browser.remove();
  }

  /**
   * Inject a Browser holding omnibox override document into an autocomplete popup
   * by creating another Browser element inside popup and swapping documents between them.
   *
   * @private
   */
  _attach() {
    const browser = this._browser;
    const viewNode = this.document.getAnonymousElementByAttribute(this._popup, 
      "anonid", "popupoverride");
    this._browser = this._createBrowser(viewNode);
    this._browser.swapDocShells(browser);
    this._destroyBrowser(browser);
  }

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
  }

  handleEvent(event) {
    switch(event.type) {
      case "popupshown":
        // Since popup is shown we can safely attach browser to it.
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
  }

  receiveMessage({name, data}) {
    if (name === "Extension:BrowserResized") {
      this.height = data.height;
    }
  }

  /**
   * Returns all current override parameters.
   * 
   * @return {integer}  details.height Popup height
   * @return {string}   details.value Urlbar text
   * @return {integer}  details.selectionStart
   * @return {integer}  details.selectionEnd
   */
  getOverrideDetails() {
    return {
      height: this.height,
      value: this.value,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
    };
  }

  /**
   * Single method for updating any parameter of the overriden popup. 
   * 
   * @param  {object}   details
   * @param  {integer}  details.height Popup height
   * @param  {string}   details.value Urlbar text
   * @param  {integer}  details.selectionStart
   * @param  {integer}  details.selectionEnd
   */
  updateOverrideDetails(details) {
    for (let [prop, value] of Object.entries(details)) {
      // Input has already been validated through JSON schema, so no need to 
      // do it again.
      this[prop] = value;
    }
  }

  /**
   * Overriden popup's own "_invalidate" method. Is called from the popup
   * directly.
   * 
   * @private
   */
  _invalidate() {
    let controller = this._popup.mInput.controller;

    if(this._currentUrlbarValue !== controller.searchString){
      this._currentIndex = 0;
      this._owner.emit("reset", this._window);
      this._currentUrlbarValue = controller.searchString;
    }
    this._appendCurrentResult();
  }

  /**
   * This emulates the popup's own _appendCurrentResult method, except instead
   * of appending results to the popup, it emits "result" events to the parent 
   * OmniboxOverride object.
   *
   * @private
   */
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
  }

  focus() {
    this._urlbar.focus();
  }

  blur() {
    this._urlbar.blur();
  }

  enter() {
    this._urlbar.handleCommand();
  }

  get height() {
    return this._browser.getBoundingClientRect().height;
  }

  set height(val) {
    this._popup.style.height = val + "px";
    this._browser.style.height = val + "px";
  }

  get value() {
    return this._urlbar.value;
  }

  set value(val) {
    this._urlbar.value = val;
  }

  get selectionStart() {
    return this._urlbar.selectionStart;
  }

  set selectionStart(val) {
    this._urlbar.selectionStart = val;
  }

  get selectionEnd() {
    return this._urlbar.selectionEnd;
  }

  set selectionEnd(val) {
    this._urlbar.selectionEnd = val;
  }
}


/**
 * Handles keeping track of all extensions attempting to take over the omnibox,
 * making sure that only one override is working at a time.
 * Returns API for currently active OmniboxOverride.
 */
this.OmniboxOverrideManager = {
  _activeOverride: null,
  _overridesQueue: [],

  _activateNext() {
    if (this._overridesQueue.length === 0) {
      this._activeOverride = null;
      return;
    }

    const {id, url, windowTracker} = this._overridesQueue.shift();
    const override = new OmniboxOverride(url, windowTracker);
    this._activeOverride = { id, override };
  },

  get hasActiveOverride() {
    return Boolean(this._activeOverride);
  },

  /**
   * Registers an extension wanting to override the omnibox. 
   * If this is the only candidate it immediately activates, otherwise 
   * it is put into queue.
   * @param  {string} id Extension ID
   * @param  {string} url
   * @param  {[type]} windowTracker
   */
  register(id, url, windowTracker) {
    this._overridesQueue.push({
      id, url, windowTracker
    });
    if (!this.hasActiveOverride) {
      this._activateNext();
    }
  },

  /**
   * Unregisters an extension with given ID. Either by removing it from waiting 
   * queue or by destroying the corresponding override object.
   * @param  {string} id Extension ID
   */
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

  /**
   * Returns API for currently active omnibox override for given context.
   * @param  {BaseContext} context
   * @return {object} API
   */
  getAPI(context) {
    return this.hasActiveOverride ? 
      this._activeOverride.override.getAPI(context) : {};
  }
};
