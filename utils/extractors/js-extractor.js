/**
 * JavaScript/TypeScript Language Extractor.
 * Extracts exported functions, classes, and constants with JSDoc comments.
 */

export class JSExtractor {
  extensions = ['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'];

  /**
   * Extract all exported symbols from JS/TS file content.
   * Returns { definitions: [], localRefs: [], imports: [] } for two-phase extraction.
   * @param {string} content
   * @param {string} filePath
   * @returns {{ definitions: ExportSymbol[], localRefs: LocalRef[], imports: Import[] }}
   */
  extractExports(content, filePath) {
    const symbols = [];
    const localRefs = [];
    const imports = [];

    const lines = content.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track import statements for cross-file resolution
      if (/^import\s+/.test(trimmed)) {
        const importInfo = this._parseImport(trimmed, lines, i);
        if (importInfo) {
          imports.push(...importInfo);
        }
        i++;
        continue;
      }

      // export default function/class
      const defaultMatch = trimmed.match(/^export\s+default\s+(function|class|const|let|var)?\s*(\w+)/);
      if (defaultMatch) {
        const name = defaultMatch[2] || 'default';
        const kind = this._detectKind(content, i, name);
        const docstring = this._extractJSDoc(lines, i);
        const signature = this._extractSignature(content, i, name, kind);
        const location = this._extractLocation(lines, i);

        symbols.push({
          name,
          kind,
          symbolId: `${filePath}:${kind}:${name}`,
          signature,
          docstring,
          location: { file: filePath, ...location },
          parameters: this._extractParameters(content, i),
          returnType: this._extractReturnType(docstring),
          isDefault: true,
        });
        i++;
        continue;
      }

      // export async function / export function
      const funcMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        const name = funcMatch[1];
        const docstring = this._extractJSDoc(lines, i);
        const signature = this._extractSignature(content, i, name, 'function');
        const location = this._extractLocation(lines, i);

        symbols.push({
          name,
          kind: 'function',
          symbolId: `${filePath}:func:${name}`,
          signature,
          docstring,
          location: { file: filePath, ...location },
          parameters: this._extractParameters(content, i),
          returnType: this._extractReturnType(docstring),
          isDefault: false,
        });
        i++;
        continue;
      }

      // export class
      const classMatch = trimmed.match(/^export\s+class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1];
        const docstring = this._extractJSDoc(lines, i);
        const location = this._extractLocation(lines, i);
        const methods = this._extractClassMethods(content, i, filePath, name);

