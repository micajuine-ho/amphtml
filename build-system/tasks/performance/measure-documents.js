/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
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

const fs = require('fs');
const log = require('fancy-log');
const path = require('path');
const {
  ANALYTICS_VENDORS_PATH,
  CDN_ANALYTICS_REGEXP,
  CONTROL,
  EXPERIMENT,
  RESULTS_PATH,
  urlToCachePath,
  getFile,
} = require('./helpers');

// Require Puppeteer dynamically to prevent throwing error in Travis
let puppeteer;

function requirePuppeteer_() {
  puppeteer = require('puppeteer');
}

/**
 * Setup measurement on page before navigating to the URL. Performance
 * observers need to be initialized before content begins to load to take
 * measurements.
 *
 * @param {Puppeteer.page} page
 * @return {Promise} Resolves when script is evaluated
 */
const setupMeasurement = (page) =>
  page.evaluateOnNewDocument(() => {
    window.longTasks = [];
    window.cumulativeLayoutShift = 0;
    window.measureStarted = Date.now();
    window.largestContentfulPaint = 0;

    const longTaskObserver = new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => window.longTasks.push(entry))
    );

    longTaskObserver.observe({entryTypes: ['longtask']});

    const layoutShiftObserver = new PerformanceObserver((list) =>
      list
        .getEntries()
        .forEach((entry) => (window.cumulativeLayoutShift += entry.value))
    );

    layoutShiftObserver.observe({entryTypes: ['layout-shift']});

    const largestContentfulPaintObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const entry = entries[entries.length - 1];
      window.largestContentfulPaint = entry.renderTime || entry.loadTime;
    });

    largestContentfulPaintObserver.observe({
      entryTypes: ['largest-contentful-paint'],
    });
  });

/**
 * Records first outgoing analytics request
 *
 * @param {Request} interceptedRequest
 * @param {string} analyticsParam
 * @param {!Function} setEndTimeCallback
 * @return {!Promise<boolean>}
 */
async function handleAnalyticsRequests(
  interceptedRequest,
  analyticsParam,
  setEndTimeCallback
) {
  const interceptedUrl = interceptedRequest.url();
  if (interceptedUrl.includes(analyticsParam)) {
    setEndTimeCallback(Date.now());
    interceptedRequest.abort();
    return true;
  }
  return false;
}

/**
 * Handles rewrites vendor config requests. Should always be
 * included.
 * @param {Request} interceptedRequest
 * @return {!Promise<boolean>}
 */
const analyticsVendorRewriteHandler = async (interceptedRequest) => {
  const interceptedUrl = interceptedRequest.url();
  const matchArray = interceptedUrl.match(CDN_ANALYTICS_REGEXP);
  if (matchArray) {
    const filename = matchArray[1];
    const pathToJson = path.join(ANALYTICS_VENDORS_PATH, filename);
    const jsonString = await getFile(pathToJson);
    interceptedRequest.respond({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: jsonString,
    });
    return true;
  }
  return false;
};

/**
 * Add specified timeout by handler
 * @param {?Object} handlerOptions
 * @return {!Promise}
 */
function delayBasedOnHandlerOptions(handlerOptions) {
  return new Promise((resolve) => {
    setTimeout(
      resolve,
      handlerOptions && handlerOptions.timeout ? handlerOptions.timeout : 0
    );
  });
}

/**
 * Evaluate script on the page to collect and calculate metrics
 *
 * @param {Puppeteer.page} page
 * @return {Promise<object>} Resolves with page load metrics
 */
const readMetrics = (page) =>
  page.evaluate(() => {
    const entries = performance.getEntries();

    function getMetric(name) {
      const entry = entries.find((entry) => entry.name === name);
      return entry ? entry.startTime : 0;
    }

    const firstPaint = getMetric('first-paint');
    const firstContentfulPaint = getMetric('first-contentful-paint');

    function getMaxFirstInputDelay() {
      let longest = 0;

      window.longTasks.forEach((longTask) => {
        if (
          longTask.startTime > firstContentfulPaint &&
          longTask.duration > longest
        ) {
          longest = longTask.duration;
        }
      });

      return longest;
    }

    function getTimeToInteractive() {
      return Date.now() - window.measureStarted;
    }

    return {
      visible: getMetric('visible'),
      firstPaint,
      firstContentfulPaint,
      largestContentfulPaint: window.largestContentfulPaint,
      timeToInteractive: getTimeToInteractive(),
      maxFirstInputDelay: getMaxFirstInputDelay(),
      cumulativeLayoutShift: window.cumulativeLayoutShift * 100,
    };
  });

/**
 * Set up defaults handlers
 * @param {!Array<function>} handlersList
 */
function setUpDefaultHandlers(handlersList) {
  // Always rewrite vendor json requests to pull locally.
  // That way we are not including the time difference between
  // fetching a local file vs network request to CDN.
  handlersList.push(analyticsVendorRewriteHandler);
}

/**
 * Set up appropriate handlers
 * @param {!Array<function>} handlersList
 * @param {?Object} handlerOptions
 */
