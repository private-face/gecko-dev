/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
"use strict";

// The ext-* files are imported into the same scopes.
/* import-globals-from ../../../toolkit/components/extensions/ext-toolkit.js */

XPCOMUtils.defineLazyModuleGetter(this, "ExtensionSearchHandler",
                                  "resource://gre/modules/ExtensionSearchHandler.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "OmniboxSearch",
                                  "resource://gre/modules/OmniboxSearch.jsm");

// TODO: remove me
XPCOMUtils.defineLazyModuleGetter(this, "Services",
                                  "resource://gre/modules/Services.jsm");

Components.utils.import("resource://gre/modules/Console.jsm");
const console = new ConsoleAPI();

this.omnibox = class extends ExtensionAPI {
  onManifestEntry(entryName) {
    let {extension} = this;
    let {manifest} = extension;

    let keyword = manifest.omnibox.keyword;
    try {
      // This will throw if the keyword is already registered.
      ExtensionSearchHandler.registerKeyword(keyword, extension);
      this.keyword = keyword;
    } catch (e) {
      extension.manifestError(e.message);
    }

    if (manifest.omnibox.dropdown_override) {
      let dropdown = manifest.omnibox.dropdown_override;
      let url = extension.baseURI.resolve(dropdown);
      // Should we throw in case of existing overrides?
      OmniboxSearch.register(extension.id, url, windowTracker);
    }
  }

  onShutdown(reason) {
    let {extension} = this;

    ExtensionSearchHandler.unregisterKeyword(this.keyword);
    OmniboxSearch.unregister(extension.id);
  }

  getAPI(context) {
    let {extension} = context;
    const OmniboxAPI = {
      omnibox: {
        setDefaultSuggestion: (suggestion) => {
          try {
            // This will throw if the keyword failed to register.
            ExtensionSearchHandler.setDefaultSuggestion(this.keyword, suggestion);
          } catch (e) {
            return Promise.reject(e.message);
          }
        },

        onInputStarted: new SingletonEventManager(context, "omnibox.onInputStarted", fire => {
          let listener = (eventName) => {
            fire.sync();
          };
          extension.on(ExtensionSearchHandler.MSG_INPUT_STARTED, listener);
          return () => {
            extension.off(ExtensionSearchHandler.MSG_INPUT_STARTED, listener);
          };
        }).api(),

        onInputCancelled: new SingletonEventManager(context, "omnibox.onInputCancelled", fire => {
          let listener = (eventName) => {
            fire.sync();
          };
          extension.on(ExtensionSearchHandler.MSG_INPUT_CANCELLED, listener);
          return () => {
            extension.off(ExtensionSearchHandler.MSG_INPUT_CANCELLED, listener);
          };
        }).api(),

        onInputEntered: new SingletonEventManager(context, "omnibox.onInputEntered", fire => {
          let listener = (eventName, text, disposition) => {
            fire.sync(text, disposition);
          };
          extension.on(ExtensionSearchHandler.MSG_INPUT_ENTERED, listener);
          return () => {
            extension.off(ExtensionSearchHandler.MSG_INPUT_ENTERED, listener);
          };
        }).api(),
      },

      omnibox_internal: {
        addSuggestions: (id, suggestions) => {
          try {
            ExtensionSearchHandler.addSuggestions(this.keyword, id, suggestions);
          } catch (e) {
            // Silently fail because the extension developer can not know for sure if the user
            // has already invalidated the callback when asynchronously providing suggestions.
          }
        },

        onInputChanged: new SingletonEventManager(context, "omnibox_internal.onInputChanged", fire => {
          let listener = (eventName, text, id) => {
            fire.sync(text, id);
          };
          extension.on(ExtensionSearchHandler.MSG_INPUT_CHANGED, listener);
          return () => {
            extension.off(ExtensionSearchHandler.MSG_INPUT_CHANGED, listener);
          };
        }).api(),
      },
    };
    
    Object.assign(OmniboxAPI.omnibox, OmniboxSearch.getAPI(context));

    return OmniboxAPI;
  }
};
