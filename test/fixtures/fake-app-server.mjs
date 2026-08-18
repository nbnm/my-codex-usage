import readline from 'node:readline';

const scenario = process.argv[2] ?? 'normal';
const input = readline.createInterface({input: process.stdin});
let authorized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on('line', line => {
  if (line.trim() === '') {
    return;
  }
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return;
  }

  if (scenario === 'malformed') {
    process.stdout.write('{not-json\n');
    return;
  }
  if (scenario === 'ignore') {
    return;
  }
  if (scenario === 'terminate') {
    process.exit(17);
  }
  if (scenario === 'stderr') {
    process.stderr.write('x'.repeat(70_000));
  }
  if (scenario === 'out-of-order') {
    const delay = message.method === 'slow' ? 30 : 1;
    setTimeout(() => {
      send({id: message.id, result: {method: message.method}});
    }, delay);
    return;
  }

  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          codexHome: '/sanitized/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
          userAgent: 'fake-app-server'
        }
      });
      break;
    case 'account/read':
      if (
        (scenario === 'login-success' ||
          scenario === 'login-mismatch' ||
          scenario === 'login-failure') &&
        !authorized
      ) {
        send({
          id: message.id,
          result: {account: null, requiresOpenaiAuth: true}
        });
        break;
      }
      if (scenario === 'signed-out') {
        send({
          id: message.id,
          result: {account: null, requiresOpenaiAuth: true}
        });
        break;
      }
      if (scenario === 'api-key') {
        send({
          id: message.id,
          result: {
            account: {type: 'apiKey'},
            requiresOpenaiAuth: false
          }
        });
        break;
      }
      send({
        id: message.id,
        result: {
          account: {type: 'chatgpt', planType: 'plus'},
          requiresOpenaiAuth: true
        }
      });
      break;
    case 'account/login/start':
      if (message.params?.type !== 'chatgpt') {
        send({
          id: message.id,
          error: {code: -32602, message: 'Unsupported fixture login type'}
        });
        break;
      }
      send({
        id: message.id,
        result: {
          type: 'chatgpt',
          authUrl: 'https://example.invalid/authorize',
          loginId: 'fixture-login'
        }
      });
      setTimeout(() => {
        if (scenario === 'login-mismatch') {
          send({
            method: 'account/login/completed',
            params: {loginId: 'another-login', success: true, error: null}
          });
        }
        const success = scenario !== 'login-failure';
        authorized = success;
        send({
          method: 'account/login/completed',
          params: {
            loginId: 'fixture-login',
            success,
            error: success ? null : 'Sanitized fixture failure'
          }
        });
      }, scenario === 'login-slow' ? 100 : 5);
      break;
    case 'account/rateLimits/read':
      send({
        id: message.id,
        result: {
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            planType: 'plus',
            primary: {
              usedPercent: 28,
              windowDurationMins: 300,
              resetsAt: 1_900_000_000
            },
            secondary: null,
            rateLimitReachedType: null
          },
          rateLimitsByLimitId: null
        }
      });
      break;
    case 'account/usage/read':
      if (scenario === 'partial') {
        send({
          id: message.id,
          error: {code: -32000, message: 'Fixture usage unavailable'}
        });
        break;
      }
      send({
        id: message.id,
        result: {
          summary: {
            lifetimeTokens: 1234,
            currentStreakDays: 4,
            longestStreakDays: 13,
            peakDailyTokens: 456,
            longestRunningTurnSec: 5375
          },
          dailyUsageBuckets: [{startDate: '2026-07-24', tokens: 456}]
        }
      });
      break;
    default:
      send({
        id: message.id,
        error: {code: -32601, message: 'Method not found'}
      });
  }
});