        symbols.push({
          name,
          kind: 'class',
          symbolId: `${filePath}:class:${name}`,
          signature: `class ${name}`,
          docstring,
          location: { file: filePath, ...location },
          parameters: [],
          returnType: '',
          methods,
          isDefault: false,
        });
        i++;
        continue;
      }

      // export const/let/var
      const constMatch = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (constMatch) {
        const name = constMatch[1];
        const docstring = this._extractJSDoc(lines, i);
        const signature = this._extractSignature(content, i, name, 'constant');
        const location = this._extractLocation(lines, i);

        symbols.push({
          name,
          kind: 'constant',
          symbolId: `${filePath}:const:${name}`,
          signature,
          docstring,
          location: { file: filePath, ...location },
          parameters: [],
          returnType: this._inferType(content, i),
          isDefault: false,
        });
        i++;
        continue;
      }

      // export { names }
      const namedExportsMatch = trimmed.match(/^export\s+{\s*([^}]+)\s*}/);
      if (namedExportsMatch) {
        const exportedNames = namedExportsMatch[1]
          .split(',')
          .map((s) => s.trim().split(' as ').pop().trim())
          .filter((s) => s);

        for (const name of exportedNames) {
          const docstring = '';
          const location = this._extractLocation(lines, i);
          symbols.push({
            name,
            kind: 'export',
            symbolId: `${filePath}:export:${name}`,
            signature: name,
            docstring,
            location: { file: filePath, ...location },
            parameters: [],
            returnType: '',
            isDefault: false,
          });
        }
        i++;
        continue;
      }

      // Track function/class calls and references
      const callMatch = trimmed.match(/(\w+)\s*\(/);
      if (callMatch && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
        const refName = callMatch[1];
        if (refName && !['if', 'else', 'for', 'while', 'switch', 'case', 'return', 'throw', 'new', 'typeof', 'delete'].includes(refName)) {
          localRefs.push({
            name: refName,
            line: i + 1,
            col: trimmed.indexOf(refName) + 1,
            kind: 'call',
          });
        }
      }

      i++;
    }

    return { definitions: symbols, localRefs, imports };
  }

  /**
   * Parse import statements and return { localName, sourceFile, isDefault } entries.
   */
  _parseImport(trimmed, lines, lineIndex) {
    const imports = [];

    // import { name1, name2 } from './module'
    const namedMatch = trimmed.match(/^import\s+{\s*([^}]+)\s*}\s+from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map((s) => s.trim().split(' as ').pop().trim());
      const sourceFile = this._resolveImportPath(namedMatch[2], lines[lineIndex]);
      for (const name of names) {
        if (name) imports.push({ localName: name, sourceFile, isDefault: false });
      }
      return imports;
    }

    // import name from './module'
    const defaultMatch = trimmed.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      return [{ localName: defaultMatch[1], sourceFile: this._resolveImportPath(defaultMatch[2], lines[lineIndex]), isDefault: true }];
    }

    // import * as name from './module'
    const namespaceMatch = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (namespaceMatch) {
      return [{ localName: namespaceMatch[1], sourceFile: this._resolveImportPath(namespaceMatch[2], lines[lineIndex]), isDefault: false, isNamespace: true }];
    }

    // import './module' (side-effect import)
    const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch) {
      return [{ localName: '__default', sourceFile: this._resolveImportPath(sideEffectMatch[1], lines[lineIndex]), isDefault: true }];
    }

    return null;
  }

  /**
   * Resolve relative import path to absolute file path.
   */
  _resolveImportPath(importPath, line) {
    return importPath;
  }

  /**
   * Extract JSDoc comment block preceding the current line.
   */
  _extractJSDoc(lines, lineIndex) {
    let docstring = '';
    let i = lineIndex - 1;

    while (i >= 0) {
      const prev = lines[i].trim();
      if (prev === '*/') {
        let block = '';
        let j = i - 1;
        while (j >= 0) {
          const curr = lines[j].trim();
          if (curr === '/**') break;
          block = curr + '\n' + block;
          j--;
        }
        docstring = block.trim();
        break;
      }
      if (prev === '' || prev.startsWith('*') || prev.startsWith('//')) {
        i--;
        continue;
      }
      break;
    }

    return docstring;
  }

  /**
   * Detect symbol kind from content at line.
   */
  _detectKind(content, lineIndex, name) {
    const lines = content.split('\n');
    const line = lines[lineIndex]?.trim() || '';
    if (line.includes('class')) return 'class';
    if (line.includes('function')) return 'function';
    return 'constant';
  }

  /**
   * Extract a normalized signature string.
   */
  _extractSignature(content, lineIndex, name, kind) {
    const lines = content.split('\n');
    const line = lines[lineIndex]?.trim() || '';

    if (kind === 'class') {
      return `class ${name}`;
    }

    const funcMatch = line.match(/function\s+\w+\s*\(([^)]*)\)/);
    const arrowMatch = line.match(/^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
    const methodMatch = line.match(/\s*\(([^)]*)\)\s*(?::|\{)/);

    if (funcMatch || methodMatch) {
      const params = (funcMatch || methodMatch)[1];
      return `${name}(${params})`;
    }

    return name;
  }

  /**
   * Extract line number range for a symbol.
   */
  _extractLocation(lines, lineIndex) {
    return {
      line: lineIndex + 1,
      endLine: lineIndex + 1,
    };
  }

  /**
   * Extract parameters from function signature.
   */
  _extractParameters(content, lineIndex) {
    const lines = content.split('\n');
    const line = lines[lineIndex] || '';

    const funcMatch = line.match(/function\s+\w+\s*\(([^)]*)\)/);
    const arrowMatch = line.match(/\)\s*=>/);

    if (funcMatch) {
      return this._parseParams(funcMatch[1]);
    }

    return [];
  }

  /**
   * Parse parameter string into Parameter[].
   */
  _parseParams(paramStr) {
    if (!paramStr.trim()) return [];

    return paramStr.split(',').map((p) => {
      p = p.trim();
      const destructureMatch = p.match(/^[{[]\s*(.+?)\s*[}\]]$/);
      if (destructureMatch) {
        const inner = destructureMatch[1];
        return {
          name: `{${inner}}`,
          type: 'destructured',
          optional: p.includes('?'),
          description: '',
        };
      }

      const typedMatch = p.match(/^(\w+)(?:\?\s*)?:\s*(.+)/);
      if (typedMatch) {
        return {
          name: typedMatch[1],
          type: typedMatch[2].trim(),
          optional: p.includes('?'),
          description: '',
        };
      }

      const optionalMatch = p.match(/^(\w+)\s*\?/);
      if (optionalMatch) {
        return {
          name: optionalMatch[1],
          type: 'unknown',
          optional: true,
          description: '',
        };
      }

      return {
        name: p,
        type: 'unknown',
        optional: false,
        description: '',
      };
    });
  }

  /**
   * Infer type from variable initialization.
   */
  _inferType(content, lineIndex) {
    const lines = content.split('\n');
    const line = lines[lineIndex] || '';
    const typeMatch = line.match(/:?\s*(\w+)\s*[=;]/);
    return typeMatch ? typeMatch[1] : 'unknown';
  }

  /**
   * Extract @returns or @return JSDoc tag.
   */
  _extractReturnType(docstring) {
    if (!docstring) return '';
    const returnMatch = docstring.match(/@(returns?)\s+(.+)/i);
    return returnMatch ? returnMatch[2].trim() : '';
  }

  /**
   * Extract class methods from class body.
   */
  _extractClassMethods(content, lineIndex, filePath, className) {
    const symbols = [];
    const lines = content.split('\n');
    let braceCount = 0;
    let started = false;

    for (let i = lineIndex; i < lines.length; i++) {
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
      const cleanLine = trimmed.replace(/^(public|private|protected|async|static)\s+/, '');

      const methodMatch = cleanLine.match(/^(\w+)\s*\(([^)]*)\)\s*(?::|\{)/);
      if (methodMatch && !['constructor', 'get', 'set'].includes(methodMatch[1])) {
        const name = methodMatch[1];
        const params = methodMatch[2];
        const docstring = this._extractJSDoc(lines, i);
        const qualifiedName = `${className}.${name}`;
        symbols.push({
          name,
          kind: 'method',
          symbolId: `${filePath}:method:${qualifiedName}`,
          signature: `${name}(${params})`,
          docstring,
          location: { file: filePath, line: i + 1, endLine: i + 1 },
          parameters: this._parseParams(params),
          returnType: this._extractReturnType(docstring),
        });
      }
    }

    return symbols;
  }
}
