import { App } from "../core/app";
import { Settings } from "../core/settings";
import { IonicPlatform } from "../core/core";
import { Logger } from "../core/logger";

import { Token } from "./push-token";
import { PushDevService } from "./push-dev";

var settings = new Settings();

var DEFER_INIT = "DEFER_INIT";

/**
 * Push Service
 *
 * This is the main entrypoint for interacting with the Ionic Push service.
 * Example Usage:
 *
 *   Ionic.io(); // kick off the io platform
 *   var push = new Ionic.Push({
 *     "debug": true,
 *     "onNotification": function(notification) {
 *       var payload = $ionicPush.getPayload(notification);
 *       console.log(notification, payload);
 *     },
 *     "onRegister": function(data) {
 *       console.log(data);
 *     }
 *   });
 *
 *   // Registers for a device token using the options passed to init()
 *   push.register(callback);
 *
 *   // Unregister the current registered token
 *   push.unregister();
 *
 */
export class Push {

  constructor(config) {

    this.logger = new Logger({
      'prefix': 'Ionic Push:'
    });

    var IonicApp = new App(settings.get('app_id'), settings.get('api_key'));
    IonicApp.devPush = settings.get('dev_push');
    IonicApp.gcmKey = settings.get('gcm_key');

    // Check for the required values to use this service
    if (!IonicApp.id || !IonicApp.apiKey) {
      this.logger.error('no app_id or api_key found. (http://docs.ionic.io/docs/io-install)');
      return false;
    } else if (IonicPlatform.isAndroidDevice() && !IonicApp.devPush && !IonicApp.gcmKey) {
      this.logger.error('GCM project number not found (http://docs.ionic.io/docs/push-android-setup)');
      return false;
    }

    this.app = App;
    this.registerCallback = false;
    this.notificationCallback = false;
    this.errorCallback = false;
    this._token = false;
    this._notification = false;
    this._debug = false;
    this._isReady = false;
    this._tokenReady = false;
    this._blockRegistration = false;
    this._emitter = IonicPlatform.getEmitter();
    if (config !== DEFER_INIT) {
      this.init(config);
    }
  }

  /**
   * Init method to setup push behavior/options
   *
   * The config supports the following properties:
   *   - debug {Boolean} Enables some extra logging as well as some default callback handlers
   *   - onNotification {Function} Callback function that is passed the notification object
   *   - onRegister {Function} Callback function that is passed the registration object
   *   - onError {Function} Callback function that is passed the error object
   *   - pluginConfig {Object} Plugin configuration: https://github.com/phonegap/phonegap-plugin-push
   *
   * @param {object} config Configuration object
   * @return {Push} returns the called Push instantiation
   */
  init(config) {
    var PushPlugin = this._getPushPlugin();
    if (!PushPlugin) { return false; }
    if (typeof config === 'undefined') { config = {}; }
    if (typeof config !== 'object') {
      this.logger.error('init() requires a valid config object.');
      return false;
    }
    var self = this;

    if (!config.pluginConfig) { config.pluginConfig = {}; }

    if (IonicPlatform.isAndroidDevice()) {
      // inject gcm key for PushPlugin
      if (!config.pluginConfig.android) { config.pluginConfig.android = {}; }
      if (!config.pluginConfig.android.senderId) { config.pluginConfig.android.senderID = self.app.gcmKey; }
    }

    // Store Callbacks
    if (config.onRegister) { this.setRegisterCallback(config.onRegister); }
    if (config.onNotification) { this.setNotificationCallback(config.onNotification); }
    if (config.onError) { this.setErrorCallback(config.onError); }

    this._config = JSON.parse(JSON.stringify(config));
    this._isReady = true;

    this._emitter.emit('ionic_push:ready', { "config": this._config });
    return this;
  }

  /**
   * Store the currently registered device token with a User
   *
   * @param {IonicUser} user The User the token should be associated with
   * @return {void}
   */
  addTokenToUser(user) {
    if (!this._token) {
      this.logger.info('a token must be registered before you can add it to a user.');
    }
    if (typeof user === 'object') {
      if (IonicPlatform.isAndroidDevice()) {
        user.addPushToken(this._token, 'android');
      } else if (IonicPlatform.isIOSDevice()) {
        user.addPushToken(this._token, 'ios');
      } else {
        this.logger.info('token is not a valid Android or iOS registration id. Cannot save to user.');
      }
    } else {
      this.logger.info('invalid $ionicUser object passed to $ionicPush.addToUser()');
    }
  }

