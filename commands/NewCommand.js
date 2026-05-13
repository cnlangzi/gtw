import { Commander } from './Commander.js';
import { makeDir } from '../utils/fs.js';
import { log } from '../utils/log.js';
import { getWip, saveWip } from '../utils/wip.js';
import { extractMessages } from '../utils/session.js';
import { getConfig, getLangLabel, BASE_DIR } from '../utils/config.js';
import { callAI, resolveModel, parseAIResponse } from '../utils/ai.js';

export class NewCommand extends Commander {
  async execute(args) {
    const wip = getWip();

    const { allMessages } = extractMessages(this.sessionFile);

    if (!allMessages.length) {
      return {
        ok: false,
        message: "⚠️ No conversation found. Try describing what you want to create in the chat first.",
      };
    }

    // Resolve model from session (throws if missing) + gtw/config.json override
    const { model, modelProvider } = await resolveModel(this.sessionKey, this.api);

    // gtw model override (set via /gtw model or /gtw config set model)
    const repo = wip?.repo || null;
    const langKey = repo ? `lang:${repo}` : null;
    let lang = 'en';
    try {
      const gtwConfig = getConfig();
      if (gtwConfig.model) model = gtwConfig.model;
      if (langKey) lang = gtwConfig[langKey] || 'en';
    } catch {}

    const langLabel = getLangLabel(lang);

    const cleanMessages = allMessages.map((m) => m.text.replace(/\[(?:User|Assistant)\s*\d+\]\s*/g, '').trim()).join('\n\n');

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

    makeDir(BASE_DIR, { recursive: true });

    const systemPrompt = `You extract implementation decisions from a discussion and output ONLY valid JSON.
Output exactly the JSON structure described. No markdown. No explanation.
Generate all output content (title, solution, reason, constraints, etc.) in ${langLabel}.`;

    let rawText;
    try {
      rawText = await callAI(model, systemPrompt, prompt, this.sessionKey, this.api);
    } catch (e) {
      return { ok: false, message: `⚠️ AI call failed: ${e.message}` };
    }

    let parsed;
    try {
      parsed = parseAIResponse(rawText);
    } catch (e) {
      log('[parse-fail]', JSON.stringify({ timestamp: new Date().toISOString(), model, lang, rawTextLength: rawText.length, rawText }));
      return { ok: false, message: `⚠️ AI didn't return valid JSON: ${e.message}\n\nRaw (${rawText.length} chars): ${rawText.slice(0, 200)}` };
    }

    const title = parsed.title || '';
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