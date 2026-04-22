import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TimeoutError } from './ai.js';

describe('TimeoutError', () => {
  it('first attempt: correct message with timeout and attempt', () => {
    const err = new TimeoutError(60, 1);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.timeoutSeconds, 60);
    assert.strictEqual(err.attempt, 1);
    assert.strictEqual(err.message, 'LLM request timed out after 60s (attempt 1 of 2)');
  });

  it('second attempt: message shows attempt 2 of 2', () => {
    const err = new TimeoutError(30, 2);
    assert.strictEqual(err.timeoutSeconds, 30);
    assert.strictEqual(err.attempt, 2);
    assert.strictEqual(err.message, 'LLM request timed out after 30s (attempt 2 of 2)');
  });

  it('is an instance of Error', () => {
    assert(new TimeoutError(60, 1) instanceof Error);
  });

  it('attempt 1 error includes the timeout value', () => {
    const err = new TimeoutError(120, 1);
    assert.match(err.message, /120s/);
    assert.match(err.message, /attempt 1 of 2/);
  });
});

// NOTE: Full integration tests for timeout/retry behavior require a controlled HTTP server
// that hangs on request (socket destroy) or delays response beyond the timeout.
// These can be run manually with:
//
//   node --test -e "
//     const http = require('http');
//     let count = 0;
//     const srv = http.createServer((req, res) => {
//       count++;
//       if (count === 1) { req.socket.destroy(); return; }
//       res.writeHead(200, {'Content-Type':'application/json'});
//       res.end('{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}');
//     });
//     srv.listen(0, async () => {
//       const port = srv.address().port;
//       // patch findModelProviderConfig to return localhost:port
//       const ai = await import('./utils/ai.js');
//       const orig = ai.findModelProviderConfig;
//       ai.findModelProviderConfig = () => ({provider:'t',baseUrl:\`http://localhost:${port}\`,authHeader:true,api:'openai-chat'});
//       try {
//         const r = await ai.callAI('t/m','s','u','test', 1);
//         console.log('PASS:', r);
//       } catch(e) {
//         console.log('ERROR:', e.name, e.message);
//       }
//       ai.findModelProviderConfig = orig;
//       srv.close();
//     });
//   "
