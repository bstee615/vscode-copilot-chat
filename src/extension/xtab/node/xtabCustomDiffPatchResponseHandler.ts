/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AggressivenessLevel } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { NoNextEditReason, PushEdit, StreamedEdit } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { Result } from '../../../util/common/result';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { LineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { LineRange } from '../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { ResponseTags } from '../common/tags';

export enum ConfidenceLevel {
	Low = 'low',
	Medium = 'medium',
	High = 'high',
}

/**
 * Determines if a suggestion should be shown based on confidence level and aggressiveness setting.
 * - Low aggressiveness: only show high confidence suggestions
 * - Medium aggressiveness: show medium and high confidence suggestions
 * - High aggressiveness: show all suggestions
 */
export function shouldShowSuggestion(confidence: ConfidenceLevel | undefined, aggressiveness: AggressivenessLevel): boolean {
	// If no confidence level is provided, show the suggestion (backwards compatibility)
	if (confidence === undefined) {
		return true;
	}

	switch (aggressiveness) {
		case AggressivenessLevel.Low:
			return confidence === ConfidenceLevel.High;
		case AggressivenessLevel.Medium:
			return confidence === ConfidenceLevel.High || confidence === ConfidenceLevel.Medium;
		case AggressivenessLevel.High:
			return true;
	}
}


class Patch {
	public removedLines: string[] = [];
	public addedLines: string[] = [];

	private constructor(
		public readonly filename: string,
		public readonly lineNumZeroBased: number,
	) { }

	public static ofLine(line: string): Patch | null {
		const match = line.match(/^(.+):(\d+)$/);
		if (!match) {
			return null;
		}
		const [, filename, lineNumber] = match;
		return new Patch(filename, parseInt(lineNumber, 10));
	}

	addLine(line: string) {
		const contentLine = line.slice(1);
		if (line.startsWith('-')) {
			this.removedLines.push(contentLine);
			return true;
		} else if (line.startsWith('+')) {
			this.addedLines.push(contentLine);
			return true;
		} else {
			return false;
		}
	}

	public toString(): string {
		return [
			`${this.filename}:${this.lineNumZeroBased}`,
			...this.removedLines.map(l => `-${l}`),
			...this.addedLines.map(l => `+${l}`),
		].join('\n');
	}
}


export class XtabCustomDiffPatchResponseHandler {

	private static readonly CONFIDENCE_TAG_REGEX = /<\|confidence\|>(low|medium|high)<\|\/confidence\|>/;

	/**
	 * Parses the confidence level from a line containing the confidence tag.
	 * Returns undefined if no confidence tag is found.
	 */
	public static parseConfidenceLevel(line: string): ConfidenceLevel | undefined {
		const match = line.match(XtabCustomDiffPatchResponseHandler.CONFIDENCE_TAG_REGEX);
		if (!match) {
			return undefined;
		}
		return match[1] as ConfidenceLevel;
	}

	/**
	 * Removes the confidence tag from a line if present.
	 */
	public static stripConfidenceTag(line: string): string {
		return line.replace(XtabCustomDiffPatchResponseHandler.CONFIDENCE_TAG_REGEX, '').trim();
	}

	/**
	 * Handles the response stream and pushes edits.
	 */
	public static async handleResponse(
		pushEdit: PushEdit,
		linesStream: AsyncIterableObject<string>,
		documentBeforeEdits: StringText,
		window: OffsetRange | undefined,
	): Promise<void> {
		let editCount = 0;

		for await (const { edit } of XtabCustomDiffPatchResponseHandler.extractEdits(linesStream)) {
			editCount++;

			pushEdit(Result.ok({
				edit: XtabCustomDiffPatchResponseHandler.resolveEdit(edit),
				window,
				// targetDocument, // TODO@ulugbekna: implement target document resolution
			} satisfies StreamedEdit));
		}
		if (editCount === 0) {
			pushEdit(Result.error(new NoNextEditReason.NoSuggestions(documentBeforeEdits, window, undefined)));
		}
	}

	private static resolveEdit(patch: Patch): LineReplacement {
		return new LineReplacement(new LineRange(patch.lineNumZeroBased + 1, patch.lineNumZeroBased + 1 + patch.removedLines.length), patch.addedLines);
	}

	public static async *extractEdits(linesStream: AsyncIterableObject<string>): AsyncGenerator<{ edit: Patch; parsedConfidence: ConfidenceLevel | undefined }> {
		let currentPatch: Patch | null = null;
		let lastLine: string | undefined;
		const completedPatches: Patch[] = [];

		for await (const line of linesStream) {
			lastLine = line;

			// if no current patch, try to parse a new one
			if (line.trim() === ResponseTags.NO_EDIT) {
				break;
			}
			if (currentPatch === null) {
				currentPatch = Patch.ofLine(line);
				continue;
			}
			// try to add line to current patch
			if (currentPatch.addLine(line)) {
				continue;
			} else { // line does not belong to current patch, save it and start new
				completedPatches.push(currentPatch);
				currentPatch = Patch.ofLine(line);
			}
		}

		// Parse confidence from the last line
		let parsedConfidence: ConfidenceLevel | undefined;
		if (lastLine !== undefined) {
			parsedConfidence = XtabCustomDiffPatchResponseHandler.parseConfidenceLevel(lastLine);
		}

		// Add the final patch if there is one
		if (currentPatch) {
			completedPatches.push(currentPatch);
		}

		// Yield all patches - only the last one gets the parsed confidence
		for (let i = 0; i < completedPatches.length; i++) {
			const isLast = i === completedPatches.length - 1;
			yield { edit: completedPatches[i], parsedConfidence: isLast ? parsedConfidence : undefined };
		}
	}
}
