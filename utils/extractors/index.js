/**
 * LanguageExtractor Factory — dispatches to the correct extractor by file extension.
 */

import { JSExtractor } from './js-extractor.js';
import { GoExtractor } from './go-extractor.js';
import { PythonExtractor } from './python-extractor.js';
import { RustExtractor } from './rust-extractor.js';

const extractors = [
  new JSExtractor(),
  new GoExtractor(),
  new PythonExtractor(),
  new RustExtractor(),
];

/**
 * Get the appropriate extractor for a file path.
 * @param {string} filePath
 * @returns {LanguageExtractor | null}
 */
export function getExtractor(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  for (const extractor of extractors) {
    if (extractor.extensions.includes(ext)) {
      return extractor;
    }
  }
  return null;
}

/**
 * Get all supported extensions.
 * @returns {string[]}
 */
export function getSupportedExtensions() {
  return extractors.flatMap((e) => e.extensions);
}
