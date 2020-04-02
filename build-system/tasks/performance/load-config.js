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

const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');
const path = require('path');

const PATH = './config.json';

/**
 * Loads test config from ./config.json
 * @return {{concurrency:number, headless:boolean, runs:number, urls:Array<string>, handlers:Object}}
 */
function loadConfig() {
  const file = fs.readFileSync(path.join(__dirname, PATH));
  const config = JSON.parse(file);
  if (argv.url) {
    config.handlers.defaultHandler.urls = [argv.url];
  }
  // Create new url field
  config.urls = Object.keys(config.handlers).reduce((prev, curr) => {
    config.handlers[curr].urls.forEach((url) => {
      if (prev.indexOf(url) !== -1) {
        throw new Error('All urls must be unique');
      }
    });
    return prev.concat(config.handlers[curr].urls);
  }, []);
  if (config.urls.length < 1) {
    throw new Error('No URLs found in config.');
  }
  return config;
}

module.exports = loadConfig;
