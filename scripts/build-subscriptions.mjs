// Freeze USER_SUBSCRIPTIONS and lookupSubscription into the Go catalog.
// This reads the existing table only. It does not refresh prices or contact providers.
import { USER_SUBSCRIPTIONS, lookupSubscription } from '../src/pricing.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const plans = {
  openai: ['plus', 'pro', 'pro_5x', 'pro_20x'],
  anthropic: ['pro', 'default_claude_max_5x', 'default_claude_max_20x', 'max-5x', 'max-20x'],
  cursor: ['pro', 'pro+', 'ultra'],
  'ollama-cloud': ['pro', 'max', 'team'],
  xai: ['supergrok', 'supergrok-plus'],
};
const providers = [...new Set([...Object.keys(USER_SUBSCRIPTIONS), ...Object.keys(plans)])].sort();
const catalog = {
  overrides: Object.fromEntries(providers.filter((id) => USER_SUBSCRIPTIONS[id]).map((id) => [id, USER_SUBSCRIPTIONS[id]])),
  plans: Object.fromEntries(providers.map((id) => [id, Object.fromEntries((plans[id] ?? []).map((plan) => [plan, lookupSubscription(id, plan)]))])),
};
const text = JSON.stringify(catalog, null, 2) + '\n';
const target = new URL('../internal/runtime/subscription_catalog.json', import.meta.url);
if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== text) {
    console.error('subscription catalog drifted from src/pricing.mjs');
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(target, text);
