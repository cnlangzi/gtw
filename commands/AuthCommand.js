import { Commander } from './Commander.js';
import { getGhToken, apiRequest } from '../utils/api.js';

export class AuthCommand extends Commander {
  async execute(args) {
    try {
      const token = getGhToken();
      const user = await apiRequest('GET', '/user', token);
      return {
        ok: true,
        user: { login: user.login, name: user.name },
        token_source: 'gh-cli',
        display: `✅ Authenticated as @${user.login}${user.name ? ` (${user.name})` : ''}\n\nToken source: gh CLI`,
      };
    } catch (e) {
      throw new Error(`Auth check failed: ${e.message}`);
    }
  }
}
