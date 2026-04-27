import { Commander } from './Commander.js';
import { read, exists, makeDir } from '../utils/fs.js';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { log } from '../utils/log.js';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages, resolveRealSessionKey } from '../utils/session.js';
import { getConfig, getLangLabel, BASE_DIR } from '../utils/config.js';
import { callAI, resolveModel, parseAIResponse } from '../utils/ai.js';

export class NewCommand extends Commander {
  /**
   * @param {{ api: object, config: object }} context
   */
  constructor(context) {
    super(context);
    this.api = context.api;
    this.config = context.config;
    this.sessionKey = context.sessionKey;
  }

  async execute(args) {
    const wip = getWip();

    // Read full openclaw.json config for session.dmScope, session.identityLinks, session.mainKey
    let cfg = {};
    try {
      cfg = JSON.parse(read(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    } catch {}

    const dmScope = cfg.session?.dmScope || 'main';
    const realSessionKey = resolveRealSessionKey(this.sessionKey, dmScope, cfg);
    const { allMessages } = extractMessages(realSessionKey);

    if (!allMessages.length) {
      return {
        ok: false,
        message: "⚠️ No conversation found. Try describing what you want to create in the chat first.",
      };
    }

    // Resolve model from session (throws if missing) + gtw/config.json override
    const { model, modelProvider } = await resolveModel(realSessionKey);

    // gtw model override (set via /gtw model or /gtw config set model)
    // Resolve repo language: lang:<owner/repo> from config, default 'en'
    const repo = wip?.repo || null;
    const langKey = repo ? `lang:${repo}` : null;
    let lang = 'en';
    try {
      const gtwConfig = getConfig();
      if (gtwConfig.model) model = gtwConfig.model;
      if (langKey) lang = gtwConfig[langKey] || 'en';
    } catch {}

    // Language label for AI prompts (used in both prompt and systemPrompt below)
    const langLabel = getLangLabel(lang);

    // Clean messages: strip role prefixes and any JSON-like metadata from discussion
    const cleanMessages = allMessages.map((m) => m.text.replace(/\[(?:User|Assistant)\s*\d+\]\s*/g, '').trim()).join('\n\n');

    // Structured prompt — generates Implementation Brief (premise-driven, not rule-based)
    const prompt = `Extract from this discussion and generate an Implementation Brief.

Discussion:
${cleanMessages}

Extract:
1. Decisions already made (solution, constraints)
2. Rejected alternatives (and why)
3. Compatibility requirements
4. Verifiable acceptance conditions

Output format (strict JSON only):
{
  "title": "brief title",
  "target": "file/module to modify",
  "goal": "expected outcome",
  "context": "why this change is needed",
  "consequence": "risk or cost of not doing it",
  "decided": {
    "solution": "chosen solution (specific, not directional)",
    "reason": "why this was chosen"
  },
  "rejected": {
    "option": "rejected alternative",
    "reason": "why rejected"
  },
  "constraints": ["constraint 1", "constraint 2"],
  "outOfScope": ["explicitly not in scope"],
  "verify": ["condition 1", "condition 2"]
}
JSON：`;

    // Ensure base dir exists for session file
    makeDir(BASE_DIR, { recursive: true });

    // langLabel controls output language only; prompt is always English
    const systemPrompt = `You extract implementation decisions from a discussion and output ONLY valid JSON.
Output exactly the JSON structure described. No markdown. No explanation.
Generate all output content (title, solution, reason, constraints, etc.) in ${langLabel}.`;

    const agentId = realSessionKey?.split(':')[1] || 'main';
    let rawText;
    try {
      rawText = await callAI(model, systemPrompt, prompt, agentId);
    } catch (e) {
      return { ok: false, message: `⚠️ AI call failed: ${e.message}` };
    }

    // Parse using jsonrepair to handle malformed JSON from LLM
    let parsed;
    try {
      parsed = parseAIResponse(rawText);
    } catch (e) {
      log('[parse-fail]', JSON.stringify({ timestamp: new Date().toISOString(), model, lang, rawTextLength: rawText.length, rawText }));
      return { ok: false, message: `⚠️ AI didn't return valid JSON: ${e.message}\n\nRaw (${rawText.length} chars): ${rawText.slice(0, 200)}` };
    }

    const title = parsed.title || '';
    // Build structured markdown body for AI readability and GitHub issue
    const body = [
      parsed.context ? `## Context\n${parsed.context}` : '',
      parsed.goal ? `## Goal\n${parsed.goal}` : '',
      parsed.target ? `## Target\n${parsed.target}` : '',
      parsed.consequence ? `## Consequence\n${parsed.consequence}` : '',
      parsed.decided?.solution ? `## Decided Solution\n${parsed.decided.solution}\n\n**Reason:** ${parsed.decided.reason || 'N/A'}` : '',
      parsed.rejected?.option ? `## Rejected Alternative\n**Option:** ${parsed.rejected.option}\n**Reason:** ${parsed.rejected.reason || 'N/A'}` : '',
      parsed.constraints?.length ? `## Constraints\n${parsed.constraints.map(c => `- ${c}`).join('\n')}` : '',
      parsed.outOfScope?.length ? `## Out of Scope\n${parsed.outOfScope.map(s => `- ${s}`).join('\n')}` : '',
      parsed.verify?.length ? `## Verification\n${parsed.verify.map(v => `- ${v}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');

    const updated = {
      ...wip,
      issue: {
        action: 'create',
        id: null,
        title,
        body,
      },
      updatedAt: new Date().toISOString(),
    };
    saveWip(updated);

    return {
      ok: true,
      wip: updated,
      message: `Issue draft generated: "${title}"`,
      display: `Draft saved:\n\nTitle: ${title}\n\nBody:\n${body}\n\nRun /gtw confirm to create the issue.`,
    };
  }
}
