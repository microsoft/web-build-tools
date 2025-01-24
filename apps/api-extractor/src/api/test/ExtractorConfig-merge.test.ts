// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';

import { ExtractorConfig } from '../ExtractorConfig';

const testDataFolder: string = path.join(__dirname, 'test-data');

// Tests verifying the merge behavior of ExtractorConfig.loadFile
describe(`${ExtractorConfig.name}.${ExtractorConfig.loadFile.name}`, () => {
  it('array properties completely override array properties in the base config', () => {
    const extractorConfig: ExtractorConfig = ExtractorConfig.loadFileAndPrepare(
      path.join(testDataFolder, 'override-array-properties', 'api-extractor.json')
    );
    // Base config specifies: ["alpha", "beta", "public"]
    // Derived config specifies: ["complete"]
    // By default, lodash's merge() function would generate ["complete", "beta", "public"],
    // but we instead want the derived config's array property to completely override that of the base.
    expect(extractorConfig.reportConfigs).toEqual([
      {
        variant: 'complete',
        fileName: 'override-array-properties.api.md'
      }
    ]);
  });
});
