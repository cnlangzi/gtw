import { Commander } from './Commander.js';
import { getWip, saveWip } from '../utils/wip.js';

export class UpdateCommand extends Commander {
  async execute(args) {
    const id = parseInt(args[0], 10);
    if (isNaN(id)) throw new Error('Usage: /gtw update #<id> [title] [body...]');
    const wip = getWip();
    if (!wip.repo) throw new Error('No repo set. Run /gtw on <workdir> first');

    const rest = args.slice(1).join(' ');
    const updated = {
      ...wip,
      issue: { action: 'update', id, title: rest, body: '' },
      updatedAt: new Date().toISOString(),
    };
    saveWip(updated);
    return {
      ok: true,
      wip: updated,
      message: `Issue #${id} update draft saved`,
      display: `📝 Issue #${id} update draft saved`,
    };
  }
}
