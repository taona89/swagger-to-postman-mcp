/**
 * Validates that all generated Postman test scripts have valid JavaScript syntax.
 * Uses Function constructor to parse without executing.
 */

export class ScriptChecker {
  /**
   * @param {object} positiveCollection - Postman positive collection JSON
   * @param {object} negativeCollection - Postman negative collection JSON
   * @returns {{ total: number, valid: number, errors: Array<{ request: string, folder: string, error: string }> }}
   */
  check(positiveCollection, negativeCollection) {
    const positiveResults = this.checkCollection(positiveCollection, 'Positive');
    const negativeResults = this.checkCollection(negativeCollection, 'Negative');

    const total = positiveResults.total + negativeResults.total;
    const valid = positiveResults.valid + negativeResults.valid;
    const errors = [...positiveResults.errors, ...negativeResults.errors];

    return { total, valid, errors };
  }

  /**
   * Check all scripts in a single collection.
   */
  checkCollection(collection, collectionName) {
    let total = 0;
    let valid = 0;
    const errors = [];

    const walk = (items, folderPath = '') => {
      if (!items) return;
      for (const item of items) {
        if (item.item) {
          // Folder
          walk(item.item, item.name || folderPath);
        } else if (item.event) {
          // Request with scripts
          for (const event of item.event) {
            if (event.script && event.script.exec) {
              total++;
              const scriptLines = Array.isArray(event.script.exec)
                ? event.script.exec
                : [event.script.exec];
              const script = scriptLines.join('\n');

              const error = this.checkSyntax(script);
              if (error) {
                errors.push({
                  request: item.name || 'Unknown',
                  folder: `${collectionName} > ${folderPath}`,
                  error,
                });
              } else {
                valid++;
              }
            }
          }
        }
      }
    };

    walk(collection.item);
    return { total, valid, errors };
  }

  /**
   * Check JavaScript syntax without executing.
   * Returns error message string, or null if valid.
   */
  checkSyntax(script) {
    try {
      // Function constructor parses but does not execute
      new Function(script);
      return null;
    } catch (e) {
      return e.message;
    }
  }
}
