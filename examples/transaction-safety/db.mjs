import { spawn } from 'node:child_process';

const sql = {
  schema: new URL('./schema.sql', import.meta.url),
  create: new URL('./create-order.sql', import.meta.url),
  lookup: new URL('./lookup-order.sql', import.meta.url),
  stats: new URL('./stats.sql', import.meta.url),
};

/** Only a standalone demo: uses the external PostgreSQL psql client, no Node package dependencies. */
function runPsql(file, variables = {}) {
  const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) {
    if (!['request_key', 'supplier', 'amount_minor'].includes(name))
      throw new TypeError('Unexpected psql variable: ' + name);
    args.push('-v', name + '=' + String(value));
  }
  args.push('-f', file.pathname);
  return new Promise((resolve, reject) => {
    const process = spawn('psql', args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    process.on('error', reject);
    process.on('close', code => {
      if (code !== 0) {
        // PostgreSQL errors may contain user input; never log them automatically in production.
        reject(new Error('PostgreSQL demo command failed: ' + stderr.trim()));
      } else resolve(stdout.trim());
    });
  });
}
function jsonRow(output) {
  return output === '' ? null : JSON.parse(output);
}
export const initializeDemo = () => runPsql(sql.schema);
export const createPurchaseOrder = async ({ requestKey, supplier, amountMinor }) =>
  jsonRow(await runPsql(sql.create, { request_key: requestKey, supplier, amount_minor: amountMinor }));
export const lookupPurchaseOrder = async requestKey =>
  jsonRow(await runPsql(sql.lookup, { request_key: requestKey }));
export const orderStats = async requestKey =>
  jsonRow(await runPsql(sql.stats, { request_key: requestKey }));
