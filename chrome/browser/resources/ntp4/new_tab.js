// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @fileoverview New tab page
 * This is the main code for the new tab page used by touch-enabled Chrome
 * browsers.  For now this is still a prototype.
 */

// Use an anonymous function to enable strict mode just for this file (which
// will be concatenated with other files when embedded in Chrome
cr.define('ntp', function() {
  'use strict';

  /**
   * NewTabView instance.
   * @type {!Object|undefined}
   */
  var newTabView;

  /**
   * The 'notification-container' element.
   * @type {!Element|undefined}
   */
  var notificationContainer;

  /**
   * Object for accessing localized strings.
   * @type {!LocalStrings}
   */
  var localStrings = new LocalStrings;

  /**
   * If non-null, an info bubble for showing messages to the user. It points at
   * the Most Visited label, and is used to draw more attention to the
   * navigation dot UI.
   * @type {!Element|undefined}
   */
  var infoBubble;

  /**
   * If non-null, an bubble confirming that the user has signed into sync. It
   * points at the login status at the top of the page.
   * @type {!Element|undefined}
   */
  var loginBubble;

  /**
   * true if |loginBubble| should be shown.
   * @type {Boolean}
   */
  var shouldShowLoginBubble = false;

  /**
   * The time in milliseconds for most transitions.  This should match what's
   * in new_tab.css.  Unfortunately there's no better way to try to time
   * something to occur until after a transition has completed.
   * @type {number}
   * @const
   */
  var DEFAULT_TRANSITION_TIME = 500;

  /**
   * Creates a NewTabView object. NewTabView extends PageListView with
   * new tab UI specific logics.
   * @constructor
   * @extends {PageListView}
   */
  function NewTabView() {
    this.initialize(getRequiredElement('page-list'),
                    getRequiredElement('dot-list'),
                    getRequiredElement('card-slider-frame'),
                    getRequiredElement('trash'),
                    getRequiredElement('page-switcher-start'),
                    getRequiredElement('page-switcher-end'));
  }

  NewTabView.prototype = {
    __proto__: ntp.PageListView.prototype,

    /** @inheritDoc */
    appendTilePage: function(page, title, titleIsEditable, opt_refNode) {
      ntp.PageListView.prototype.appendTilePage.apply(this, arguments);

      if (infoBubble)
        window.setTimeout(infoBubble.reposition.bind(infoBubble), 0);
    }
  };

  /**
   * Invoked at startup once the DOM is available to initialize the app.
   */
  function onLoad() {
    cr.enablePlatformSpecificCSSRules();

    measureNavDots();

    // Load the current theme colors.
    themeChanged();

    newTabView = new NewTabView();

    notificationContainer = getRequiredElement('notification-container');
    notificationContainer.addEventListener(
        'webkitTransitionEnd', onNotificationTransitionEnd);

    cr.ui.decorate($('recently-closed-menu-button'), ntp.RecentMenuButton);
    chrome.send('getRecentlyClosedTabs');

    newTabView.appendTilePage(new ntp.MostVisitedPage(),
                              localStrings.getString('mostvisited'),
                              false);
    chrome.send('getMostVisited');

    var webstoreLink = localStrings.getString('webStoreLink');
    if (templateData.isWebStoreExperimentEnabled) {
      var url = appendParam(webstoreLink, 'utm_source', 'chrome-ntp-launcher');
      $('chrome-web-store-href').href = url;
      $('chrome-web-store-href').addEventListener('click',
          onChromeWebStoreButtonClick);

      $('footer-content').classList.add('enable-cws-experiment');
    }

    if (templateData.appInstallHintEnabled) {
      var url = appendParam(webstoreLink, 'utm_source', 'chrome-ntp-plus-icon');
      $('app-install-hint-template').href = url;
    }

    if (localStrings.getString('login_status_message')) {
      loginBubble = new cr.ui.Bubble;
      loginBubble.anchorNode = $('login-container');
      loginBubble.setArrowLocation(cr.ui.ArrowLocation.TOP_END);
      loginBubble.bubbleAlignment =
          cr.ui.BubbleAlignment.BUBBLE_EDGE_TO_ANCHOR_EDGE;
      loginBubble.deactivateToDismissDelay = 2000;
      loginBubble.setCloseButtonVisible(false);

      $('login-status-learn-more').href =
          localStrings.getString('login_status_url');
      $('login-status-advanced').onclick = function() {
        chrome.send('showAdvancedLoginUI');
      };
      $('login-status-dismiss').onclick = loginBubble.hide.bind(loginBubble);

      var bubbleContent = $('login-status-bubble-contents');
      loginBubble.content = bubbleContent;

      // The anchor node won't be updated until updateLogin is called so don't
      // show the bubble yet.
      shouldShowLoginBubble = true;
    } else if (localStrings.getString('ntp4_intro_message')) {
      infoBubble = new cr.ui.Bubble;
      infoBubble.anchorNode = newTabView.mostVisitedPage.navigationDot;
      infoBubble.setArrowLocation(cr.ui.ArrowLocation.BOTTOM_START);
      infoBubble.handleCloseEvent = function() {
        this.hide();
        chrome.send('introMessageDismissed');
      };

      var bubbleContent = $('ntp4-intro-bubble-contents');
      infoBubble.content = bubbleContent;

      var learnMoreLink = infoBubble.querySelector('a');
      learnMoreLink.href = localStrings.getString('ntp4_intro_url');
      learnMoreLink.onclick = infoBubble.hide.bind(infoBubble);

      infoBubble.show();
      chrome.send('introMessageSeen');
    }

    var promo = localStrings.getString('serverpromo');
    if (promo) {
      var tags = ['IMG'];
      var attrs = {
        src: function(node, value) {
          return node.tagName == 'IMG' &&
                 /^data\:image\/(?:png|gif|jpe?g)/.test(value);
        },
      };
      showNotification(parseHtmlSubset(promo, tags, attrs), [], function() {
        chrome.send('closeNotificationPromo');
      }, 60000);
      chrome.send('notificationPromoViewed');
    }

    var loginContainer = getRequiredElement('login-container');
    loginContainer.addEventListener('click', function() {
      var rect = loginContainer.getBoundingClientRect();
      chrome.send('showSyncLoginUI',
                  [rect.left, rect.top, rect.width, rect.height]);
    });
    chrome.send('initializeSyncLogin');
  }

  /**
   * Launches the chrome web store app with the chrome-ntp-launcher
   * source.
   * @param {Event} e The click event.
   */
  function onChromeWebStoreButtonClick(e) {
    chrome.send('recordAppLaunchByURL',
                [encodeURIComponent(this.href),
                 ntp.APP_LAUNCH.NTP_WEBSTORE_FOOTER]);
  }

  /*
   * The number of sections to wait on.
   * @type {number}
   */
  var sectionsToWaitFor = 2;

  /**
   * Queued callbacks which lie in wait for all sections to be ready.
   * @type {array}
   */
  var readyCallbacks = [];

  /**
   * Fired as each section of pages becomes ready.
   * @param {Event} e Each page's synthetic DOM event.
   */
  document.addEventListener('sectionready', function(e) {
    if (--sectionsToWaitFor <= 0) {
      while (readyCallbacks.length) {
        readyCallbacks.shift()();
      }
    }
  });

  /**
   * This is used to simulate a fire-once event (i.e. $(document).ready() in
   * jQuery or Y.on('domready') in YUI. If all sections are ready, the callback
   * is fired right away. If all pages are not ready yet, the function is queued
   * for later execution.
   * @param {function} callback The work to be done when ready.
   */
  function doWhenAllSectionsReady(callback) {
    assert(typeof callback == 'function');
    if (sectionsToWaitFor > 0)
      readyCallbacks.push(callback);
    else
      window.setTimeout(callback, 0);  // Do soon after, but asynchronously.
  }

  /**
   * Fills in an invisible div with the 'Most Visited' string so that
   * its length may be measured and the nav dots sized accordingly.
   */
  function measureNavDots() {
    var measuringDiv = $('fontMeasuringDiv');
    measuringDiv.textContent = localStrings.getString('mostvisited');
    var pxWidth = Math.max(measuringDiv.clientWidth * 1.15, 80);

    var styleElement = document.createElement('style');
    styleElement.type = 'text/css';
    // max-width is used because if we run out of space, the nav dots will be
    // shrunk.
    styleElement.textContent = '.dot { max-width: ' + pxWidth + 'px; }';
    document.querySelector('head').appendChild(styleElement);
  }

  function themeChanged(opt_hasAttribution) {
    $('themecss').href = 'chrome://theme/css/new_tab_theme.css?' + Date.now();

    if (typeof opt_hasAttribution != 'undefined') {
      document.documentElement.setAttribute('hasattribution',
                                            opt_hasAttribution);
    }

    updateLogo();
    updateAttribution();
  }

  function setBookmarkBarAttached(attached) {
    document.documentElement.setAttribute('bookmarkbarattached', attached);
  }

  /**
   * Sets the proper image for the logo at the bottom left.
   */
  function updateLogo() {
    var imageId = 'IDR_PRODUCT_LOGO';
    if (document.documentElement.getAttribute('customlogo') == 'true')
      imageId = 'IDR_CUSTOM_PRODUCT_LOGO';

    $('logo-img').src = 'chrome://theme/' + imageId + '?' + Date.now();
  }

  /**
   * Attributes the attribution image at the bottom left.
   */
  function updateAttribution() {
    var attribution = $('attribution');
    if (document.documentElement.getAttribute('hasattribution') == 'true') {
      $('attribution-img').src =
          'chrome://theme/IDR_THEME_NTP_ATTRIBUTION?' + Date.now();
      attribution.hidden = false;
    } else {
      attribution.hidden = true;
    }
  }

  /**
   * Timeout ID.
   * @type {number}
   */
  var notificationTimeout = 0;

  /**
   * Shows the notification bubble.
   * @param {string|Node} message The notification message or node to use as
   *     message.
   * @param {Array.<{text: string, action: function()}>} links An array of
   *     records describing the links in the notification. Each record should
   *     have a 'text' attribute (the display string) and an 'action' attribute
   *     (a function to run when the link is activated).
   * @param {Function} opt_closeHandler The callback invoked if the user
   *     manually dismisses the notification.
   */
  function showNotification(message, links, opt_closeHandler, opt_timeout) {
    window.clearTimeout(notificationTimeout);

    var span = document.querySelector('#notification > span');
    if (typeof message == 'string') {
      span.textContent = message;
    } else {
      span.textContent = '';  // Remove all children.
      span.appendChild(message);
    }

    var linksBin = $('notificationLinks');
    linksBin.textContent = '';
    for (var i = 0; i < links.length; i++) {
      var link = linksBin.ownerDocument.createElement('div');
      link.textContent = links[i].text;
      link.action = links[i].action;
      link.onclick = function() {
        this.action();
        hideNotification();
      };
      link.setAttribute('role', 'button');
      link.setAttribute('tabindex', 0);
      link.className = 'link-button';
      linksBin.appendChild(link);
    }

    function closeFunc(e) {
      if (opt_closeHandler)
        opt_closeHandler();
      hideNotification();
    }

    document.querySelector('#notification button').onclick = closeFunc;
    document.addEventListener('dragstart', closeFunc);

    notificationContainer.hidden = false;
    showNotificationOnCurrentPage();

    newTabView.cardSlider.frame.addEventListener(
        'cardSlider:card_change_ended', onCardChangeEnded);

    var timeout = opt_timeout || 10000;
    notificationTimeout = window.setTimeout(hideNotification, timeout);
  }

  /**
   * Hide the notification bubble.
   */
  function hideNotification() {
    notificationContainer.classList.add('inactive');

    newTabView.cardSlider.frame.removeEventListener(
        'cardSlider:card_change_ended', onCardChangeEnded);
  }

  /**
   * Happens when 1 or more consecutive card changes end.
   * @param {Event} e The cardSlider:card_change_ended event.
   */
  function onCardChangeEnded(e) {
    // If we ended on the same page as we started, ignore.
    if (newTabView.cardSlider.currentCardValue.notification)
      return;

    // Hide the notification the old page.
    notificationContainer.classList.add('card-changed');

    showNotificationOnCurrentPage();
  }

  /**
   * Move and show the notification on the current page.
   */
  function showNotificationOnCurrentPage() {
    var page = newTabView.cardSlider.currentCardValue;
    doWhenAllSectionsReady(function() {
      if (page != newTabView.cardSlider.currentCardValue)
        return;

      // NOTE: This moves the notification to inside of the current page.
      page.notification = notificationContainer;

      // Reveal the notification and instruct it to hide itself if ignored.
      notificationContainer.classList.remove('inactive');

      // Gives the browser time to apply this rule before we remove it (causing
      // a transition).
      window.setTimeout(function() {
        notificationContainer.classList.remove('card-changed');
      }, 0);
    });
  }

  /**
   * When done fading out, set hidden to true so the notification can't be
   * tabbed to or clicked.
   * @param {Event} e The webkitTransitionEnd event.
   */
  function onNotificationTransitionEnd(e) {
    if (notificationContainer.classList.contains('inactive'))
      notificationContainer.hidden = true;
  }

  function setRecentlyClosedTabs(dataItems) {
    $('recently-closed-menu-button').dataItems = dataItems;
  }

  function setMostVisitedPages(data, hasBlacklistedUrls) {
    newTabView.mostVisitedPage.data = data;
    cr.dispatchSimpleEvent(document, 'sectionready', true, true);
  }

  /**
   * Set the dominant color for a node. This will be called in response to
   * getFaviconDominantColor. The node represented by |id| better have a setter
   * for stripeColor.
   * @param {string} id The ID of a node.
   * @param {string} color The color represented as a CSS string.
   */
  function setStripeColor(id, color) {
    var node = $(id);
    if (node)
      node.stripeColor = color;
  }

  /**
   * Updates the text displayed in the login container. If there is no text then
   * the login container is hidden.
   * @param {string} loginHeader The first line of text.
   * @param {string} loginSubHeader The second line of text.
   * @param {string} iconURL The url for the login status icon. If this is null
        then the login status icon is hidden.
   */
  function updateLogin(loginHeader, loginSubHeader, iconURL) {
    if (loginHeader || loginSubHeader) {
      $('login-container').hidden = false;
      $('login-status-header').innerHTML = loginHeader;
      $('login-status-sub-header').innerHTML = loginSubHeader;
      $('card-slider-frame').classList.add('showing-login-area');

      if (iconURL) {
        $('login-status-header-container').style.backgroundImage = url(iconURL);
        $('login-status-header-container').classList.add('login-status-icon');
      } else {
        $('login-status-header-container').style.backgroundImage = 'none';
        $('login-status-header-container').classList.remove(
            'login-status-icon');
      }
    } else {
      $('login-container').hidden = true;
      $('card-slider-frame').classList.remove('showing-login-area');
    }
    if (shouldShowLoginBubble) {
      window.setTimeout(loginBubble.show.bind(loginBubble), 0);
      chrome.send('loginMessageSeen');
      shouldShowLoginBubble = false;
    } else if (loginBubble) {
      loginBubble.reposition();
    }
  }

  /**
   * Wrappers to forward the callback to corresponding PageListView member.
   */
  function appAdded() {
    return newTabView.appAdded.apply(newTabView, arguments);
  }

  function appMoved() {
    return newTabView.appMoved.apply(newTabView, arguments);
  }

  function appRemoved() {
    return newTabView.appRemoved.apply(newTabView, arguments);
  }

  function appsPrefChangeCallback() {
    return newTabView.appsPrefChangedCallback.apply(newTabView, arguments);
  }

  function appsReordered() {
    return newTabView.appsReordered.apply(newTabView, arguments);
  }

  function enterRearrangeMode() {
    return newTabView.enterRearrangeMode.apply(newTabView, arguments);
  }

  function getAppsCallback() {
    return newTabView.getAppsCallback.apply(newTabView, arguments);
  }

  function getAppsPageIndex() {
    return newTabView.getAppsPageIndex.apply(newTabView, arguments);
  }

  function getCardSlider() {
    return newTabView.cardSlider;
  }

  function leaveRearrangeMode() {
    return newTabView.leaveRearrangeMode.apply(newTabView, arguments);
  }

  function saveAppPageName() {
    return newTabView.saveAppPageName.apply(newTabView, arguments);
  }

  function setAppToBeHighlighted(appId) {
    newTabView.highlightAppId = appId;
  }

  // Return an object with all the exports
  return {
    appAdded: appAdded,
    appMoved: appMoved,
    appRemoved: appRemoved,
    appsPrefChangeCallback: appsPrefChangeCallback,
    enterRearrangeMode: enterRearrangeMode,
    getAppsCallback: getAppsCallback,
    getAppsPageIndex: getAppsPageIndex,
    getCardSlider: getCardSlider,
    onLoad: onLoad,
    leaveRearrangeMode: leaveRearrangeMode,
    saveAppPageName: saveAppPageName,
    setAppToBeHighlighted: setAppToBeHighlighted,
    setBookmarkBarAttached: setBookmarkBarAttached,
    setMostVisitedPages: setMostVisitedPages,
    setRecentlyClosedTabs: setRecentlyClosedTabs,
    setStripeColor: setStripeColor,
    showNotification: showNotification,
    themeChanged: themeChanged,
    updateLogin: updateLogin
  };
});

document.addEventListener('DOMContentLoaded', ntp.onLoad);
