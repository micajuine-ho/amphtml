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
'use strict';

// Forbids use of Rest elements when they require an iterator polyfill, or
// there's no clear benefit.
//
// Good:
// ```
// function foo(...args) {}
// const {...rest} = {foo: 1};
// ```
//
// Bad:
// ```
// const [...rest] = [1, 2, 3];
// ```
module.exports = function (context) {
  return {
    'ArrayPattern > RestElement': function (node) {
      context.report({
        node,
        message: 'Collecting elements using a rest element is not allowed.',
      });
    },
  };
};
