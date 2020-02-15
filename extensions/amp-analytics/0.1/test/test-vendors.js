/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
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

import {ANALYTICS_CONFIG} from '../vendors';
import {AmpAnalytics} from '../amp-analytics';
import {ExpansionOptions, variableServiceForDoc} from '../variables';
//import {IFRAME_TRANSPORTS} from '../iframe-transport-vendors';
import {
  ImagePixelVerifier,
  mockWindowInterface,
} from '../../../../testing/test-helper';
import {Services} from '../../../../src/services';
//import {hasOwn} from '../../../../src/utils/object';
import {macroTask} from '../../../../testing/yield';

// TODO(zhouyx@): Remove after ANALYTICS_VENDOR_SPLIT clean up

/* global require: false */
const VENDOR_REQUESTS = require('./vendor-requests.json');
const AnalyticsConfig = {...ANALYTICS_CONFIG};

// TODO(zhouyx@) Fix the "describe block" if we are going to revert the test
// "Top-level "describe" blocks in test files have been deprecated"

// describe.skip('iframe transport', () => {
//   it('Should not contain iframe transport if not whitelisted', () => {
//     for (const vendor in AnalyticsConfig) {
//       const vendorEntry = AnalyticsConfig[vendor];
//       if (
//         hasOwn(vendorEntry, 'transport') &&
//         hasOwn(vendorEntry.transport, 'iframe')
//       ) {
//         expect(vendorEntry['transport']['iframe']).to.equal(
//           IFRAME_TRANSPORTS[vendor]
//         );
//       }
//     }
//   });
// });

describes.realWin.skip(
  'amp-analytics',
  {
    amp: {
      extensions: ['amp-analytics'],
    },
  },
  function(env) {
    let win, doc;
    let requestVerifier;
    let elementMacros;

    beforeEach(() => {
      win = env.win;
      doc = win.document;
      const wi = mockWindowInterface(env.sandbox);
      wi.getLocation.returns(win.location);
      requestVerifier = new ImagePixelVerifier(wi);
      elementMacros = {
        'COOKIE': null,
        'CONSENT_STATE': null,
      };
    });

    function getAnalyticsTag(config, attrs) {
      config['transport'] = {
        xhrpost: false,
        beacon: false,
      };
      config = JSON.stringify(config);
      const el = doc.createElement('amp-analytics');
      const script = doc.createElement('script');
      script.textContent = config;
      script.setAttribute('type', 'application/json');
      el.appendChild(script);
      for (const k in attrs) {
        el.setAttribute(k, attrs[k]);
      }

      doc.body.appendChild(el);

      el.connectedCallback();
      const analytics = new AmpAnalytics(el);
      analytics.createdCallback();
      analytics.buildCallback();
      return analytics;
    }

    /**
     * Clears the properties in the config that should only be used in vendor
     * configs. This is needed because we pass in all the vendor requests as
     * inline config and iframePings/optout are not allowed to be used without
     * AMP team's approval.
     *
     * @param {!JsonObject} config The inline config to update.
     * @return {!JsonObject}
     */
    function clearVendorOnlyConfig(config) {
      for (const t in config.triggers) {
        if (config.triggers[t].iframePing) {
          config.triggers[t].iframePing = undefined;
        }
      }
      if (config.optout) {
        config.optout = undefined;
      }
      return config;
    }

    describe('vendor request tests', () => {
      for (const vendor in AnalyticsConfig) {
        if (vendor === 'default') {
          continue;
        }
        const config = AnalyticsConfig[vendor];
        if (!config.requests) {
          delete AnalyticsConfig[vendor];
          continue;
        }
        describe('analytics vendor: ' + vendor, function() {
          beforeEach(() => {
            // Remove all the triggers to prevent unwanted requests, for instance
            // one from a "visible" trigger. Those unwanted requests are a source
            // of test flakiness. Especially they will alternate value of var
            // $requestCount.
            config.triggers = {};
          });

          for (const name in config.requests) {
            it(
              'should produce request: ' +
                name +
                '. If this test fails update vendor-requests.json',
              function*() {
                const urlReplacements = Services.urlReplacementsForDoc(
                  doc.documentElement
                );
                const analytics = getAnalyticsTag(
                  clearVendorOnlyConfig(config)
                );
                window.sandbox
                  .stub(urlReplacements.getVariableSource(), 'get')
                  .callsFake(function(name) {
                    expect(this.replacements_).to.have.property(name);
                    const defaultValue = `_${name.toLowerCase()}_`;
                    return {
                      sync: () => defaultValue,
                    };
                  });

                window.sandbox
                  .stub(ExpansionOptions.prototype, 'getVar')
                  .callsFake(function(name) {
                    let val = this.vars[name];
                    // Vendor defined variable
                    if (val == null || val == '') {
                      val = '!' + name;
                    }
                    return val;
                  });
                analytics.createdCallback();
                analytics.buildCallback();
                yield analytics.layoutCallback();

                // Have to get service after analytics element is created
                const variableService = variableServiceForDoc(doc);

                window.sandbox
                  .stub(variableService, 'getMacros')
                  .callsFake(function() {
                    // Add all the macros in amp-analytics
                    const merged = {...this.macros_, ...elementMacros};

                    // Change the resolving function
                    const keys = Object.keys(merged);
                    for (let i = 0; i < keys.length; i++) {
                      const key = keys[i];
                      merged[key] = (opt_param, opt_param2, opt_param3) => {
                        return `_${key.replace('$', '')}_`;
                      };
                    }
                    return /** @type {!JsonObject} */ (merged);
                  });

                // Wait for event queue to clear.
                yield macroTask();

                analytics.handleEvent_(
                  {
                    request: name,
                  },
                  {
                    vars: Object.create(null),
                  }
                );
                yield macroTask();
                expect(requestVerifier.hasRequestSent()).to.be.true;
                let url = requestVerifier.getLastRequestUrl();

                const vendorData = VENDOR_REQUESTS[vendor];
                if (!vendorData) {
                  throw new Error(
                    'Add vendor ' + vendor + ' to vendor-requests.json'
                  );
                }
                const val = vendorData[name];
                if (val == '<ignore for test>') {
                  url = '<ignore for test>';
                }
                if (val == null) {
                  throw new Error(
                    'Define ' +
                      vendor +
                      '.' +
                      name +
                      ' in vendor-requests.json. Expected value: ' +
                      url
                  );
                }

                // Write this out for easy copy pasting.
                writeOutput(vendor, name, url);

                expect(url).to.equal(val);
              }
            );
          }
        });
      }
    });
  }
);

const actualResults = {};

function writeOutput(vendor, name, url) {
  if (!actualResults[vendor]) {
    actualResults[vendor] = {};
  }
  actualResults[vendor][name] = url;
  const cnt = Object.keys(AnalyticsConfig[vendor]['requests']).length;
  AnalyticsConfig[vendor].testCnt = (AnalyticsConfig[vendor].testCnt || 0) + 1;
  if (cnt == AnalyticsConfig[vendor].testCnt) {
    delete AnalyticsConfig[vendor];
    if (Object.keys(AnalyticsConfig).length == 1) {
      const out = top.document.createElement('div');
      out.textContent = JSON.stringify(actualResults, null, '  ');
      top.document.body.insertBefore(out, top.document.body.firstChild);
    }
  }
}
