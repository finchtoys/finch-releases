#!/usr/bin/env node
/**
 * Offline smoke test: stub `fetch`, activate the mini tool against a fake ctx,
 * then exercise the evaluate / models / configure paths.
 *
 * Run with: node scripts/smoke.mjs   (after `npm run build`)
 */
import { activate } from '../dist/index.js';

let tool = null;
let settingsMenuProvider = null;
const calls = [];
const secrets = new Map();
const storage = new Map();

const ctx = {
  subscriptions: { push: () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  secrets: {
    get: async (key) => secrets.get(key),
    set: async (key, value) => { secrets.set(key, value); },
    delete: async (key) => { secrets.delete(key); },
  },
  storage: {
    get: async (key) => storage.get(key),
    set: async (key, value) => { storage.set(key, value); },
    delete: async (key) => { storage.delete(key); },
  },
  i18n: { t: (key, values) => (values ? `${key}(${JSON.stringify(values)})` : key), locale: 'zh-CN' },
  tools: { register: (definition) => { tool = definition; return { dispose() {} }; } },
  settingsMenu: {
    register: (provider) => {
      settingsMenuProvider = provider;
      return { dispose() {}, notifyUpdate() {} };
    },
  },
  ui: {
    showModalDialog: async () => ({ action: 'dismissed' }),
    showToast: async () => ({ action: 'dismissed' }),
  },
};

globalThis.fetch = async (url, init) => {
  const target = String(url);
  calls.push({ url: target, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });

  if (target === 'https://openrouter.ai/api/v1/models') {
    // OpenRouter keeps the Decisions models out of its public list.
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5', name: 'GPT-5' }] }), { status: 200 });
  }
  if (target.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'jev-1.13.0', description: 'Flagship', release_date: '2026-08-01' }] }), { status: 200 });
  }
  if (target === 'https://openrouter.ai/api/alpha/decisions') {
    return new Response(JSON.stringify({
      id: 'gen-dec-1',
      model: 'typesafe/jev-1.13-20260917',
      provider: 'TypeSafe',
      answers: { urgency: { type: 'noul', noul: 0.92 } },
      usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 70 },
    }), { status: 200 });
  }
  return new Response(JSON.stringify({
    model: 'jev-latest',
    answers: {
      urgency: { type: 'noul', noul: 0.999 },
      department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.84, technical: 0.159 }, confidence: 0.596 },
      frustration: { type: 'score', score: 1.035, legend: { 0: 'Calm', 1: 'Frustrated' }, confidence: 0.842 },
    },
    usage: { input_tokens: 312, output_tokens: 48 },
  }), { status: 200 });
};

function makeExec(formResult = { submitted: true, values: { apiKey: 'ts_smoke_key' } }) {
  return {
    toolCallId: 'call-1',
    sessionId: 'session-1',
    spaceId: undefined,
    cwd: '/tmp',
    logger: ctx.logger,
    storage: {},
    secrets: ctx.secrets,
    progress: { report() {} },
    ui: { requestForm: async () => formResult },
  };
}

function check(label, condition, extra = '') {
  if (!condition) {
    console.error(`✗ ${label}${extra ? ` — ${extra}` : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${label}`);
}

activate(ctx);
check('tool registered', tool?.name === 'finch_jev_evaluate', tool?.name);
// `risk: "high"` makes Finch confirm on every single call, even in act mode.
check('risk stays out of high', tool?.risk !== 'high', String(tool?.risk));

// 1. evaluate with a missing API key → form collected + stored, then the call runs.
const evaluated = await tool.execute(
  {
    action: 'evaluate',
    state: 'Hi, my Stripe connection has been failing for 3 days.',
    questions: {
      urgency: { type: 'noul', instructions: 'Is this urgent?' },
      department: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'payments', technical: 'bugs' } },
      frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Frustrated', 'Angry'] },
      broken: { type: 'noul', instructions: 'Ignored criteria', criteria: ['x', 'y'] },
    },
  },
  makeExec(),
);
check('evaluate succeeded', evaluated.isError !== true, JSON.stringify(evaluated.content[0].text));
check('key stored from form', secrets.get('apiKey') === 'ts_smoke_key');
check('state + questions sent', calls.at(-1).url === 'https://api.typesafe.ai/v1/systemone');
check('noul criteria stripped', calls.at(-1).body.questions.broken.criteria === undefined);
check('model default applied', calls.at(-1).body.model === 'jev-latest');
const rendered = evaluated.content[0].text;
check('noul rendered', rendered.includes('urgency (noul): 0.999'));
check('choice rendered sorted', rendered.includes('billing 0.840 · technical 0.159'));
check('score + legend rendered', rendered.includes('frustration (score): 1.035') && rendered.includes('0 = Calm'));
check('confidence rendered', rendered.includes('confidence 0.596'));

