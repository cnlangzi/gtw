/**
 * Python Language Extractor.
 * Extracts functions, classes, and async functions with docstrings.
 */

export class PythonExtractor {
  extensions = ['.py'];

  /**
   * Extract all exported symbols from Python file content.
   * @param {string} content
   * @param {string} filePath
   * @returns {ExportSymbol[]}
   */
  extractExports(content, filePath) {
    const symbols = [];
    const lines = content.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      // Skip blank lines and comments
      if (line === '' || line.startsWith('#')) {
        i++;
        continue;
      }

      // async def func_name
      const asyncMatch = line.match(/^async\s+def\s+(\w+)\s*\(([^)]*)\)/);
      if (asyncMatch) {
        const name = asyncMatch[1];
        const params = asyncMatch[2];
        const docstring = this._extractDocstring(lines, i + 1);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };
        const returnType = this._inferReturnType(docstring);

        symbols.push({
          name,
          kind: 'async_function',
          signature: `def ${name}(${params}) -> ${returnType || 'None'}`,
          docstring,
          location,
          parameters: this._parseParams(params),
          returnType: returnType || 'None',
          isDefault: false,
        });
        i++;
        continue;
      }

      // def func_name
      const funcMatch = line.match(/^def\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const name = funcMatch[1];
        const params = funcMatch[2];
        const docstring = this._extractDocstring(lines, i + 1);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };
        const returnType = this._inferReturnType(docstring);

        symbols.push({
          name,
          kind: 'function',
          signature: `def ${name}(${params}) -> ${returnType || 'None'}`,
          docstring,
          location,
          parameters: this._parseParams(params),
          returnType: returnType || 'None',
          isDefault: false,
        });
        i++;
        continue;
      }

      // class ClassName(Base):
      const classMatch = line.match(/^class\s+(\w+)\s*(?:\([^)]*\))?/);
      if (classMatch) {
        const name = classMatch[1];
        const docstring = this._extractDocstring(lines, i + 1);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };
        const methods = this._extractClassMethods(content, i, filePath, name);

        symbols.push({
          name,
          kind: 'class',
          signature: `class ${name}`,
          docstring,
          location,
          parameters: [],
          returnType: '',
          methods,
          isDefault: false,
        });
        i++;
        continue;
      }

      // CONSTANT = value
      const constMatch = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
      if (constMatch) {
        const name = constMatch[1];
        const docstring = this._extractDocstring(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'constant',
          signature: name,
          docstring,
          location,
          parameters: [],
          returnType: '',
          isDefault: false,
        });
        i++;
        continue;
      }

      i++;
    }

    return symbols;
  }

  // ---------------------------------------------------------------------------

  /**
   * Extract Python docstring following the PEP 257 convention.
   * Handles both triple-quote styles: """ and '''
   * @param {string[]} lines
   * @param {number} lineIndex - line AFTER the def/class line
   * @returns {string}
   */
  _extractDocstring(lines, lineIndex) {
    if (lineIndex >= lines.length) return '';

    const nextLine = lines[lineIndex].trim();
    const tripleDouble = nextLine.startsWith('"""');
    const tripleSingle = nextLine.startsWith("'''");
    const quote = tripleDouble ? '"""' : tripleSingle ? "'''" : null;

    if (!quote) return '';

    // Single-line docstring
    const singleLineMatch = nextLine.match(/^"""(.*)"""$/s) || nextLine.match(/^'''(.*)'''$/s);
    if (singleLineMatch) {
      return singleLineMatch[1].trim();
    }

    // Multi-line docstring
    let docstring = '';
    let i = lineIndex + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().endsWith(quote)) {
        docstring += '\n' + line.slice(0, line.lastIndexOf(quote)).trim();
        break;
      }
      docstring += '\n' + line;
      i++;
    }

    return docstring.trim();
  }

  /**
   * Parse Python parameter list.
   */
  _parseParams(paramStr) {
    if (!paramStr.trim()) return [];

    const params = [];
    const parts = this._splitParams(paramStr);

    for (const p of parts) {
      const trimmed = p.trim();
      // name: type = default
      const typedMatch = trimmed.match(/^(\w+)\s*(?::\s*([^=]+?))?(?:\s*=\s*(.+))?$/);
      if (typedMatch) {
        params.push({
          name: typedMatch[1],
          type: typedMatch[2] || 'unknown',
          defaultValue: typedMatch[3] || null,
          optional: trimmed.includes('='),
          description: '',
        });
      } else if (trimmed) {
        params.push({
          name: trimmed,
          type: 'unknown',
          defaultValue: null,
          optional: false,
          description: '',
        });
      }
    }

    return params;
  }

  /**
   * Split parameter string respecting nested brackets.
   */
  _splitParams(paramStr) {
    const parts = [];
    let depth = 0;
    let current = '';

    for (const ch of paramStr) {
      if (ch === '<' || ch === '(' || ch === '[') depth++;
      else if (ch === '>' || ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) parts.push(current);

    return parts;
  }

  /**
   * Infer return type from docstring (Google/NumPy style).
   */
  _inferReturnType(docstring) {
    if (!docstring) return '';

    // Google style: Returns:
    const returnsMatch = docstring.match(/Returns?:\s*(.+?)(?:\n\n|$)/is);
    if (returnsMatch) return returnsMatch[1].trim();

    // NumPy style: Returns -------
    const numpyMatch = docstring.match(/Returns\n\s*-+(.*?)(?:\n\n|$)/is);
    if (numpyMatch) return numpyMatch[1].trim();

    // Type annotation hint in docstring: :rtype:
    const rtypeMatch = docstring.match(/:rtype:\s*(.+?)(?:\n|$)/i);
    if (rtypeMatch) return rtypeMatch[1].trim();

    return '';
  }

  /**
   * Extract class methods from class body.
   */
  _extractClassMethods(content, classLineIndex, filePath, className) {
    const symbols = [];
    const lines = content.split('\n');
    let indent = -1;
    let started = false;

    for (let i = classLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!started) {
        if (trimmed !== '' && !trimmed.startsWith('#')) {
          indent = line.match(/^(\s*)/)[1].length;
          started = true;
        }
        continue;
      }

      // Dedented back to class level or less = end of class
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        const currentIndent = line.match(/^(\s*)/)[1].length;
        if (currentIndent < indent) break;
      }

      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const methodMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const name = methodMatch[1];
        if (name.startsWith('_') && name !== '__init__') continue; // skip private

        const params = methodMatch[2];
        const docstring = this._extractDocstring(lines, i + 1);

        symbols.push({
          name,
          kind: trimmed.startsWith('async') ? 'async_method' : 'method',
          signature: `${name}(${params})`,
          docstring,
          location: { file: filePath, line: i + 1, endLine: i + 1 },
          parameters: this._parseParams(params),
          returnType: this._inferReturnType(docstring),
        });
      }
    }

    return symbols;
  }
}