function setUpAddionalHandlers(handlersList, handlerOptions) {
  // Setting up timing and adding specified handler
  if (handlerOptions.handlerName === 'analyticsHandler') {
    Object.assign(handlerOptions, {'startTime': Date.now()});
    handlersList.push((interceptedRequest) =>
      handleAnalyticsRequests(
        interceptedRequest,
        handlerOptions.analyticsParam,
        (endTime) => {
          if (!handlerOptions.endTime) {
            Object.assign(handlerOptions, {
              endTime,
              'timeout': 0,
            });
          }
        }
      )
    );
  }
}

/**
 * Send each intercepted request to all handlers in list.
 * Takes care of continueing the request if the handler
 * doesn't alter/use the request.
 * @param {!Array<function>} handlersList
 * @param {Puppeteer.page} page
 */
function startRequestListener(handlersList, page) {
  page.on('request', async (interceptedRequest) => {
    const requestHandled = await handlersList.reduce(
      // Don't short circuit
      async (prev, handleRequest) =>
        (await handleRequest(interceptedRequest)) || prev,
      false
    );
    if (!requestHandled) {
      interceptedRequest.continue();
    }
  });
}

/**
 * Return metrics calcaultion based on handler
 * @param {?Object} handlerOptions
 * @param {Object} metrics
 */
function addHandlerMetric(handlerOptions, metrics) {
  if (handlerOptions.handlerName === 'analyticsHandler') {
    addAnalyticsMetric(handlerOptions, metrics);
  }
}

/**
 * If reqest didn't fire, don't include any value for
 * analyticsRequest.
 * @param {?Object} analyticsHandlerOptions
 * @param {Object} metrics
 */
function addAnalyticsMetric(analyticsHandlerOptions, metrics) {
  const {endTime, startTime} = analyticsHandlerOptions;
  const analyticsMetric = {};
  // If there is no end time, that means that request didn't fire.
  let requestsFailed = 0;
  if (!endTime) {
    requestsFailed++;
  } else {
    analyticsMetric['analyticsRequest'] = endTime - startTime;
  }
  analyticsMetric['requestsFailed'] = requestsFailed;
  Object.assign(metrics, analyticsMetric);
}

/**
 * Writes measurements to ./results.json
 *
 * @param {string} url
 * @param {string} version
 * @param {*} metrics
 */
function writeMetrics(url, version, metrics) {
  let results = {};

  if (fs.existsSync(RESULTS_PATH)) {
    results = JSON.parse(fs.readFileSync(RESULTS_PATH));
  }

  if (!results[url]) {
    results[url] = {[CONTROL]: [], [EXPERIMENT]: []};
  }

  results[url][version].push(metrics);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results));
}

/**
 * Opens Chrome, loads the URL from local file cache, and collects
 * metrics for the specified URL and version
 *
 * @param {string} url
 * @param {string} version "control" or "experiment"
 * @param {!Object} config
 * @return {Promise}
 */
async function measureDocument(url, version, config) {
  const browser = await puppeteer.launch({
    headless: config.headless,
    args: [
      '--allow-file-access-from-files',
      '--enable-blink-features=LayoutInstabilityAPI',
      '--disable-web-security',
    ],
  });

  const page = await browser.newPage();
  const handlerOptionsForUrl = {...config.urlToHandlers[url]};
  const handlersList = [];
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  await setupMeasurement(page);
  setUpDefaultHandlers(handlersList);
  setUpAddionalHandlers(handlersList, handlerOptionsForUrl);
  startRequestListener(handlersList, page);

  try {
    await page.goto(`file:${urlToCachePath(url, version)}`, {
      waitUntil: 'networkidle0',
    });
  } catch (e) {
    // site did not load
    await browser.close();
    console.log(e);
    return;
  }

  const metrics = await readMetrics(page);
  await delayBasedOnHandlerOptions(handlerOptionsForUrl);
  addHandlerMetric(handlerOptionsForUrl, metrics);
  writeMetrics(url, version, metrics);
  await browser.close();
}

/**
 * Loads cached local copies of the URLs in Chrome with Puppeteer and
 * runs a script on the page to collect performance metrics. Saves
 * performance metrics to results.json in this directory.
 *
 * @param {!Array<string>} urls
 * @param {!Object} config
 * @return {Promise} Fulfills when all URLs have been measured
 */
async function measureDocuments(urls, config) {
  requirePuppeteer_();

  try {
    fs.unlinkSync(RESULTS_PATH);
  } catch {} // file does not exist (first run)

  // Make an array of tasks to be executed
  const tasks = urls.flatMap((url) =>
    Array.from({length: config.runs}).flatMap(() => [
      measureDocument.bind(null, url, CONTROL, config),
      measureDocument.bind(null, url, EXPERIMENT, config),
    ])
  );

  const startTime = Date.now();
  function timeLeft() {
    const elapsed = (Date.now() - startTime) / 1000;
    const secondsPerTask = elapsed / i;
    return Math.floor(secondsPerTask * (tasks.length - i));
  }

  // Excecute the tasks serially
  let i = 0;
  for (const task of tasks) {
    log(`Progress: ${i++}/${tasks.length}. ${timeLeft()} seconds left.`);
    await task();
  }
}

module.exports = measureDocuments;
