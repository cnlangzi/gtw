import { Commander } from './Commander.js';
import { OnCommand } from './OnCommand.js';
import { NewCommand } from './NewCommand.js';
import { FixCommand } from './FixCommand.js';
import { PushCommand } from './PushCommand.js';
import { ConfirmCommand } from './ConfirmCommand.js';
import { ReviewCommand } from './ReviewCommand.js';
import { IssueCommand } from './IssueCommand.js';
import { ShowCommand } from './ShowCommand.js';
import { PollCommand } from './PollCommand.js';
import { ConfigCommand } from './ConfigCommand.js';
import { ModelCommand } from './ModelCommand.js';
import { AuthCommand } from './AuthCommand.js';
import { UpdateCommand } from './UpdateCommand.js';
import { PrCommand } from './PrCommand.js';
import { RebaseCommand } from './RebaseCommand.js';
import { WatchCommand } from './WatchCommand.js';

/**
 * CommanderFactory — creates the appropriate Commander instance for a given cmd.
 *遵循开闭原则：新增命令只需添加文件并在 MAP 中注册，无需修改现有代码。
 */
export class CommanderFactory {
  /**
   * @param {{ api: object, config: object, sessionKey: string, extractMessages: function, injectMessage: function }} context
   */
  constructor(context) {
    this.context = context;
  }

  /**
   * @param {string} cmd
   * @returns {Commander}
   */
  create(cmd) {
    const Ctor = MAP[cmd];
    if (!Ctor) {
      throw new Error(`Unknown command: ${cmd}. Use: ${Object.keys(MAP).join(', ')}`);
    }
    return new Ctor(this.context);
  }

  /**
   * @param {string} cmd
   * @returns {boolean}
   */
  canHandle(cmd) {
    return !!MAP[cmd];
  }

  static get commands() {
    return Object.keys(MAP);
  }
}

const MAP = {
  on: OnCommand,
  new: NewCommand,
  fix: FixCommand,
  push: PushCommand,
  confirm: ConfirmCommand,
  review: ReviewCommand,
  issue: IssueCommand,
  show: ShowCommand,
  poll: PollCommand,
  config: ConfigCommand,
  model: ModelCommand,
  auth: AuthCommand,
  update: UpdateCommand,
  pr: PrCommand,
  rebase: RebaseCommand,
  watch: WatchCommand,
};
