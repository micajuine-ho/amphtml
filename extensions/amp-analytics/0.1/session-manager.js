/**
 * Copyright 2021 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Services} from '#service';
import {dev, user} from '../../../src/log';
import {
  getServicePromiseForDoc,
  registerServiceBuilderForDoc,
} from '../../../src/service-helpers';
import {hasOwn, map} from '#core/types/object';
import {isObject} from '#core/types';

/** @const {string} */
const TAG = 'amp-analytics/session-manager';

/** @const {string} */
const SESSION_STORAGE_KEY = 'amp-session:';

/**
 * We ignore Sessions that are older than 30 minutes.
 */
export const SESSION_MAX_AGE_MILLIS = 30 * 60 * 1000;

/**
 * Key values for retriving/storing session values
 * @enum {string}
 */
export const SESSION_VALUES = {
  SESSION_ID: 'sessionId',
  CREATION_TIMESTAMP: 'creationTimestamp',
  LAST_ACCESS_TIMESTAMP: 'lastAccessTimestamp',
  COUNT: 'count',
};

/**
 * `lastAccessTimestamp` is not stored in localStorage, since
 * that mechanism already handles removing expired sessions.
 * We just keep it so that we don't have to read the value everytime
 * during the same page visit.
 * @typedef {{
 *  sessionId: number,
 *  creationTimestamp: number,
 *  lastAccessTimestamp: number,
 *  count: number,
 * }}
 */
export let SessionInfoDef;

export class SessionManager {
  /**
   * @param {!../../../src/service/ampdoc-impl.AmpDoc} ampdoc
   */
  constructor(ampdoc) {
    /** @private {!Promise<!../../../src/service/storage-impl.Storage>} */
    this.storagePromise_ = Services.storageForDoc(ampdoc);

    /** @private {!Object<string, ?SessionInfoDef>} */
    this.sessions_ = map();
  }

  /**
   * Get the value from the session per the vendor.
   * @param {string|undefined} type
   * @param {SESSION_VALUES} value
   * @return {!Promise<number|undefined>}
   */
  getSessionValue(type, value) {
    return this.get(type).then((session) => {
      return session?.[value];
    });
  }

  /**
   * Get the session for the vendor, checking if it exists or
   * creating it if necessary.
   * @param {string|undefined} type
   * @return {!Promise<?SessionInfoDef>}
   */
  get(type) {
    if (!type) {
      user().error(TAG, 'Sessions can only be accessed with a vendor type.');
      return Promise.resolve(null);
    }

    if (
      hasOwn(this.sessions_, type) &&
      !isSessionExpired(this.sessions_[type])
    ) {
      this.sessions_[type] = this.updateSession_(this.sessions_[type]);
      this.setSession_(type, this.sessions_[type]);
      return Promise.resolve(this.sessions_[type]);
    }

    return this.getOrCreateSession_(type);
  }

  /**
   * Get our session if it exists or creates it. Sets the session
   * in localStorage to update the last access time.
   * @param {string} type
   * @return {!Promise<SessionInfoDef>}
   */
  getOrCreateSession_(type) {
    return this.storagePromise_
      .then((storage) => {
        const storageKey = getStorageKey(type);
        return storage.get(storageKey);
      })
      .then((session) => {
        // Either create session or update it
        return !session
          ? constructSessionInfo(generateSessionId(), Date.now(), 1, Date.now())
          : this.updateSession_(constructSessionFromStoredValue(session));
      })
      .then((session) => {
        // Avoid multiple session creation race
        if (type in this.sessions_ && !isSessionExpired(this.sessions_[type])) {
          return this.sessions_[type];
        }
        this.setSession_(type, session);
        this.sessions_[type] = session;
        return this.sessions_[type];
      });
  }

  /**
   * Check if session has expired and reset values (id, count) if so.
   * Also update `lastAccessTimestamp`.
   * @param {!SessionInfoDef} session
   * @return {!SessionInfoDef}
   */
  updateSession_(session) {
    if (this.isSessionExpired_(session)) {
      const newSessionCount =
        session.count === undefined ? 1 : session.count + 1;
      session = constructSessionInfo(
        generateSessionId(),
        Date.now(),
        newSessionCount
      );
    } else if (session.count === undefined) {
      session.count = 1;
    }
    session.lastAccessTimestamp = Date.now();
    return session;
  }

  /**
   * Set the session in localStorage, updating
   * its last access time if it did not exist before.
   * @param {string} type
   * @param {SessionInfoDef} session
   * @return {!Promise}
   */
  setSession_(type, session) {
    return this.storagePromise_.then((storage) => {
      const storageKey = getStorageKey(type);
      storage.setNonBoolean(storageKey, session);
    });
  }
}

/**
 * Checks if a session has expired
 * @param {SessionInfoDef} session
 * @return {boolean}
 */
function isSessionExpired(session) {
  return session.lastAccessTimestamp + SESSION_MAX_AGE_MILLIS < Date.now();
}

/**
 * Return a pseudorandom low entropy value for session id.
 * @return {number}
 */
function generateSessionId() {
  return Math.floor(10000 * Math.random());
}

/**
 * @param {string} type
 * @return {string}
 */
function getStorageKey(type) {
  return SESSION_STORAGE_KEY + type;
}

/**
 * @param {SessionInfoDef|string} storedSession
 * @return {SessionInfoDef}
 */
function constructSessionFromStoredValue(storedSession) {
  if (!isObject(storedSession)) {
    dev().error(TAG, 'Invalid stored session value');
    return constructSessionInfo(generateSessionId(), Date.now(), 1);
  }

  return constructSessionInfo(
    storedSession[SESSION_VALUES.SESSION_ID],
    storedSession[SESSION_VALUES.CREATION_TIMESTAMP],
    storedSession[SESSION_VALUES.COUNT],
    storedSession[SESSION_VALUES.LAST_ACCESS_TIMESTAMP]
  );
}

/**
 * Construct the session info object from values
 * @param {number} sessionId
 * @param {number} creationTimestamp
 * @param {number} count
 * @param {number|undefined} opt_lastAccessTimestamp
 * @return {!SessionInfoDef}
 */
function constructSessionInfo(
  sessionId,
  creationTimestamp,
  count,
  opt_lastAccessTimestamp
) {
  return {
    [SESSION_VALUES.SESSION_ID]: sessionId,
    [SESSION_VALUES.CREATION_TIMESTAMP]: creationTimestamp,
    [SESSION_VALUES.COUNT]: count,
    [SESSION_VALUES.LAST_ACCESS_TIMESTAMP]: opt_lastAccessTimestamp,
  };
}

/**
 * @param {!Element|!ShadowRoot|!../../../src/service/ampdoc-impl.AmpDoc} elementOrAmpDoc
 * @return {!Promise<!SessionManager>}
 */
export function sessionServicePromiseForDoc(elementOrAmpDoc) {
  return /** @type {!Promise<!SessionManager>} */ (
    getServicePromiseForDoc(elementOrAmpDoc, 'amp-analytics-session')
  );
}

/**
 * @param {!../../../src/service/ampdoc-impl.AmpDoc} ampdoc
 */
export function installSessionServiceForTesting(ampdoc) {
  registerServiceBuilderForDoc(ampdoc, 'amp-analytics-session', SessionManager);
}
