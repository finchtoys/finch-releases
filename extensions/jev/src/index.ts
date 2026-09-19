/**
 * finch-jev — call Jev (TypeSafe AI System One) from Finch.
 *
 * Jev is not a chat model: you send one `state` plus typed questions and get back
 * calibrated answers (choice / score / noul) with probabilities and confidence.
 * Two interchangeable providers serve the same contract:
 *   • TypeSafe official  POST https://api.typesafe.ai/v1/systemone
 *   • OpenRouter         POST https://openrouter.ai/api/alpha/decisions
 * See https://docs.typesafe.ai/api
 */
import type * as finch from 'finch';

type ProviderId = 'official' | 'openrouter';

interface ProviderSpec {
  readonly id: ProviderId;
  /** Shown in menu rows, forms and error messages. */
  readonly label: string;
  readonly baseUrl: string;
  readonly evaluatePath: string;
  /** `undefined` when the provider exposes no list endpoint for decisions models. */
  readonly modelsPath: string | undefined;
  /** Key in `ctx.secrets` (declared in manifest `permissions.secrets`). */
  readonly secretKey: string;
  readonly defaultModel: string;
  /** Where the user gets a key. */
  readonly consoleUrl: string;
  readonly keyPlaceholder: string;
}

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  official: {
    id: 'official',
    label: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai/v1',
    evaluatePath: '/systemone',
    modelsPath: '/models',
    secretKey: 'apiKey',
    defaultModel: 'jev-latest',
    consoleUrl: 'https://console.typesafe.ai',
    keyPlaceholder: 'ts_...',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    // The Decisions router is the only surface that carries typed questions; the
    // ordinary OpenAI-compatible /chat/completions route would lose the contract.
    evaluatePath: '/alpha/decisions',
    modelsPath: undefined,
    secretKey: 'openrouterApiKey',
    // `~typesafe/jev-latest` is an alias that always follows the newest Jev.
    defaultModel: 'typesafe/jev-1.13',
    consoleUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-v1-...',
  },
};

const PROVIDER_IDS: readonly ProviderId[] = ['official', 'openrouter'];
/** Slugs OpenRouter serves on the Decisions router, for `models` when its list omits them. */
const OPENROUTER_DECISION_SLUGS = ['typesafe/jev-1.13', '~typesafe/jev-latest'];

/** Storage key holding the provider picked from the settings menu. */
const STORAGE_PROVIDER = 'provider';
const DOCS_URL = 'https://docs.typesafe.ai/introduction/quickstart';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_QUESTIONS = 32;
const MAX_STATE_CHARS = 200_000;

type Dict = Record<string, unknown>;

function isProviderId(value: string): value is ProviderId {
  return value === 'official' || value === 'openrouter';
}

/** Raised for anything the user (or the model) can act on: bad input, auth, HTTP, network. */
class TypeSafeError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function asRecord(value: unknown): Dict | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fixed(value: number): string {
  return value.toFixed(3);
}

/** Pull a human-readable message out of an error body without assuming a schema. */
function extractApiMessage(payload: unknown): string {
  const record = asRecord(payload);
  if (!record) return '';
  const candidates = [
    record.message,
    record.error,
    record.detail,
    asRecord(record.error)?.message,
    Array.isArray(record.errors) ? record.errors[0] : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 300);
  }
  return '';
}

function describeHttpFailure(spec: ProviderSpec, status: number, payload: unknown): string {
  const message = extractApiMessage(payload);
  const detail = message ? `: ${message}` : '';
  if (status === 401 || status === 403) {
    return `${spec.label} rejected the API key (HTTP ${status})${detail}. Update it from the mini tool's settings menu: ${spec.consoleUrl}`;
  }
  if (status === 402) {
    return `${spec.label} has no credits left (HTTP 402)${detail}. Top up the account, then retry.`;
  }
  if (status === 422) {
    return `${spec.label} rejected the request body (HTTP 422)${detail}. Check every question's type, instructions and criteria.`;
  }
  if (status === 429) return `${spec.label} rate limit reached (HTTP 429)${detail}. Wait a few seconds, then retry.`;
  if (status === 529) return `${spec.label} is overloaded (HTTP 529)${detail}. Retry shortly.`;
  if (status >= 500) return `${spec.label} server error (HTTP ${status})${detail}. Retry shortly.`;
  return `${spec.label} request failed (HTTP ${status})${detail}.`;
}

