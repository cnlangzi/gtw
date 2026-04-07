/**
 * Rust Language Extractor.
 * Extracts public functions, structs, enums, traits with rustdoc comments.
 */

export class RustExtractor {
  extensions = ['.rs'];

  /**
   * Extract all exported symbols from Rust file content.
   * Only pub items are considered exported.
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
      if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
        i++;
        continue;
      }

      // pub fn name
      const fnMatch = line.match(/^pub\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const params = fnMatch[2];
        const docstring = this._extractRustdoc(lines, i);
        const returnType = this._extractReturnType(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'function',
          signature: this._buildSignature(name, params, returnType),
          docstring,
          location,
          parameters: this._parseParams(params),
          returnType,
          isDefault: false,
        });
        i++;
        continue;
      }

      // pub struct name
      const structMatch = line.match(/^pub\s+struct\s+(\w+)/);
      if (structMatch) {
        const name = structMatch[1];
        const docstring = this._extractRustdoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };
        const fields = this._extractStructFields(lines, i);

        symbols.push({
          name,
          kind: 'struct',
          signature: `struct ${name}`,
          docstring,
          location,
          parameters: [],
          returnType: '',
          fields,
          isDefault: false,
        });
        i++;
        continue;
      }

      // pub enum name
      const enumMatch = line.match(/^pub\s+enum\s+(\w+)/);
      if (enumMatch) {
        const name = enumMatch[1];
        const docstring = this._extractRustdoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'enum',
          signature: `enum ${name}`,
          docstring,
          location,
          parameters: [],
          returnType: '',
          isDefault: false,
        });
        i++;
        continue;
      }

      // pub trait name
      const traitMatch = line.match(/^pub\s+trait\s+(\w+)/);
      if (traitMatch) {
        const name = traitMatch[1];
        const docstring = this._extractRustdoc(lines, i);
        const location = { file: filePath, line: i + 1, endLine: i + 1 };

        symbols.push({
          name,
          kind: 'trait',
          signature: `trait ${name}`,
          docstring,
          location,
          parameters: [],
          returnType: '',
          isDefault: false,
        });
        i++;
        continue;
      }

      // pub type name
      const typeMatch = line.match(/^pub\s+type\s+(\w+)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const docstring = this._extractRustdoc(lines, i);
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

      // pub const / pub static
      const constMatch = line.match(/^pub\s+(?:const|static)\s+(\w+)/);
      if (constMatch) {
        const name = constMatch[1];
        const docstring = this._extractRustdoc(lines, i);
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
   * Extract rustdoc comment (/// or /*!) preceding the item.
   */
  _extractRustdoc(lines, lineIndex) {
    let docstring = '';
    let i = lineIndex - 1;

    while (i >= 0) {
      const prev = lines[i].trim();
      // /// outer doc, /** */ block doc
      if (prev.startsWith('///')) {
        docstring = prev.replace(/^\/{3}\s*/, '') + '\n' + docstring;
        i--;
        continue;
      }
      break;
    }

    return docstring.trim();
  }

  /**
   * Extract -> ReturnType from function signature line.
   */
  _extractReturnType(lines, lineIndex) {
    const line = lines[lineIndex] || '';
    const retMatch = line.match(/->\s*(.+?)(?:\{|$)/);
    return retMatch ? retMatch[1].trim() : '';
  }

  /**
   * Build normalized signature.
   */
  _buildSignature(name, params, returnType) {
    const retStr = returnType ? ` -> ${returnType}` : '';
    return `${name}(${params})${retStr}`;
  }

  /**
   * Parse Rust parameter list (simplified).
   */
  _parseParams(paramStr) {
    if (!paramStr.trim()) return [];

    const params = [];
    const parts = paramStr.split(',').map((p) => p.trim());

    for (const p of parts) {
      // name: Type or name: &Type
      const match = p.match(/^(\w+)\s*:\s*(.+)/);
      if (match) {
        params.push({
          name: match[1],
          type: match[2],
          optional: false,
          description: '',
        });
      } else if (p) {
        params.push({
          name: p,
          type: 'unknown',
          optional: false,
          description: '',
        });
      }
    }

    return params;
  }

  /**
   * Extract struct fields (simplified — no generics).
   */
  _extractStructFields(lines, startLine) {
    const fields = [];
    let braceCount = 0;
    let started = false;

    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();

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

      const fieldMatch = line.match(/^(\w+)\s*:\s*([^,;]+)/);
      if (fieldMatch) {
        fields.push({
          name: fieldMatch[1],
          type: fieldMatch[2].trim(),
        });
      }
    }

    return fields;
  }
}
