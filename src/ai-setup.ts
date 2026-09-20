import * as vscode from 'vscode';
import { DEFAULT_MODELS, LlmConfig, Provider } from './llm';

const LEGACY_KEY = 'ldoc.llm.apiKey';
const providers: Provider[] = ['anthropic', 'openai', 'gemini', 'openai-compatible'];

export function keyName(provider: Provider, baseUrl = ''): string {
  return `${LEGACY_KEY}.${provider}${provider === 'openai-compatible' ? '.' + encodeURIComponent((baseUrl || 'http://localhost:11434/v1').trim().replace(/\/+$/, '')) : ''}`;
}

function settingsConfig(): Omit<LlmConfig, 'apiKey'> {
  const settings = vscode.workspace.getConfiguration('ldoc');
  const provider = settings.get<Provider>('llm.provider', 'anthropic');
  if (!providers.includes(provider)) throw new Error('Choose an AI provider with LDOC: Set Up AI.');
  return { provider, model: settings.get<string>('llm.model', '').trim() || DEFAULT_MODELS[provider], baseUrl: settings.get<string>('llm.baseUrl', '').trim() };
}

async function migrateKey(context: vscode.ExtensionContext, config: Omit<LlmConfig, 'apiKey'>) {
  const legacy = await context.secrets.get(LEGACY_KEY);
  if (legacy) {
    const name = keyName(config.provider, config.baseUrl);
    if (!await context.secrets.get(name)) await context.secrets.store(name, legacy);
    await context.secrets.delete(LEGACY_KEY);
  }
}

function endpointError(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'Use HTTPS for a hosted service, or HTTP on localhost.';
  } catch { return 'Enter a base URL such as http://localhost:11434/v1 (without a key or query string).'; }
}

async function enterKey(provider: Provider): Promise<string | undefined> {
  const optional = provider === 'openai-compatible';
  const value = await vscode.window.showInputBox({
    title: `LDOC — ${provider} API key`, password: true, ignoreFocusOut: true,
    prompt: optional ? 'Paste the hosted service key, or leave empty for a local model. Stored in SecretStorage.' : 'Stored securely in VS Code SecretStorage. Your selected text is sent to this provider when you generate.',
    validateInput: value => !optional && !value.trim() ? 'Paste your API key.' : undefined,
  });
  return value?.trim();
}

/** Collect everything first; cancelling a step leaves the current setup intact. */
export async function setupAI(context: vscode.ExtensionContext): Promise<LlmConfig | undefined> {
  let current: Omit<LlmConfig, 'apiKey'>;
  try { current = settingsConfig(); }
  catch { current = { provider: 'anthropic', model: DEFAULT_MODELS.anthropic, baseUrl: '' }; }
  await migrateKey(context, current);
  const picked = await vscode.window.showQuickPick(providers.map(provider => ({
    label: provider, description: provider === 'openai-compatible' ? 'Local models or a compatible hosted endpoint' : undefined,
  })), { title: 'LDOC — Set Up AI (1/3): provider', ignoreFocusOut: true });
  if (!picked) return;
  const provider = picked.label as Provider;
  let baseUrl = '';
  if (provider === 'openai-compatible') {
    const value = await vscode.window.showInputBox({ title: 'LDOC — compatible endpoint', value: current.baseUrl || 'http://localhost:11434/v1', ignoreFocusOut: true, validateInput: endpointError });
    if (value === undefined) return;
    baseUrl = value.trim().replace(/\/+$/, '');
  }
  const model = await vscode.window.showInputBox({
    title: 'LDOC — Set Up AI (2/3): model', ignoreFocusOut: true,
    value: provider === current.provider ? current.model : DEFAULT_MODELS[provider],
    prompt: 'Use a text model available to your account. You can change this later.',
    validateInput: value => !value.trim() ? 'Enter a model ID.' : undefined,
  });
  if (model === undefined) return;
  const apiKey = await enterKey(provider);
  if (apiKey === undefined) return;
  const settings = vscode.workspace.getConfiguration('ldoc');
  for (const [name, value] of Object.entries({ provider, model: model.trim(), baseUrl })) {
    const inspected = settings.inspect(`llm.${name}`);
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await settings.update(`llm.${name}`, value, target);
  }
  const name = keyName(provider, baseUrl);
  if (apiKey) await context.secrets.store(name, apiKey);
  else await context.secrets.delete(name);
  vscode.window.showInformationMessage('LDOC AI is set up. Select an explanation, then run LDOC: Generate Animation from Text (AI).');
  return { provider, model: model.trim(), baseUrl, apiKey };
}

export async function getLlmConfig(context: vscode.ExtensionContext): Promise<LlmConfig | undefined> {
  const config = settingsConfig();
  await migrateKey(context, config);
  if (config.provider === 'openai-compatible') {
    const error = endpointError(config.baseUrl || 'http://localhost:11434/v1');
    if (error) throw new Error(error);
  }
  const apiKey = await context.secrets.get(keyName(config.provider, config.baseUrl)) || '';
  if (!apiKey && config.provider !== 'openai-compatible') return setupAI(context);
  return { ...config, apiKey };
}

export async function setApiKey(context: vscode.ExtensionContext) {
  const config = settingsConfig();
  await migrateKey(context, config);
  const apiKey = await enterKey(config.provider);
  if (apiKey === undefined) return;
  const name = keyName(config.provider, config.baseUrl);
  if (apiKey) await context.secrets.store(name, apiKey);
  else await context.secrets.delete(name);
  vscode.window.showInformationMessage(`LDOC: ${config.provider} key updated.`);
}

export async function clearApiKey(context: vscode.ExtensionContext) {
  const config = settingsConfig();
  await context.secrets.delete(keyName(config.provider, config.baseUrl));
  await context.secrets.delete(LEGACY_KEY);
  vscode.window.showInformationMessage(`LDOC: ${config.provider} key removed.`);
}
