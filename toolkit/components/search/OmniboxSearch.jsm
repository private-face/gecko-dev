/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

this.EXPORTED_SYMBOLS = [ "OmniboxSearch" ];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

function log(s){
  Services.console.logStringMessage("OmniboxExperiment: " + s);
}

this.OmniboxSearch = {
  register(url){
    log("ACPopup register " + url);

    BrowserListener.init(url);
  },
  reset(){
    log("ACPopup reset ");

    BrowserListener.destroy();
  }
}

/* BrowserListener.jsm */

this.BrowserListener = {

  init(iframeURL) {
    if (this.browsers) {
      return;
    }
    this.iframeURL = iframeURL;
    this.browsers = new Set();
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
        this.browsers.add(new Browser(win, this.iframeURL));
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

function Browser(win, iframeURL) {
  this.window = win;
  this.iframeURL = iframeURL;
  this._initPanel();
}

Browser.prototype = {
  get document() {
    return this.window.document;
  },

  destroy() {
    if (this._panel) {
      this._panel.destroy();
    }
  },

  _initPanel() {
    let elt = this.document.getElementById("PopupAutoCompleteRichResult");
    this._panel = new Panel(elt, this.iframeURL);
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

/* Panel.jsm */

this.Panel = function (panelElt, iframeURL) {
  this.p = panelElt;
  this.iframeURL = iframeURL;
  this._initPanel();
  this.urlbar.addEventListener("keydown", this);
  this.urlbar.addEventListener("input", this);
  this.urlbar.addEventListener("focus", this);
  this.urlbar.addEventListener("blur", this);
  this._emitQueue = [];
};

this.Panel.prototype = {

  get document() {
    return this.p.ownerDocument;
  },

  get window() {
    return this.document.defaultView;
  },

  get urlbar() {
    return this.window.gURLBar;
  },

  iframe: null,

  get iframeDocument() {
    return this.iframe.contentDocument;
  },

  get iframeWindow() {
    return this.iframe.contentWindow;
  },

  destroy() {
    this.p.destroyAddonIframe(this);
    this.urlbar.removeEventListener("keydown", this);
    this.urlbar.removeEventListener("input", this);
    this.urlbar.removeEventListener("focus", this);
    this.urlbar.removeEventListener("focus", this);
  },

  _initPanel() {
    this.iframe = this.p.initAddonIframe(this, {
      _invalidate: this._invalidate.bind(this),
    });
    if (!this.iframe) {
      // This will be the case when somebody else already owns the iframe.
      // First consumer wins right now.
      return;
    }
    let onLoad = event => {
      this.iframe.removeEventListener("load", onLoad, true);
      this._initIframeContent(event.target.defaultView);
    };
    this.iframe.addEventListener("load", onLoad, true);
    this.iframe.setAttribute("src", this.iframeURL);
  },

  _initIframeContent(win) {
    // Clone the urlbar API functions into the iframe window.
    win = XPCNativeWrapper.unwrap(win);
    let apiInstance = Cu.cloneInto(iframeAPIPrototype, win, {
      cloneFunctions: true,
    });
    XPCNativeWrapper.unwrap(apiInstance)._panel = this;
    Object.defineProperty(win, "urlbar", {
      get() {
        return apiInstance;
      },
    });
  },

  // This is called by the popup directly.  It overrides the popup's own
  // _invalidate method.
  _invalidate() {
    let controller = this.p.mInput.controller;

    if(this._currentUrlbarValue !== controller.searchString){
      this._currentIndex = 0;
      this._emit("reset");
      this._currentUrlbarValue = controller.searchString;
    }
    this._appendCurrentResult();
  },

  // This emulates the popup's own _appendCurrentResult method, except instead
  // of appending results to the popup, it emits "result" events to the iframe.
  _appendCurrentResult() {
    const controller = this.p.mInput.controller;
    const maxResults = Math.min(this.p.maxResults, this.p._matchCount);

    const results = [];
    for(let index = 0; index < maxResults; index++) {
      let url = controller.getValueAt(index);
      results.push({
        url: url,
        image: controller.getImageAt(index),
        title: controller.getCommentAt(index),
        type: controller.getStyleAt(index),
        action: this.urlbar._parseActionUrl(url)
      });
    }

    this._emit("results", {
      results,
      searchStatus: controller.searchStatus,
      query: controller.searchString.trim()
    });
  },

  get height() {
    return this.iframe.getBoundingClientRect().height;
  },

  set height(val) {
    this.p.removeAttribute("height");
    this.iframe.style.height = val + "px";
  },

  handleEvent(event) {
    let methName = "_on" + event.type[0].toUpperCase() + event.type.substr(1);
    this[methName](event);
  },

  _onKeydown(event) {
    let emittedEvent = this._emitUrlbarEvent(event);
    if (emittedEvent && emittedEvent.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
    }
  },

  _onInput(event) {
    this._emitUrlbarEvent(event);
  },

  _onFocus(event) {
    this._emitUrlbarEvent(event);
  },

  _onBlur(event) {
    this._emitUrlbarEvent(event);
  },

  _emitUrlbarEvent(event) {
    let properties = [
      "altKey",
      "code",
      "ctrlKey",
      "key",
      "metaKey",
      "shiftKey",
    ];
    let detail = properties.reduce((memo, prop) => {
      memo[prop] = event[prop];
      return memo;
    }, {});
    return this._emit(event.type, detail);
  },

  _emit(eventName, detailObj=null) {
    this._emitQueue.push({
      name: "urlbar_" + eventName,
      detail: detailObj,
    });
    return this._processEmitQueue();
  },

  _processEmitQueue() {
    if (!this._emitQueue.length) {
      return null;
    }

    // iframe.contentWindow can be undefined right after the iframe is created,
    // even after a number of seconds have elapsed.  Don't know why.  But that's
    // entirely the reason for having a queue instead of simply dispatching
    // events as they're created, unfortunately.
    if (!this.iframeWindow) {
      if (!this._processEmitQueueTimer) {
        this._processEmitQueueTimer =
          Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this._processEmitQueueTimer.init(() => {
          this._processEmitQueue();
        }, 100, Ci.nsITimer.TYPE_REPEATING_SLACK);
      }
      return null;
    }

    if (this._processEmitQueueTimer) {
      this._processEmitQueueTimer.cancel();
      delete this._processEmitQueueTimer;
    }

    let { name, detail } = this._emitQueue.shift();
    let win = XPCNativeWrapper.unwrap(this.iframeWindow);
    let event = new this.iframeWindow.CustomEvent(name, {
      detail: Cu.cloneInto(detail, win),
      cancelable: true,
    });
    this.iframeWindow.dispatchEvent(event);

    // More events may be queued up, so recurse.  Do it after a turn of the
    // event loop to avoid growing the stack as big as the queue, and to let the
    // caller handle the returned event first.
    let recurseTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    recurseTimer.init(() => {
      this._processEmitQueue();
    }, 100, Ci.nsITimer.TYPE_ONE_SHOT);

    return event;
  },
};


// This is the consumer API that's cloned into the iframe window.  Be careful of
// defining static values on this, or even getters and setters (that aren't real
// functions).  The cloning process means that such values are copied by value,
// at the time of cloning, which is probably not what you want.  That's why some
// of these are functions even though it'd be nicer if they were getters and
// setters.
let iframeAPIPrototype = {

  getPanelHeight() {
    return XPCNativeWrapper.unwrap(this)._panel.height;
  },

  setPanelHeight(val) {
    XPCNativeWrapper.unwrap(this)._panel.height = val;
  },

  getValue() {
    return XPCNativeWrapper.unwrap(this)._panel.urlbar.value;
  },

  setValue(val) {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.value = val;
  },

  getMaxResults() {
    return XPCNativeWrapper.unwrap(this)._panel.p.maxResults;
  },

  setMaxResults(val) {
    //TODO: val can only be smaller or equal with "browser.urlbar.maxRichResults"
    XPCNativeWrapper.unwrap(this)._panel.p.maxResults = val;
  },

  getSelectionStart() {
    return XPCNativeWrapper.unwrap(this)._panel.urlbar.selectionStart;
  },

  setSelectionStart(val) {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.selectionStart = val;
  },

  getSelectionEnd() {
    return XPCNativeWrapper.unwrap(this)._panel.urlbar.selectionEnd;
  },

  setSelectionEnd(val) {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.selectionEnd = val;
  },

  setSelectionRange(start, end) {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.setSelectionRange(start, end);
  },

  enter() {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.handleCommand();
  },

  focus() {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.focus();
  },

  blur() {
    XPCNativeWrapper.unwrap(this)._panel.urlbar.blur();
  },
};