// 2. models action
const models = await tool.execute({ action: 'models' }, makeExec());
check('models listed', models.content[0].text.includes('jev-1.13.0'), models.content[0].text);

// 3. OpenRouter provider — same contract, different endpoint and slug.
const viaOpenRouter = await tool.execute(
  {
    action: 'evaluate',
    provider: 'openrouter',
    state: 'Still broken.',
    questions: { urgency: { type: 'noul', instructions: 'Is this urgent?' } },
  },
  makeExec(),
);
check(
  'openrouter endpoint used',
  calls.at(-1).url === 'https://openrouter.ai/api/alpha/decisions',
  calls.at(-1).url,
);
check('openrouter default slug', calls.at(-1).body.model === 'typesafe/jev-1.13', calls.at(-1).body.model);
check('openrouter key stored separately', secrets.get('openrouterApiKey') === 'ts_smoke_key');
check('openrouter answer rendered', viaOpenRouter.content[0].text.includes('urgency (noul): 0.920'));
check('provider + cost in header', viaOpenRouter.content[0].text.includes('TypeSafe · typesafe/jev-1.13-20260917'));
check('cost rendered', viaOpenRouter.content[0].text.includes('$0.000020'));

const routerModels = await tool.execute({ action: 'models', provider: 'openrouter' }, makeExec());
check(
  'openrouter models explains the alpha router',
  routerModels.content[0].text.includes('~typesafe/jev-latest') &&
    routerModels.content[0].text.includes('typesafe/jev-1.13'),
  routerModels.content[0].text,
);

// 4. auto resolution: without an explicit provider, the key that exists wins.
secrets.delete('apiKey');
const autoPicked = await tool.execute(
  { action: 'evaluate', state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } },
  makeExec(),
);
check(
  'auto falls back to the provider holding a key',
  calls.at(-1).url === 'https://openrouter.ai/api/alpha/decisions',
  calls.at(-1).url,
);
check('auto call succeeded', autoPicked.isError !== true);

// 5. validation failures
const badType = await tool.execute({ action: 'evaluate', state: 'x', questions: { q: { type: 'wat', instructions: 'y' } } }, makeExec());
check('invalid type rejected', badType.isError === true && badType.content[0].text.includes('choice, score or noul'));
const noState = await tool.execute({ action: 'evaluate', questions: { q: { type: 'noul', instructions: 'y' } } }, makeExec());
check('missing state rejected', noState.isError === true);
const noOptions = await tool.execute(
  { action: 'evaluate', state: 'x', questions: { q: { type: 'choice', instructions: 'y', criteria: { only: 'one' } } } },
  makeExec(),
);
check('single-option choice rejected', noOptions.isError === true);
const unknown = await tool.execute({ action: 'nope' }, makeExec());
check('unknown action rejected', unknown.isError === true);

// 6. Settings menu: only the provider in use is listed; switching sits one level down.
// Deterministic starting point: one provider has a key, nothing is selected yet.
secrets.clear();
secrets.set('apiKey', 'ts_smoke_key');
const menu = await settingsMenuProvider.getMenu();
const labels = menu.map((item) => item.label ?? '');
check(
  'menu lists only the active provider',
  labels.some((label) => label.startsWith('TypeSafe —')) && !labels.some((label) => label.startsWith('OpenRouter —')),
  JSON.stringify(labels),
);
check(
  'menu has exactly one provider action set',
  ['set', 'test', 'clear'].every((id) => menu.filter((item) => item.id === id).length === 1),
  menu.map((item) => item.id).join(','),
);
const switchItem = menu.find((item) => item.id === 'switch');
check('switch is a submenu', Array.isArray(switchItem?.children) && switchItem.children.length === 2);
check(
  'submenu marks the active provider',
  switchItem?.children?.find((child) => child.id === 'use:official')?.current === true &&
    switchItem?.children?.find((child) => child.id === 'use:openrouter')?.current !== true,
);

// The menu selection must win over key availability, and OpenRouter needs its own key.
await settingsMenuProvider.execute({}, 'use:openrouter');
const afterSwitch = await settingsMenuProvider.getMenu();
check(
  'menu follows the switch',
  afterSwitch.map((item) => item.label).some((label) => label.startsWith('OpenRouter —')) &&
    !afterSwitch.map((item) => item.label).some((label) => label.startsWith('TypeSafe —')),
  JSON.stringify(afterSwitch.map((item) => item.label)),
);
await tool.execute({ action: 'evaluate', state: 'x', questions: { q: { type: 'noul', instructions: 'y' } } }, makeExec());
check(
  'the selected provider wins over key availability',
  calls.at(-1).url === 'https://openrouter.ai/api/alpha/decisions',
  calls.at(-1).url,
);

console.log('\nRequests:', calls.map((call) => `${call.method} ${call.url}`).join(', '));