  /**
   * Registers the device with GCM/APNS to get a device token
   * Fires off the 'onRegister' callback if one has been provided in the init() config
   * @param {function} callback Callback Function
   * @return {void}
   */
  register(callback) {
    this.logger.info('register');
    var self = this;
    if (this._blockRegistration) {
      self.logger.info("another registration is already in progress.");
      return false;
    }
    this._blockRegistration = true;
    this.onReady(function() {
      if (self.app.devPush) {
        var IonicDevPush = new PushDevService();
        IonicDevPush.init(self);
        self._blockRegistration = false;
        self._tokenReady = true;
      } else {
        self._plugin = PushNotification.init(self._config.pluginConfig);
        self._plugin.on('registration', function(data) {
          self._blockRegistration = false;
          self._token = new Token(data.registrationId);
          self._tokenReady = true;
          if ((typeof callback === 'function')) {
            callback(self._token);
          }
        });
        self._debugCallbackRegistration();
        self._callbackRegistration();
      }
    });
  }

  /**
   * Invalidate the current GCM/APNS token
   *
   * @param {function} callback Success Callback
   * @param {function} errorCallback Error Callback
   * @return {mixed} plugin unregister response
   */
  unregister(callback, errorCallback) {
    if (!this._plugin) { return false; }
    return this._plugin.unregister(callback, errorCallback);
  }

  /**
   * Convenience method to grab the payload object from a notification
   *
   * @param {PushNotification} notification Push Notification object
   * @return {object} Payload object or an empty object
   */
  getPayload(notification) {
    var payload = {};
    if (typeof notification === 'object') {
      if (notification.additionalData && notification.additionalData.payload) {
        payload = notification.additionalData.payload;
      }
    }
    return payload;
  }

  /**
   * Set the registration callback
   *
   * @param {function} callback Registration callback function
   * @return {boolean} true if set correctly, otherwise false
   */
  setRegisterCallback(callback) {
    if (typeof callback !== 'function') {
      this.logger.info('setRegisterCallback() requires a valid callback function');
      return false;
    }
    this.registerCallback = callback;
    return true;
  }

  /**
   * Set the notification callback
   *
   * @param {function} callback Notification callback function
   * @return {boolean} true if set correctly, otherwise false
   */
  setNotificationCallback(callback) {
    if (typeof callback !== 'function') {
      this.logger.info('setNotificationCallback() requires a valid callback function');
      return false;
    }
    this.notificationCallback = callback;
    return true;
  }

  /**
   * Set the error callback
   *
   * @param {function} callback Error callback function
   * @return {boolean} true if set correctly, otherwise false
   */
  setErrorCallback(callback) {
    if (typeof callback !== 'function') {
      this.logger.info('setErrorCallback() requires a valid callback function');
      return false;
    }
    this.errorCallback = callback;
    return true;
  }

  /**
   * Registers the default debug callbacks with the PushPlugin when debug is enabled
   * Internal Method
   * @private
   * @return {void}
   */
  _debugCallbackRegistration() {
    var self = this;
    if (this._config.debug) {
      this._plugin.on('registration', function(data) {
        self._token = new Token(data.registrationId);
        self.logger.info('device token registered', self._token);
      });

      this._plugin.on('notification', function(notification) {
        self._processNotification(notification);
        self.logger.info('notification received', self._notification);
      });

      this._plugin.on('error', function(err) {
        self.logger.error('unexpected error occured.');
        self.logger.error(err);
      });
    }
  }

  /**
   * Registers the user supplied callbacks with the PushPlugin
   * Internal Method
   * @return {void}
   */
  _callbackRegistration() {
    var self = this;
    this._plugin.on('registration', function(data) {
      self._token = new Token(data.registrationId);
      if (self.registerCallback) {
        return self.registerCallback(data);
      }
    });

    this._plugin.on('notification', function(notification) {
      self._processNotification(notification);
      if (self.notificationCallback) {
        return self.notificationCallback(notification);
      }
    });

    this._plugin.on('error', function() {
      if (self.errorCallback) {
        return self.errorCallback();
      }
    });
  }

  /**
   * Performs misc features based on the contents of a push notification
   * Internal Method
   *
   * Currently just does the payload $state redirection
   * @param {PushNotification} notification Push Notification object
   * @return {void}
   */
  _processNotification(notification) {
    this._notification = notification;
    this._emitter.emit('ionic_push:processNotification', notification);
  }

  /**
   * Fetch the phonegap-push-plugin interface
   * Internal Method
   *
   * @return {PushNotification} PushNotification instance
   */
  _getPushPlugin() {
    var PushPlugin = false;
    try {
      PushPlugin = window.PushNotification;
    } catch(e) {
      this.logger.info('something went wrong looking for the PushNotification plugin');
    }

    if (!PushPlugin && (IonicPlatform.isIOSDevice() || IonicPlatform.isAndroidDevice()) ) {
      self.logger.error("PushNotification plugin is required. Have you run `ionic plugin add phonegap-plugin-push` ?");
    }
    return PushPlugin;
  }

  /**
   * Fire a callback when Push is ready. This will fire immediately if
   * the service has already initialized.
   *
   * @param {function} callback Callback function to fire off
   * @return {void}
   */
  onReady(callback) {
    var self = this;
    if (this._isReady) {
      callback(self);
    } else {
      self._emitter.on('ionic_push:ready', function() {
        callback(self);
      });
    }
  }

}