function providerHost(spec: ProviderSpec): string {
  return spec.baseUrl.replace(/^https?:\/\//, '').split('/')[0] ?? spec.baseUrl;
}

function textResult(text: string): finch.ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): finch.ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * One JSON request to the selected provider. Honors both the mini tool's own
 * timeout and the caller's abort signal, and never surfaces the API key in an
 * error message.
 */
async function requestJson(
  spec: ProviderSpec,
  apiKey: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(`${spec.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) throw new TypeSafeError(describeHttpFailure(spec, response.status, payload), response.status);
    if (payload === undefined) throw new TypeSafeError(`${spec.label} returned an empty response body.`);
    return payload;
  } catch (error) {
    if (error instanceof TypeSafeError) throw error;
    if ((error as { name?: string } | undefined)?.name === 'AbortError') {
      throw new TypeSafeError(`${spec.label} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new TypeSafeError(
      `Could not reach ${providerHost(spec)} (${errorText(error)}). Check the network or proxy, then retry.`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Validate and normalize the model-supplied `questions` map into the wire shape
 * TypeSafe expects. Failures are user-actionable, so they are thrown as
 * TypeSafeError with a message the model can act on.
 */
function normalizeQuestions(raw: unknown): Dict {
  const source = asRecord(raw);
  if (!source) {
    throw new TypeSafeError('`questions` must be an object mapping a question id to its definition.');
  }
  const entries = Object.entries(source);
  if (entries.length === 0) throw new TypeSafeError('`questions` needs at least one question.');
  if (entries.length > MAX_QUESTIONS) {
    throw new TypeSafeError(`Too many questions (${entries.length}); send at most ${MAX_QUESTIONS} per call.`);
  }

  const output: Dict = {};
  for (const [id, value] of entries) {
    const question = asRecord(value);
    if (!question) throw new TypeSafeError(`Question "${id}" must be an object.`);
    const type = readString(question.type);
    if (type !== 'choice' && type !== 'score' && type !== 'noul') {
      throw new TypeSafeError(`Question "${id}" has type "${type || '(missing)'}"; use choice, score or noul.`);
    }
    const instructions = readString(question.instructions);
    if (!instructions) throw new TypeSafeError(`Question "${id}" needs a non-empty \`instructions\` string.`);

    const normalized: Dict = { type, instructions };
    const criteria = question.criteria;
    if (type === 'choice') {
      const options = asRecord(criteria);
      if (!options) {
        throw new TypeSafeError(
          `Choice question "${id}" needs \`criteria\` as an object mapping each option id to its description.`,
        );
      }
      if (Object.keys(options).length < 2) {
        throw new TypeSafeError(`Choice question "${id}" needs at least two options in \`criteria\`.`);
      }
      normalized.criteria = options;
    } else if (type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        throw new TypeSafeError(`Score question "${id}" needs \`criteria\` as an array of at least two levels.`);
      }
      normalized.criteria = criteria.map((level) => (typeof level === 'number' ? level : String(level)));
    }
    output[id] = normalized;
  }
  return output;
}

function renderProbabilities(probabilities: unknown): string[] {
  const record = asRecord(probabilities);
  if (!record) return [];
  return Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => right[1] - left[1])
    .map(([option, value]) => `${option} ${fixed(value)}`);
}

function renderLegend(legend: unknown): string[] {
  const record = asRecord(legend);
  if (!record) return [];
  return Object.entries(record).map(([level, label]) => `${level} = ${String(label)}`);
}

/** Human-readable rendering of one answer, per TypeSafe answer type. */
function renderAnswer(id: string, answer: Dict): string[] {
  const type = readString(answer.type);
  const confidence = readNumber(answer.confidence);
  const confidenceText = confidence === undefined ? '' : `, confidence ${fixed(confidence)}`;
  const lines: string[] = [];

  if (type === 'choice') {
    const choice = readString(answer.choice);
    lines.push(`${id} (choice): ${choice || '(no choice returned)'}${confidenceText}`);
    const probabilities = renderProbabilities(answer.probabilities);
    if (probabilities.length) lines.push(`  probabilities — ${probabilities.join(' · ')}`);
    return lines;
  }
  if (type === 'score') {
    const score = readNumber(answer.score);
    lines.push(`${id} (score): ${score === undefined ? '(no score returned)' : fixed(score)}${confidenceText}`);
    const legend = renderLegend(answer.legend);
    if (legend.length) lines.push(`  scale — ${legend.join(' · ')}`);
    const probabilities = renderProbabilities(answer.probabilities);
    if (probabilities.length) lines.push(`  probabilities — ${probabilities.join(' · ')}`);
    return lines;
  }
  if (type === 'noul') {
    const value = readNumber(answer.noul);
    lines.push(`${id} (noul): ${value === undefined ? '(no value returned)' : fixed(value)}`);
    return lines;
  }
  lines.push(`${id}: ${JSON.stringify(answer)}`);
  return lines;
}

/** Full tool output for one evaluation: a readable digest plus the raw JSON payload. */
function renderEvaluation(payload: Dict, requestedIds: readonly string[]): string {
  const provider = readString(payload.provider);
  const model = readString(payload.model) || 'Jev';
  const answers = asRecord(payload.answers) ?? {};
  const returnedIds = Object.keys(answers);
  const usage = asRecord(payload.usage);
  const inputTokens = usage ? readNumber(usage.input_tokens) : undefined;
  const outputTokens = usage ? readNumber(usage.output_tokens) : undefined;
  const cost = usage ? readNumber(usage.cost) : undefined;
  const tokensText = [
    inputTokens === undefined ? '' : `${inputTokens} in`,
    outputTokens === undefined ? '' : `${outputTokens} out`,
  ]
    .filter(Boolean)
    .join(' / ');
  const usageText = [
    tokensText ? `${tokensText} tokens` : '',
    cost === undefined ? '' : `$${cost.toFixed(6)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const blocks: string[] = [
    `${provider ? `${provider} · ` : ''}${model}${usageText ? ` · ${usageText}` : ''}`,
  ];
  for (const id of returnedIds) {
    const answer = asRecord(answers[id]);
    blocks.push(answer ? renderAnswer(id, answer).join('\n') : `${id}: ${JSON.stringify(answers[id])}`);
  }
  const missing = requestedIds.filter((id) => !returnedIds.includes(id));
  if (missing.length) blocks.push(`No answer returned for: ${missing.join(', ')}`);
  blocks.push(`Raw response:\n${JSON.stringify(payload, null, 2)}`);
  return blocks.join('\n\n');
}

/** `GET /v1/models` returns a list; accept the common envelope shapes. */
function extractModelList(payload: unknown): Dict[] {
  const record = asRecord(payload);
  if (!record) return Array.isArray(payload) ? payload.filter((entry): entry is Dict => Boolean(asRecord(entry))) : [];
  for (const key of ['data', 'models', 'items', 'results']) {
    const value = record[key];
    if (Array.isArray(value)) return value.filter((entry): entry is Dict => Boolean(asRecord(entry)));
  }
  return [];
}

function renderModels(spec: ProviderSpec, payload: unknown): string {
  const models = extractModelList(payload).filter((model) => {
    const id = readString(model.id) || readString(model.name);
    return spec.id === 'openrouter' ? id.includes('typesafe') : true;
  });
  if (models.length === 0) {
    // OpenRouter keeps the Decisions models out of its public model list.
    const slugs = OPENROUTER_DECISION_SLUGS.map((slug) => `- ${slug}`).join('\n');
    return [
      `${spec.label} does not publish the Jev entries in \`GET /api/v1/models\`; they are served by the alpha Decisions router.`,
      `Pass either slug as \`model\` (default ${spec.defaultModel}):`,
      slugs,
    ].join('\n');
  }
  const lines = models.map((model) => {
    const id = readString(model.id) || readString(model.name) || '(unnamed model)';
    const description = readString(model.description);
    const releaseDate = readString(model.release_date) || readString(model.released_at);
    return [`- ${id}`, description, releaseDate ? `released ${releaseDate}` : ''].filter(Boolean).join(' — ');
  });
  return `Models available to this account (pass one as \`model\`, default ${spec.defaultModel}):\n${lines.join('\n')}`;
}

