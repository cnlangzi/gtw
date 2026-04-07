/**
 * Go Language Extractor.
 * Extracts exported functions (capitalized) and types with godoc comments.
 */

export class GoExtractor {
  extensions = ['.go'];

  /**
   * Extract all exported symbols from Go file content.
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

      // Skip build tags, package clause, imports
      if (line.startsWith('//go:') || line.startsWith('// +build') || line.startsWith('package ') || line.startsWith('import (')) {
        i++;
        continue;
      }
      if (line === 'import' || line === ')') {
        i++;
        continue;
      }

      // Skip blank lines and single-line comments
      if (line === '' || line.startsWith('//')) {
        i++;
        continue;
      }

      // function FuncName
      const funcMatch = line.match(/^func\s+(\w+)\s*\(([^)]*)\)/);
      if (funcMatch) {
        const name = funcMatch[1];
        const params = funcMatch[2];
        const docstring = this._extractGoDoc(lines, i);
        const signature = this._buildSignature(name, params, this._extractReturnType(lines, i + 1));
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'function',
          signature,
          docstring,
          location,
          parameters: this._parseParams(params),
          returnType: this._extractReturnType(lines, i + 1),
          isDefault: false,
        });
        i++;
        continue;
      }

      // method (receiver) FuncName
      const methodMatch = line.match(/^func\s+\((\w+\s+\*?\w+)\)\s+(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        const receiver = methodMatch[1];
        const name = methodMatch[2];
        const params = methodMatch[3];
        const docstring = this._extractGoDoc(lines, i);
        const signature = this._buildSignature(name, params, this._extractReturnType(lines, i + 1), receiver);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'method',
          signature,
          docstring,
          location,
          parameters: this._parseParams(params),
          returnType: this._extractReturnType(lines, i + 1),
          receiver,
          isDefault: false,
        });
        i++;
        continue;
      }

      // type FuncName struct/interface
      const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const kind = typeMatch[2] === 'struct' ? 'struct' : 'interface';
        const docstring = this._extractGoDoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        if (kind === 'struct') {
          // Parse struct fields
          const fields = this._extractStructFields(lines, i);
          symbols.push({
            name,
            kind,
            signature: `type ${name} struct`,
            docstring,
            location,
            parameters: [],
            returnType: '',
            fields,
            isDefault: false,
          });
        } else {
          // Parse interface methods
          const methods = this._extractInterfaceMethods(lines, i);
          symbols.push({
            name,
            kind,
            signature: `type ${name} interface`,
            docstring,
            location,
            parameters: [],
            returnType: '',
            methods,
            isDefault: false,
          });
        }
        i++;
        continue;
      }

      // type FuncName = ...
      const typeAliasMatch = line.match(/^type\s+(\w+)\s*=/);
      if (typeAliasMatch) {
        const name = typeAliasMatch[1];
        const docstring = this._extractGoDoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'type_alias',
          signature: `type ${name}`,
          docstring,
          location,
          parameters: [],
          returnType: '',
          isDefault: false,
        });
        i++;
        continue;
      }

      // const/var declarations
      const constMatch = line.match(/^(?:const|var)\s+(\w+)/);
      if (constMatch) {
        const name = constMatch[1];
        const docstring = this._extractGoDoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'constant',
          signature: `${name}`,
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
   * Extract Go doc comment preceding the current line.
   * Go doc comments are regular // comments immediately preceding the declaration.
   * @param {string[]} lines
   * @param {number} lineIndex
   * @returns {string}
   */
  _extractGoDoc(lines, lineIndex) {
    let docstring = '';
    let i = lineIndex - 1;

    while (i >= 0) {
      const prev = lines[i].trim();
      if (prev === '' || prev.startsWith('//')) {
        docstring = prev.replace(/^\/\/\s*/, '') + '\n' + docstring;
        i--;
        continue;
      }
      break;
    }

    return docstring.trim();
  }

  /**
   * Build a normalized signature string.
   */
  _buildSignature(name, params, returnType, receiver = '') {
    const paramStr = this._formatParams(params);
    const receiverStr = receiver ? `( ${receiver}) ` : '';
    const retStr = returnType ? `: ${returnType}` : '';
    return `${receiverStr}${name}(${paramStr})${retStr}`;
  }

  /**
   * Extract return type from next line if on separate line.
   */
  _extractReturnType(lines, nextLineIndex) {
    if (nextLineIndex >= lines.length) return '';
    const nextLine = lines[nextLineIndex]?.trim() || '';
    // If next line starts with ( it's the return type in parentheses
    const tupleMatch = nextLine.match(/^\(([^)]+)\)/);
    if (tupleMatch) {
      return tupleMatch[1].trim();
    }
    // Single return type
    const retMatch = nextLine.match(/^\w+/);
    return retMatch ? retMatch[0] : '';
  }

  /**
   * Parse Go parameter list.
   */
  _parseParams(paramStr) {
    if (!paramStr.trim()) return [];

    const params = [];
    // Split by comma but respect <T> and func() patterns
    const parts = this._splitParams(paramStr);

    for (const p of parts) {
      const trimmed = p.trim();
      // name type or name *type
      const match = trimmed.match(/^(\w+)\s+(\*?\S+)/);
      if (match) {
        params.push({
          name: match[1],
          type: match[2],
          optional: false,
          description: '',
        });
      } else if (trimmed) {
        params.push({
          name: trimmed,
          type: 'unknown',
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
   * Format params for signature display.
   */
  _formatParams(paramStr) {
    if (!paramStr.trim()) return '';

    const parts = this._splitParams(paramStr);
    return parts
      .map((p) => {
        const trimmed = p.trim();
        const match = trimmed.match(/^(\w+)\s+(\*?\S+)/);
        return match ? `${match[1]} ${match[2]}` : trimmed;
      })
      .join(', ');
  }

  /**
   * Extract struct fields until closing brace.
   */
  _extractStructFields(lines, startLine) {
    const fields = [];
    let braceCount = 0;
    let started = false;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!started) {
        if (line.includes('{')) {
          started = true;
          braceCount = (line.match(/{/g) || []).length;
          braceCount -= (line.match(/}/g) || []).length;
        }
        continue;
      }

      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0) break;

      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//')) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\*?\w+)/);
      if (fieldMatch) {
        fields.push({
          name: fieldMatch[1],
          type: fieldMatch[2],
        });
      }
    }

    return fields;
  }

  /**
   * Extract interface method signatures.
   */
  _extractInterfaceMethods(lines, startLine) {
    const methods = [];
    let braceCount = 0;
    let started = false;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!started) {
        if (line.includes('{')) {
          started = true;
          braceCount = (line.match(/{/g) || []).length;
          braceCount -= (line.match(/}/g) || []).length;
        }
        continue;
      }

      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0) break;

      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('//')) continue;

      const methodMatch = trimmed.match(/^(\w+)\s*\(([^)]*)\)/);
      if (methodMatch) {
        methods.push({
          name: methodMatch[1],
          signature: `${methodMatch[1]}(${methodMatch[2]})`,
          parameters: this._parseParams(methodMatch[2]),
          returnType: '',
        });
      }
    }

    return methods;
  }
}
