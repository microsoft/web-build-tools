// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { ExtractorConfig } from '../ExtractorConfig';

describe('ExtractorConfig', () => {
  describe('hasDtsFileExtension', () => {
    it.each([
      ['test.ts', false],
      ['test.cts', false],
      ['test.mts', false],
      ['test.d.ts', true],
      ['test.d.mts', true],
      ['test.d.cts', true],
      ['test.css', false],
      ['test.css.ts', false],
      ['test.css.d.ts', true],
      ['test.d.css.ts', true],
      ['test.json', false],
      ['test.json.ts', false],
      ['test.json.d.ts', true],
      ['test.d.json.ts', true]
    ])('file "%s" has dts file extension equals "%s"', (file, expected) => {
      const result = ExtractorConfig.hasDtsFileExtension(file);
      expect(result).toEqual(expected);
    });
  });
});
