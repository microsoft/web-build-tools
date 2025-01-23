// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { DocNode, DocLinkTag, StringBuilder } from '@microsoft/tsdoc';
import type { ApiModel, IResolveDeclarationReferenceResult, ApiItem } from '@microsoft/api-extractor-model';
import { Colorize } from '@rushstack/terminal';

import { CustomDocNodeKind } from '../nodes/CustomDocNodeKind';
import type { DocHeading } from '../nodes/DocHeading';
import type { DocNoteBox } from '../nodes/DocNoteBox';
import type { DocTable } from '../nodes/DocTable';
import type { DocTableCell } from '../nodes/DocTableCell';
import type { DocEmphasisSpan } from '../nodes/DocEmphasisSpan';
import {
  MarkdownEmitter,
  type IMarkdownEmitterContext,
  type IMarkdownEmitterOptions
} from './MarkdownEmitter';
import type { IndentedWriter } from '../utils/IndentedWriter';

export interface ICustomMarkdownEmitterOptions extends IMarkdownEmitterOptions {
  contextApiItem: ApiItem | undefined;

  onGetFilenameForApiItem: (apiItem: ApiItem) => string | undefined;
}

export class CustomMarkdownEmitter extends MarkdownEmitter {
  private _apiModel: ApiModel;

  public constructor(apiModel: ApiModel) {
    super();

    this._apiModel = apiModel;
  }

  public emit(
    stringBuilder: StringBuilder,
    docNode: DocNode,
    options: ICustomMarkdownEmitterOptions
  ): string {
    return super.emit(stringBuilder, docNode, options);
  }

  /** @override */
  protected writeNode(docNode: DocNode, context: IMarkdownEmitterContext, docNodeSiblings: boolean): void {
    const writer: IndentedWriter = context.writer;

    switch (docNode.kind) {
      case CustomDocNodeKind.Heading: {
        const docHeading: DocHeading = docNode as DocHeading;
        writer.ensureSkippedLine();

        let prefix: string;
        switch (docHeading.level) {
          case 1:
            prefix = '##';
            break;
          case 2:
            prefix = '###';
            break;
          case 3:
            prefix = '###';
            break;
          default:
            prefix = '####';
        }

        writer.writeLine(prefix + ' ' + this.getEscapedText(docHeading.title));
        writer.writeLine();
        break;
      }
      case CustomDocNodeKind.NoteBox: {
        const docNoteBox: DocNoteBox = docNode as DocNoteBox;
        writer.ensureNewLine();

        writer.increaseIndent('> ');

        this.writeNode(docNoteBox.content, context, false);
        writer.ensureNewLine();

        writer.decreaseIndent();

        writer.writeLine();
        break;
      }
      case CustomDocNodeKind.Table: {
        const docTable: DocTable = docNode as DocTable;
        // GitHub's markdown renderer chokes on tables that don't have a blank line above them,
        // whereas VS Code's renderer is totally fine with it.
        writer.ensureSkippedLine();

        // Markdown table rows can have inconsistent cell counts.  Size the table based on the longest row.
        let columnCount: number = 0;
        if (docTable.header) {
          columnCount = docTable.header.cells.length;
        }
        for (const row of docTable.rows) {
          if (row.cells.length > columnCount) {
            columnCount = row.cells.length;
          }
        }

        writer.write('<table>');
        if (docTable.header) {
          writer.write('<thead><tr>');
          for (let i: number = 0; i < columnCount; ++i) {
            writer.write('<th>');
            writer.ensureNewLine();
            writer.writeLine();
            const cell: DocTableCell | undefined = docTable.header.cells[i];
            if (cell) {
              this.writeNode(cell.content, context, false);
            }
            writer.ensureNewLine();
            writer.writeLine();
            writer.write('</th>');
          }
          writer.write('</tr></thead>');
        }
        writer.writeLine();

        writer.write('<tbody>');
        for (const row of docTable.rows) {
          writer.write('<tr>');
          for (const cell of row.cells) {
            writer.write('<td>');
            writer.ensureNewLine();
            writer.writeLine();
            this.writeNode(cell.content, context, false);
            writer.ensureNewLine();
            writer.writeLine();
            writer.write('</td>');
          }
          writer.write('</tr>');
          writer.writeLine();
        }
        writer.write('</tbody>');
        writer.write('</table>');
        writer.ensureNewLine();
        writer.writeLine();

        break;
      }
      case CustomDocNodeKind.EmphasisSpan: {
        const docEmphasisSpan: DocEmphasisSpan = docNode as DocEmphasisSpan;
        const oldBold: boolean = context.boldRequested;
        const oldItalic: boolean = context.italicRequested;
        context.boldRequested = docEmphasisSpan.bold;
        context.italicRequested = docEmphasisSpan.italic;
        this.writeNodes(docEmphasisSpan.nodes, context);
        context.boldRequested = oldBold;
        context.italicRequested = oldItalic;
        break;
      }
      default:
        super.writeNode(docNode, context, docNodeSiblings);
    }
  }

  /** @override */
  protected writeLinkTagWithCodeDestination(
    docLinkTag: DocLinkTag,
    context: IMarkdownEmitterContext<ICustomMarkdownEmitterOptions>
  ): void {
    const options: ICustomMarkdownEmitterOptions = context.options;

    const result: IResolveDeclarationReferenceResult = this._apiModel.resolveDeclarationReference(
      docLinkTag.codeDestination!,
      options.contextApiItem
    );

    if (result.resolvedApiItem) {
      const filename: string | undefined = options.onGetFilenameForApiItem(result.resolvedApiItem);

      if (filename) {
        let linkText: string = docLinkTag.linkText || '';
        if (linkText.length === 0) {
          // Generate a name such as Namespace1.Namespace2.MyClass.myMethod()
          linkText = result.resolvedApiItem.getScopedNameWithinPackage();
        }
        if (linkText.length > 0) {
          const encodedLinkText: string = this.getEscapedText(linkText.replace(/\s+/g, ' '));

          context.writer.write('[');
          context.writer.write(encodedLinkText);
          context.writer.write(`](${filename!})`);
        } else {
          console.log(Colorize.yellow('WARNING: Unable to determine link text'));
        }
      }
    } else if (result.errorMessage) {
      console.log(
        Colorize.yellow(
          `WARNING: Unable to resolve reference "${docLinkTag.codeDestination!.emitAsTsdoc()}": ` +
            result.errorMessage
        )
      );
    }
  }
}
