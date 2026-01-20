/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { AggressivenessLevel } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { AsyncIterableObject } from '../../../../util/vs/base/common/async';
import { ConfidenceLevel, shouldShowSuggestion, XtabCustomDiffPatchResponseHandler } from '../../node/xtabCustomDiffPatchResponseHandler';

describe('XtabCustomDiffPatchResponseHandler', () => {

	async function collectPatches(patchText: string): Promise<string> {
		const linesStream = AsyncIterableObject.fromArray(patchText.split('\n'));
		const patches: string[] = [];
		for await (const { edit } of XtabCustomDiffPatchResponseHandler.extractEdits(linesStream)) {
			patches.push(edit.toString());
		}
		return patches.map(p => p.toString()).join('\n');
	}

	it('should parse a simple patch correctly', async () => {
		const patchText = `file1.txt:10
-Old line 1
-Old line 2
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('should parse a simple patch correctly', async () => {
		const patchText = `/absolutePath/to/my_file.ts:1
-Old line 1
+New line 1
+New line 2
relative/path/to/another_file.js:42
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toEqual(patchText);
	});

	it('discard a patch if no valid header', async () => {
		const patchText = `myFile.ts:
+New line 1
+New line 2
another_file.js:32
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"another_file.js:32
			-Removed line
			+Added line"
		`);
	});

	it('discard a patch if no valid header - 2', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2
another_file.js:
-Removed line
+Added line`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no removed lines', async () => {
		const patchText = `myFile.ts:42
+New line 1
+New line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			+New line 1
			+New line 2"
		`);
	});

	it('discard a patch has no new lines', async () => {
		const patchText = `myFile.ts:42
-Old line 1
-Old line 2`;
		const patches = await collectPatches(patchText);
		expect(patches).toMatchInlineSnapshot(`
			"myFile.ts:42
			-Old line 1
			-Old line 2"
		`);
	});

	describe('confidence level parsing', () => {
		it('should parse high confidence', () => {
			const line = '<|confidence|>high<|/confidence|>';
			expect(XtabCustomDiffPatchResponseHandler.parseConfidenceLevel(line)).toBe(ConfidenceLevel.High);
		});

		it('should parse medium confidence', () => {
			const line = '<|confidence|>medium<|/confidence|>';
			expect(XtabCustomDiffPatchResponseHandler.parseConfidenceLevel(line)).toBe(ConfidenceLevel.Medium);
		});

		it('should parse low confidence', () => {
			const line = '<|confidence|>low<|/confidence|>';
			expect(XtabCustomDiffPatchResponseHandler.parseConfidenceLevel(line)).toBe(ConfidenceLevel.Low);
		});

		it('should return undefined for no confidence tag', () => {
			const line = 'file.ts:42';
			expect(XtabCustomDiffPatchResponseHandler.parseConfidenceLevel(line)).toBeUndefined();
		});

		it('should strip confidence tag from line', () => {
			const line = '<|confidence|>high<|/confidence|>';
			expect(XtabCustomDiffPatchResponseHandler.stripConfidenceTag(line)).toBe('');
		});

		it('should extract confidence from last line of response', async () => {
			const patchText = `file1.txt:10
-Old line 1
+New line 1
<|confidence|>high<|/confidence|>`;
			const linesStream = AsyncIterableObject.fromArray(patchText.split('\n'));
			const results: { edit: unknown; parsedConfidence: ConfidenceLevel | undefined }[] = [];
			for await (const result of XtabCustomDiffPatchResponseHandler.extractEdits(linesStream)) {
				results.push(result);
			}
			expect(results.length).toBe(1);
			expect(results[0].parsedConfidence).toBe(ConfidenceLevel.High);
		});

		it('should not extract confidence from first line of response', async () => {
			const patchText = `<|confidence|>high<|/confidence|>
file1.txt:10
-Old line 1
+New line 1`;
			const linesStream = AsyncIterableObject.fromArray(patchText.split('\n'));
			const results: { edit: unknown; parsedConfidence: ConfidenceLevel | undefined }[] = [];
			for await (const result of XtabCustomDiffPatchResponseHandler.extractEdits(linesStream)) {
				results.push(result);
			}
			expect(results.length).toBe(1);
			expect(results[0].parsedConfidence).toBeUndefined();
		});
	});

	describe('shouldShowSuggestion', () => {
		it('should show all suggestions with high aggressiveness', () => {
			expect(shouldShowSuggestion(ConfidenceLevel.Low, AggressivenessLevel.High)).toBe(true);
			expect(shouldShowSuggestion(ConfidenceLevel.Medium, AggressivenessLevel.High)).toBe(true);
			expect(shouldShowSuggestion(ConfidenceLevel.High, AggressivenessLevel.High)).toBe(true);
		});

		it('should show medium and high confidence with medium aggressiveness', () => {
			expect(shouldShowSuggestion(ConfidenceLevel.Low, AggressivenessLevel.Medium)).toBe(false);
			expect(shouldShowSuggestion(ConfidenceLevel.Medium, AggressivenessLevel.Medium)).toBe(true);
			expect(shouldShowSuggestion(ConfidenceLevel.High, AggressivenessLevel.Medium)).toBe(true);
		});

		it('should only show high confidence with low aggressiveness', () => {
			expect(shouldShowSuggestion(ConfidenceLevel.Low, AggressivenessLevel.Low)).toBe(false);
			expect(shouldShowSuggestion(ConfidenceLevel.Medium, AggressivenessLevel.Low)).toBe(false);
			expect(shouldShowSuggestion(ConfidenceLevel.High, AggressivenessLevel.Low)).toBe(true);
		});

		it('should show suggestions when confidence is undefined (backwards compatibility)', () => {
			expect(shouldShowSuggestion(undefined, AggressivenessLevel.Low)).toBe(true);
			expect(shouldShowSuggestion(undefined, AggressivenessLevel.Medium)).toBe(true);
			expect(shouldShowSuggestion(undefined, AggressivenessLevel.High)).toBe(true);
		});
	});
});