type Translate = (key: string, values?: Record<string, string | number | boolean>) => string;

const API_KEY_FIELD_KEY = 'apiKey';

function apiKeyFields(t: Translate, spec: ProviderSpec): finch.MiniToolFormField[] {
  return [
    {
      key: API_KEY_FIELD_KEY,
      label: t('form.apiKeyLabel'),
      type: 'password',
      secret: true,
      required: true,
      placeholder: spec.keyPlaceholder,
      width: '2/3',
    },
    {
      key: 'console',
      label: t('form.getKey', { provider: spec.label }),
      type: 'link',
      href: spec.consoleUrl,
      width: '1/3',
    },
  ];
}

function readApiKeyValue(values: Readonly<Record<string, string | number | boolean | string[]>> | undefined): string {
  const value = values?.[API_KEY_FIELD_KEY];
  return typeof value === 'string' ? value.trim() : '';
}

/** Short non-reversible hint so the user can tell which key is stored. */
function keyHint(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/**
 * Pick the provider for this call: an explicit `provider` argument wins, then the
 * provider selected in the mini tool's settings menu, then whichever provider has
 * a key stored, then official.
 */
async function resolveProvider(ctx: finch.MiniToolContext, requested: string): Promise<ProviderSpec> {
  const wanted = readString(requested);
  if (isProviderId(wanted)) return PROVIDERS[wanted];

  const stored = readString(await ctx.storage.get(STORAGE_PROVIDER));
  if (isProviderId(stored)) return PROVIDERS[stored];

  const withKey: ProviderId[] = [];
  for (const id of PROVIDER_IDS) {
    if (await ctx.secrets.get(PROVIDERS[id].secretKey)) withKey.push(id);
  }
  if (withKey.length === 1) return PROVIDERS[withKey[0] as ProviderId];
  return PROVIDERS.official;
}

/**
 * Return the provider's stored key, asking for it with a secure form when missing.
 * Called from a tool call, where a form card in the waiting area is available.
 */
async function ensureApiKey(
  ctx: finch.MiniToolContext,
  exec: finch.ToolExecutionContext,
  t: Translate,
  spec: ProviderSpec,
): Promise<string | undefined> {
  const stored = await ctx.secrets.get(spec.secretKey);
  if (stored) return stored;

  const result = await exec.ui.requestForm({
    title: t('form.title', { provider: spec.label }),
    description: t('form.description', { provider: spec.label }),
    submitLabel: t('form.submit'),
    cancelLabel: t('form.cancel'),
    fields: apiKeyFields(t, spec),
    timeoutMs: 5 * 60_000,
  });
  const value = readApiKeyValue(result.values);
  if (!result.submitted || !value) {
    exec.logger.info(`${spec.id} key form dismissed (${result.reason ?? 'cancelled'})`);
    return undefined;
  }
  await ctx.secrets.set(spec.secretKey, value);
  exec.logger.info(`${spec.id} key stored`);
  return value;
}

export function activate(ctx: finch.MiniToolContext): void {
  const t: Translate = (key, values) => ctx.i18n.t(key, values);

  // ── Agent tool ─────────────────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.tools.register({
      name: 'finch_jev_evaluate',
      title: t('tool.title'),
      description: `Evaluate text against structured questions with Jev (TypeSafe AI System One), a calibrated evaluation model — not a chat model.
action:
  evaluate  — send one \`state\` plus \`questions\` and get typed answers with probabilities and confidence. Use for classification, routing, scoring, sentiment/urgency detection or any decision that should come back as data instead of prose.
  models    — list the models the selected provider accepts in \`model\` (also verifies the stored API key).
  configure — ask the user for the selected provider's API key with a secure form (only needed when the key is missing or invalid).
provider:
  auto (default) — the provider selected in the mini tool's settings menu, else whichever provider has a key stored
  official       — TypeSafe's own API
  openrouter     — OpenRouter's alpha Decisions router, which serves the same Jev contract
Question types for \`questions\` values: \`choice\` (pick one option, needs \`criteria\` as an object of option id → description), \`score\` (a value on a leveled scale, needs \`criteria\` as an array of at least two level labels), \`noul\` (probability between 0 and 1 for yes/no questions, no \`criteria\`).
The whole \`state\` is read once and every question is evaluated in parallel, so prefer one call with many questions over repeated calls. Answers are data, not opinions: report the returned values, probabilities and confidence instead of re-deriving them.`,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['evaluate', 'models', 'configure'],
            description: 'evaluate (default) runs the questions; models lists available models; configure stores the API key.',
          },
          provider: {
            type: 'string',
            enum: ['auto', 'official', 'openrouter'],
            description:
              "Which provider serves the call: official (TypeSafe's own API), openrouter (OpenRouter Decisions router), or auto (default) — the provider selected in the settings menu, else whichever provider has a key stored.",
          },
          state: {
            type: 'string',
            description: 'The text to evaluate — one message, record, ticket, transcript or other material. Required for action=evaluate.',
            maxLength: MAX_STATE_CHARS,
          },
          questions: {
            type: 'object',
            description:
              'Map of question id → { type, instructions, criteria }. Ids are echoed back in the answer, so use short stable ids such as "urgency".',
            additionalProperties: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['choice', 'score', 'noul'], description: 'Answer type to return.' },
                instructions: { type: 'string', description: 'What the question asks, phrased as a single clear instruction.' },
                criteria: {
                  description:
                    'choice: object mapping option id → description (at least two). score: array of level labels from lowest to highest (at least two). noul: omit.',
                },
              },
              required: ['type', 'instructions'],
            },
          },
          model: {
            type: 'string',
            description:
              "Model that handles the request. Defaults to the selected provider's current Jev slug; use action=models to check what the account accepts.",
          },
        },
        required: ['action'],
      },
      // Read-only judgment over an external API. Deliberately NOT `high`: Finch
      // short-circuits `risk: "high"` into "confirm on every single call"
      // (permission-decision.ts), which would gate each evaluation even in act
      // mode. `medium` because action=configure does write the API key to secure
      // storage.
      risk: 'medium',
      defaultEnabled: true,
      timeoutMs: REQUEST_TIMEOUT_MS + 15_000,
      async execute(input, exec): Promise<finch.ToolResult> {
        const action = readString(input.action) || 'evaluate';
        const spec = await resolveProvider(ctx, readString(input.provider));
        try {
          if (action === 'configure') {
            const result = await exec.ui.requestForm({
              title: t('form.title', { provider: spec.label }),
              description: t('form.description', { provider: spec.label }),
              submitLabel: t('form.submit'),
              cancelLabel: t('form.cancel'),
              fields: apiKeyFields(t, spec),
              timeoutMs: 5 * 60_000,
            });
            const value = readApiKeyValue(result.values);
            if (!result.submitted || !value) return textResult('The user dismissed the form; no API key was stored.');
            await ctx.secrets.set(spec.secretKey, value);
            return textResult(`${spec.label} API key stored in the mini tool secure storage.`);
          }

          const apiKey = await ensureApiKey(ctx, exec, t, spec);
          if (!apiKey) {
            return errorResult(
              `No ${spec.label} API key is stored. Ask the user to run action=configure with provider=${spec.id} (or use the mini tool's settings menu), then retry. Setup: ${DOCS_URL}`,
            );
          }

          if (action === 'models') {
            const payload = await requestJson(
              spec,
              apiKey,
              spec.modelsPath ?? '/v1/models',
              { method: 'GET' },
              exec.signal,
            );
            exec.logger.info(`${spec.id}: listed models`);
            return textResult(renderModels(spec, payload));
          }

          if (action !== 'evaluate') {
            return errorResult(`Unknown action "${action}". Use evaluate, models or configure.`);
          }

          const state = typeof input.state === 'string' ? input.state : '';
          if (!state.trim()) return errorResult('action=evaluate requires `state` — the text to evaluate.');
          if (state.length > MAX_STATE_CHARS) {
            return errorResult(`\`state\` is ${state.length} characters; shorten it to at most ${MAX_STATE_CHARS}.`);
          }
          const questions = normalizeQuestions(input.questions);
          const model = readString(input.model) || spec.defaultModel;
          const questionIds = Object.keys(questions);

          const payload = asRecord(
            await requestJson(
              spec,
              apiKey,
              spec.evaluatePath,
              { method: 'POST', body: { state, model, questions } },
              exec.signal,
            ),
          );
          if (!payload) return errorResult(`${spec.label} returned an unexpected response payload.`);

          // Metadata only — never log the evaluated text or the answers.
          exec.logger.info(
            `${spec.id}: evaluated ${questionIds.length} question(s) with ${model} (answers=${Object.keys(asRecord(payload.answers) ?? {}).length})`,
          );
          return textResult(renderEvaluation(payload, questionIds));
        } catch (error) {
          if (error instanceof TypeSafeError) {
            exec.logger.warn(`${spec.id} request failed: ${error.message}`);
            return errorResult(error.message);
          }
          exec.logger.error(`unexpected failure: ${errorText(error)}`);
          return errorResult(`${spec.label} call failed: ${errorText(error)}`);
        }
      },
    }),
  );

  // ── Settings menu (Toolcase card + session container header) ───────────────
  // Only the provider currently in use occupies the menu; switching lives one
  // level down, so the two providers are never listed side by side.
  ctx.subscriptions.push(
    ctx.settingsMenu.register({
      async getMenu(): Promise<finch.ComposerActionMenuItem[]> {
        const active = await resolveProvider(ctx, '');
        const stored = await ctx.secrets.get(active.secretKey);
        return [
          {
            id: 'status',
            label: `${active.label} — ${
              stored ? t('menu.status.configured', { hint: keyHint(stored) }) : t('menu.status.missing')
            }`,
            disabled: true,
          },
          {
            id: 'set',
            label: t(stored ? 'menu.updateKey' : 'menu.setKey', { provider: active.label }),
            iconName: 'settings',
          },
          { id: 'test', label: t('menu.test', { provider: active.label }), iconName: 'zap', disabled: !stored },
          {
            id: 'clear',
            label: t('menu.clearKey', { provider: active.label }),
            iconName: 'toggle-left',
            disabled: !stored,
          },
          { id: 'sep-switch', label: '', separator: true },
          {
            id: 'switch',
            label: t('menu.switch'),
            children: PROVIDER_IDS.map((id) => ({
              id: `use:${id}`,
              label: PROVIDERS[id].label,
              current: id === active.id,
            })),
          },
        ];
      },
      async execute(_menuCtx, itemId): Promise<void> {
        const separator = itemId.indexOf(':');
        const verb = separator < 0 ? itemId : itemId.slice(0, separator);
        const target = separator < 0 ? '' : itemId.slice(separator + 1);

        if (verb === 'use') {
          if (!isProviderId(target)) return;
          await ctx.storage.set(STORAGE_PROVIDER, target);
          ctx.logger.info(`provider switched to ${target}`);
          await ctx.ui.showToast({
            title: t('toast.providerSwitched', { provider: PROVIDERS[target].label }),
            variant: 'success',
          });
          return;
        }

        const spec = await resolveProvider(ctx, '');

        if (verb === 'set') {
          const result = await ctx.ui.showModalDialog({
            title: t('form.title', { provider: spec.label }),
            description: t('form.description', { provider: spec.label }),
            actions: [
              { id: 'cancel', label: t('form.cancel') },
              { id: 'save', label: t('form.submit'), variant: 'primary' },
            ],
            fields: apiKeyFields(t, spec),
          });
          const value = readApiKeyValue(result.values);
          if (result.action !== 'save' || !value) return;
          await ctx.secrets.set(spec.secretKey, value);
          ctx.logger.info(`${spec.id} key stored from settings menu`);
          await ctx.ui.showToast({
            title: t('toast.keySaved', { provider: spec.label }),
            description: t('toast.keySavedBody'),
            variant: 'success',
          });
          return;
        }

        if (verb === 'clear') {
          await ctx.secrets.delete(spec.secretKey);
          ctx.logger.info(`${spec.id} key removed`);
          await ctx.ui.showToast({ title: t('toast.keyCleared', { provider: spec.label }), variant: 'info' });
          return;
        }

        if (verb === 'test') {
          const stored = await ctx.secrets.get(spec.secretKey);
          if (!stored) return;
          try {
            // Both providers accept a key check on their model list; OpenRouter's
            // list simply does not include the alpha Decisions models.
            const payload = await requestJson(
              spec,
              stored,
              spec.modelsPath ?? '/v1/models',
              { method: 'GET' },
              undefined,
            );
            const count = extractModelList(payload).length;
            await ctx.ui.showToast({
              title: t('toast.testOk', { provider: spec.label }),
              description: count > 0
                ? t('toast.testOkBody', { count })
                : t('toast.testOkKeyOnly', { provider: spec.label }),
              variant: 'success',
            });
          } catch (error) {
            const message = error instanceof TypeSafeError ? error.message : errorText(error);
            ctx.logger.warn(`${spec.id} connection test failed: ${message}`);
            await ctx.ui.showToast({
              title: t('toast.testFailed', { provider: spec.label }),
              description: message,
              variant: 'error',
            });
          }
        }
      },
    }),
  );
}

export function deactivate(): void {
  // All disposables are tracked in ctx.subscriptions and released by the host.
}
