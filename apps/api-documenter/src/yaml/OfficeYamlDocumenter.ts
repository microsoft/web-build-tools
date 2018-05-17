// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as fsx from 'fs-extra';
import * as path from 'path';
import yaml = require('js-yaml');

import { DocItemSet } from '../utils/DocItemSet';
import { IYamlTocItem } from './IYamlTocFile';
import { IYamlItem } from './IYamlApiFile';
import { YamlDocumenter } from './YamlDocumenter';

interface ISnippetsFile {
  /**
   * The keys are API names like "Excel.Range.clear".
   * The values are TypeScript source code excerpts.
   */
  [apiName: string]: string[];
}

/**
 * Extends YamlDocumenter with some custom logic that is specific to Office Add-ins.
 */
export class OfficeYamlDocumenter extends YamlDocumenter {
  private _snippets: ISnippetsFile;

  // Hash set of API set relative URLs.
  private _apiSetUrls: any = {
    "Excel": "/javascript/office/requirement-sets/excel-api-requirement-sets",
    "OneNote": "/javascript/office/requirement-sets/onenote-api-requirement-sets",
    "Visio": "/javascript/office/overview/visio-javascript-reference-overview",
    "Outlook": "/javascript/office/requirement-sets/outlook-api-requirement-sets",
    "Word": "/javascript/office/requirement-sets/word-api-requirement-sets",
    "Default": "/javascript/office/javascript-api-for-office"
  };

  public constructor(docItemSet: DocItemSet, inputFolder: string) {
    super(docItemSet);

    const snippetsFilePath: string = path.join(inputFolder, 'snippets.yaml');

    console.log('Loading snippets from ' + snippetsFilePath);
    const snippetsContent: string = fsx.readFileSync(snippetsFilePath).toString();
    this._snippets = yaml.load(snippetsContent, { filename: snippetsFilePath });
  }

  public generateFiles(outputFolder: string): void { // override
    super.generateFiles(outputFolder);

    // After we generate everything, check for any unused snippets
    console.log();
    for (const apiName of Object.keys(this._snippets)) {
      console.error(colors.yellow('Warning: Unused snippet ' + apiName));
    }
  }

  protected onGetTocRoot(): IYamlTocItem { // override
    return {
      name: 'API reference',
      href: '~/docs-ref-autogen/overview/office.md',
      items: [ ]
    };
  }

  protected onCustomizeYamlItem(yamlItem: IYamlItem): void { // override
    const nameWithoutPackage: string = yamlItem.uid.replace(/^[^.]+\./, '');

    const snippets: string[] | undefined = this._snippets[nameWithoutPackage];
    if (snippets) {
      delete this._snippets[nameWithoutPackage];

      if (!yamlItem.remarks) {
        yamlItem.remarks = '';
      }

      yamlItem.remarks += '\n\n#### Examples\n';
      for (const snippet of snippets) {
        if (snippet.search(/await/) === -1) {
          yamlItem.remarks += '\n```javascript\n' + snippet + '\n```\n';
        } else {
          yamlItem.remarks += '\n```typescript\n' + snippet + '\n```\n';
        }
      }
    }

    if (yamlItem.summary) {
      yamlItem.summary = this._fixupApiSet(yamlItem.summary, yamlItem.uid);
    }
    if (yamlItem.remarks) {
      yamlItem.remarks = this._fixupApiSet(yamlItem.remarks, yamlItem.uid);
    }
  }

  private _fixupApiSet(markup: string, uid: string): string {
    // Search for a pattern such as this:
    // \[Api set: ExcelApi 1.1\]
    //
    // Hyperlink it like this:
    // \[ [API set: ExcelApi 1.1](http://bing.com?type=excel) \]
    markup = markup.replace(/Api/, 'API');
    return markup.replace(/\\\[(API set:[^\]]+)\\\]/, '\\[ [$1](' + this._getApiSetUrl(uid) + ') \\]');
  }

  // Gets the link to the API set based on product context. Seeks a case-insensitve match in the hash set.
  private _getApiSetUrl(uid: string) {
    for (var key in this._apiSetUrls) {
      let regexp = new RegExp(key, 'i');
      if (regexp.test(uid)) {
          return this._apiSetUrls[key];
      }
    }
    return this._apiSetUrls["Default"]; // match not found.
  }

}
