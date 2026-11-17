/**
 * Validates Postman scripts: JavaScript syntax (compiled with the Function
 * constructor, never executed) plus warnings for APIs that can send data off
 * the machine or execute dynamic code. Use it before running collections that
 * came from somewhere else.
 */

const SUSPICIOUS = [
  [/pm\.sendRequest\s*\(/, 'pm.sendRequest (sends an extra HTTP request)'],
  [/\beval\s*\(/, 'eval (executes dynamic code)'],
  [/\bnew\s+Function\s*\(|\bFunction\s*\(/, 'Function constructor (executes dynamic code)'],
  [/\brequire\s*\(/, 'require (loads sandbox modules)'],
  [/\bfetch\s*\(|XMLHttpRequest/, 'network access'],
  [/pm\.(environment|globals|collectionVariables)\.toObject\s*\(/, 'reads every variable at once'],
];

export class ScriptChecker {
  /**
   * @returns {{ total:number, valid:number, errors:Array<{request,folder,error}>, warnings:Array<{request,folder,warning}> }}
   */
  check(positiveCollection, negativeCollection) {
    const results = [
      this.checkCollection(positiveCollection, 'Positive'),
      this.checkCollection(negativeCollection, 'Negative'),
    ];
    return {
      total: results.reduce((n, r) => n + r.total, 0),
      valid: results.reduce((n, r) => n + r.valid, 0),
      errors: results.flatMap(r => r.errors),
      warnings: results.flatMap(r => r.warnings),
    };
  }

  checkCollection(collection, collectionName) {
    let total = 0;
    let valid = 0;
    const errors = [];
    const warnings = [];

    const inspect = (events, request, folder) => {
      for (const event of events || []) {
        if (!event.script?.exec) continue;
        total++;
        const script = Array.isArray(event.script.exec) ? event.script.exec.join('\n') : String(event.script.exec);
        const error = this.checkSyntax(script);
        if (error) errors.push({ request, folder, error });
        else valid++;
        const code = this.withoutPlainStrings(script);
        for (const [pattern, warning] of SUSPICIOUS) {
          if (pattern.test(code)) warnings.push({ request, folder, warning: `${event.listen} script uses ${warning}` });
        }
      }
    };

    const walk = (items, folderPath) => {
      for (const item of items || []) {
        if (item.item) {
          inspect(item.event, item.name || 'folder', folderPath);
          walk(item.item, `${folderPath} > ${item.name || ''}`);
        } else {
          inspect(item.event, item.name || 'Unknown', folderPath);
        }
      }
    };

    if (collection) {
      inspect(collection.event, '(collection)', collectionName);
      walk(collection.item, collectionName);
    }
    return { total, valid, errors, warnings };
  }

  /**
   * Blank out the contents of '...' and "..." literals so text inside strings
   * (test titles, ids) is not mistaken for calls. Template literals are kept,
   * because ${...} inside them is executable code.
   */
  withoutPlainStrings(script) {
    return script.replace(/(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/g, '""');
  }

  /** Returns the syntax error message, or null when the script compiles. */
  checkSyntax(script) {
    try {
      new Function(script); // compiles only; the function is never called
      return null;
    } catch (error) {
      return error.message;
    }
  }
}
