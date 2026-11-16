#!/usr/bin/env node
/**
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-call-urgency-nlp-routing-engine.
 *
 * Reads workflow.json (the exact file you import into n8n), walks the node
 * graph from a trigger, and executes every Code node in plain Node.js with
 * n8n-compatible globals ($input, $env, $(), $execution). IF nodes are
 * evaluated with strict boolean checks. HTTP Request nodes NEVER touch the
 * network: reaching one is a failure unless mocks are enabled, in which case
 * in-memory HubSpot, AI provider and Slack mocks built from the fixture answer.
 *
 * Usage:
 *   node scripts/simulate-sandbox-run.js                         # manual run, sandbox defaults (no env)
 *   node scripts/simulate-sandbox-run.js --mock-ai               # sandbox + mocked AI enrichment
 *   node scripts/simulate-sandbox-run.js --mock-live             # authenticated webhook → full live path (mocked)
 *   node scripts/simulate-sandbox-run.js --mock-live --set AI_PROVIDER=anthropic
 *   node scripts/simulate-sandbox-run.js --mock-live --ai-garbage     # invalid AI JSON → lexicon fallback
 *   node scripts/simulate-sandbox-run.js --mock-live --fail-writes    # HubSpot 429 → errors + ops alert
 *   node scripts/simulate-sandbox-run.js --mock-live --bad-secret     # webhook auth rejection
 *   node scripts/simulate-sandbox-run.js --block-env             # N8N_BLOCK_ENV_ACCESS_IN_NODE=true
 *   node scripts/simulate-sandbox-run.js --env-file .env         # load a dotenv file (secrets masked)
 *   Options: --fixture <file>, --json, --quiet, --no-checks, --out <file>, --set KEY=VALUE (repeatable)
 *
 * Requires Node.js >= 18. No dependencies.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const DEFAULT_FIXTURE = path.join(ROOT, 'sample-payloads', 'call-transcript-fixture.json');
const SECRET_KEYS = ['HUBSPOT_ACCESS_TOKEN', 'AI_API_KEY', 'SLACK_ALERT_WEBHOOK_URL', 'SLACK_LEADERSHIP_WEBHOOK_URL', 'ALERT_WEBHOOK_URL', 'INBOUND_WEBHOOK_SECRET'];

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { set: [], envFile: null, fixture: null, mockLive: false, mockAi: false, aiGarbage: false, failWrites: false, badSecret: false, blockEnv: false, json: false, quiet: false, checks: true, out: path.join(ROOT, 'sim-output', 'last-run.json') };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--mock-live') opt.mockLive = true;
  else if (a === '--mock-ai') opt.mockAi = true;
  else if (a === '--ai-garbage') opt.aiGarbage = true;
  else if (a === '--fail-writes') opt.failWrites = true;
  else if (a === '--bad-secret') opt.badSecret = true;
  else if (a === '--block-env') opt.blockEnv = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--no-checks') opt.checks = false;
  else if (a === '--env-file') opt.envFile = args[++i];
  else if (a === '--fixture') opt.fixture = args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--set') opt.set.push(args[++i]);
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 28).join('\n')); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); process.exit(2); }
}
if (opt.mockLive || opt.aiGarbage) opt.mockAi = true;
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const ok = (s) => color('32', s); const bad = (s) => color('31', s); const dim = (s) => color('2', s); const bold = (s) => color('1', s);
const log = (...a) => { if (!opt.quiet) console.log(...a); };

// ── Load workflow + fixture ────────────────────────────────────────────────
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const wfText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const fixturePath = opt.fixture ? path.resolve(opt.fixture) : DEFAULT_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const usingDefaultFixture = fixturePath === DEFAULT_FIXTURE;
const nodesByName = new Map(workflow.nodes.map((n) => [n.name, n]));

// ── Isolated environment: host process.env is NEVER passed through ──────────
const env = {};
const parseDotenv = (text) => {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
};
if (opt.envFile) parseDotenv(fs.readFileSync(path.resolve(opt.envFile), 'utf8'));
if (opt.mockAi) Object.assign(env, { AI_ANALYSIS_ENABLED: 'true', AI_API_KEY: 'mock-ai-key-not-real' });
if (opt.mockLive) {
  Object.assign(env, {
    SANDBOX_MODE: 'false', DRY_RUN: 'false', HUBSPOT_MUTATIONS_ENABLED: 'true', SEND_SLACK_ALERTS: 'true', SEND_OPS_ALERTS: 'true',
    HUBSPOT_ACCESS_TOKEN: 'mock-hubspot-token-not-real', INBOUND_WEBHOOK_SECRET: 'mock-inbound-secret-not-real',
    SLACK_ALERT_WEBHOOK_URL: 'https://hooks.example.com/mock/sales-leadership', SLACK_LEADERSHIP_WEBHOOK_URL: 'https://hooks.example.com/mock/executive-escalations',
    ALERT_WEBHOOK_URL: 'https://alerts.example.com/mock/ops',
  });
}
for (const kv of opt.set) {
  const i = kv.indexOf('=');
  if (i < 1) { console.error(`--set expects KEY=VALUE, got "${kv}"`); process.exit(2); }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
const secretValues = SECRET_KEYS.map((k) => env[k]).filter((v) => v && v.length >= 6);
const mask = (s) => { let out = String(s); for (const v of secretValues) out = out.split(v).join('***'); return out; };
const $env = new Proxy({}, { get(_, key) { if (opt.blockEnv) throw new Error('access to env vars denied'); return typeof key === 'string' ? env[key] : undefined; } });

// ── Static safety audit of workflow.json ───────────────────────────────────
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
check('workflow.json is inactive on import', workflow.active === false);
check('webhook trigger + manual test trigger present', workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook') && workflow.nodes.some((n) => n.type === 'n8n-nodes-base.manualTrigger'));
const OFFICIAL = ['api.hubapi.com', 'app.hubspot.com', 'api.openai.com', 'api.anthropic.com'];
for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
  const hdrs = (n.parameters.headerParameters && n.parameters.headerParameters.parameters) || [];
  const secretHdrs = hdrs.filter((h) => ['authorization', 'x-api-key'].includes(h.name.toLowerCase()));
  const authOk = secretHdrs.every((h) => /\{\{\s*\$env\.[A-Z_]+\s*\}\}/.test(h.value));
  const url = n.parameters.url;
  const urlOk = /^=https:\/\/(api\.hubapi\.com|api\.openai\.com|api\.anthropic\.com)/.test(url) || (/^=\{\{[^}]*\}\}$/.test(url) && /\$env\./.test(url) && !/https?:/.test(url));
  check(`HTTP "${n.name}" uses $env auth/URL, no stored credentials`, authOk && urlOk && !n.credentials);
}
const secretPatterns = [/pat-(na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}/i, /sk-[A-Za-z0-9_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/];
check('no hardcoded secrets in workflow.json', !secretPatterns.some((p) => p.test(wfText)));
const hosts = [...new Set((wfText.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => u.replace(/^https?:\/\//i, '').toLowerCase()))].filter((h) => !/(^|\.)example\.com$/.test(h) && !OFFICIAL.includes(h));
check('only example.com + official API hosts referenced', hosts.length === 0, hosts.join(', '));
const emails = [...new Set(wfText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])].filter((e) => !/@([a-z0-9-]+\.)*example\.com$/i.test(e));
check('only @example.com email addresses in workflow.json', emails.length === 0, emails.join(', '));
const embedded = nodesByName.get('Load Sandbox Fixture').parameters.jsCode.match(/\/\* FIXTURE:START \*\/\s*const FIXTURE = ([\s\S]*?);\s*\/\* FIXTURE:END \*\//);
check('embedded sandbox fixture matches sample-payloads file', embedded && JSON.stringify(JSON.parse(embedded[1])) === JSON.stringify(JSON.parse(fs.readFileSync(DEFAULT_FIXTURE, 'utf8'))));

// ── Graph executor ─────────────────────────────────────────────────────────
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const outputs = new Map();
const executed = [];
const httpCalls = [];
const nodeAccessor = (name) => {
  if (!outputs.has(name)) throw new Error(`Referenced node "${name}" is unexecuted`);
  const items = outputs.get(name).flat();
  return { all: () => items, first: () => items[0], last: () => items[items.length - 1], get item() { throw new Error('$("node").item is not supported by the simulator; use .all()[i]'); } };
};
const evalWith = (template, scope) => {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const body = template.slice(1);
  const run = (expr) => new Function('$json', '$', '$env', `return (${expr});`)(scope.json, nodeAccessor, $env);
  const whole = body.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => String(run(expr)));
};
const normalizeReturn = (ret, name) => {
  if (!Array.isArray(ret)) throw new Error(`Code node "${name}" must return an array of items`);
  return ret.map((it) => { if (!it || typeof it !== 'object' || !('json' in it)) throw new Error(`Code node "${name}" returned an item without "json"`); return { json: JSON.parse(JSON.stringify(it.json)) }; });
};
const runCode = async (node, input) => {
  let src = node.parameters.jsCode;
  if (node.name === 'Load Sandbox Fixture' && !usingDefaultFixture) src = src.replace(/\/\* FIXTURE:START \*\/[\s\S]*?\/\* FIXTURE:END \*\//, `const FIXTURE = ${JSON.stringify(fixture)};`);
  const $input = { all: () => input, first: () => input[0], last: () => input[input.length - 1] };
  const fn = new AsyncFunction('$input', '$env', '$', '$execution', '$workflow', 'console', src);
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  return normalizeReturn(await fn($input, $env, nodeAccessor, { id: 'sim-0001', mode: 'manual' }, { id: 'sim', name: workflow.name }, quiet), node.name);
};
const runIf = (node, input) => {
  const t = []; const f = [];
  for (const item of input) {
    const pass = node.parameters.conditions.conditions.every((c) => {
      const v = evalWith(c.leftValue, { json: item.json });
      if (typeof v !== 'boolean') throw new Error(`IF "${node.name}" strict type validation: expected boolean, got ${typeof v}`);
      return v;
    });
    (pass ? t : f).push(item);
  }
  return [t, f];
};

// ── Mocks (only with --mock-ai / --mock-live). No sockets are ever opened. ──
const byCallId = new Map(fixture.calls.map((c) => [c.callId, c]));
const runStart = () => new Date(nodeAccessor('Config & Safety Gate').first().json.runStartedAt).getTime();
const crmContact = (c) => {
  if (!c || !c.mockCrm || !c.mockCrm.contact) return null;
  const ct = JSON.parse(JSON.stringify(c.mockCrm.contact));
  if (ct.properties.call_last_escalated_at === '__RELATIVE__') ct.properties.call_last_escalated_at = new Date(runStart() - (c.mockCrm.lastEscalatedHoursAgo || 0) * 3600000).toISOString();
  return ct;
};
const mockHttp = (node, url, body, item) => {
  const u = new URL(url);
  if (['api.openai.com', 'api.anthropic.com'].includes(u.hostname)) {
    if (!opt.mockAi) throw new Error(`AI node "${node.name}" reached without --mock-ai.`);
    const c = byCallId.get(item.json.callId);
    const content = opt.aiGarbage ? 'Sure! Here is my analysis: the caller seems keen.' : JSON.stringify(c ? c.mockAiAnalysis : { urgency_score: 10, sentiment_score: 0, urgency_level: 'low', summary: 'n/a', key_signals: [], recommended_next_step: 'n/a', injection_detected: false });
    return u.hostname === 'api.anthropic.com'
      ? { id: 'mock-msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }
      : { id: 'mock-chatcmpl', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
  }
  if (!opt.mockLive) throw new Error(`HTTP node "${node.name}" was reached without --mock-live. Safe defaults should keep it idle.`);
  if (u.hostname === 'api.hubapi.com') {
    if (u.pathname === '/crm/v3/objects/contacts/search') {
      const f = body.filterGroups[0].filters[0];
      const c = fixture.calls.find((x) => x.mockCrm && x.mockCrm.contact && ((f.propertyName === 'email' && x.mockCrm.contact.properties.email === f.value) || (f.propertyName === 'hs_object_id' && x.mockCrm.contact.id === f.value)));
      const ct = crmContact(c);
      return { total: ct ? 1 : 0, results: ct ? [ct] : [] };
    }
    if (u.pathname === '/crm/v3/objects/deals/search') {
      const cid = body.filterGroups[0].filters.find((x) => x.propertyName === 'associations.contact').value;
      const c = fixture.calls.find((x) => x.mockCrm && x.mockCrm.contact && x.mockCrm.contact.id === cid);
      const deals = c ? c.mockCrm.deals : [];
      return { total: deals.length, results: deals };
    }
    if (/\/batch\/update$/.test(u.pathname)) {
      if (opt.failWrites) return { error: { message: 'Mock 429: secondly rate limit reached', httpCode: '429' } };
      return { status: 'COMPLETE', results: body.inputs.map((x) => ({ id: x.id, properties: x.properties })) };
    }
  }
  if (u.hostname.endsWith('example.com')) return { data: 'ok' };
  throw new Error(`No mock for POST ${mask(url)}`);
};
const runHttp = async (node, input) => {
  const p = node.parameters;
  return input.map((item) => {
    const scope = { json: item.json };
    const url = evalWith(p.url, scope);
    const headers = Object.fromEntries(((p.headerParameters && p.headerParameters.parameters) || []).map((h) => [h.name, evalWith(h.value, scope)]));
    if (!/^https:\/\//.test(String(url))) throw new Error(`HTTP "${node.name}" resolved a non-https URL: ${mask(url)}`);
    for (const [k, v] of Object.entries(headers)) if (/authorization|x-api-key/i.test(k) && /undefined|null|^Bearer\s*$/.test(String(v))) throw new Error(`HTTP "${node.name}" header ${k} did not resolve`);
    const bodyText = evalWith(p.jsonBody, scope);
    const body = JSON.parse(bodyText);
    httpCalls.push({ node: node.name, url: mask(url), bodyBytes: Buffer.byteLength(bodyText), body: mask(bodyText), target: item.json.target || null });
    return { json: mockHttp(node, url, body, item) };
  });
};
const execute = async (startName, startInput) => {
  const queue = [{ name: startName, input: startInput }];
  let guard = 0;
  while (queue.length) {
    if (++guard > 400) throw new Error('Execution guard tripped (possible cycle).');
    const { name, input } = queue.shift();
    const node = nodesByName.get(name);
    if (!node) throw new Error(`Connection points to unknown node "${name}"`);
    let outs;
    if (['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.webhook'].includes(node.type)) outs = [input];
    else if (node.type === 'n8n-nodes-base.code') outs = [await runCode(node, input)];
    else if (node.type === 'n8n-nodes-base.if') outs = runIf(node, input);
    else if (node.type === 'n8n-nodes-base.httpRequest') outs = [await runHttp(node, input)];
    else throw new Error(`Simulator does not support node type ${node.type}`);
    outputs.set(name, outs);
    executed.push({ name, itemsIn: input.length, itemsOut: outs.map((o) => o.length) });
    const conn = workflow.connections[name];
    if (!conn) continue;
    conn.main.forEach((targets, outIdx) => { const items = outs[outIdx] || []; if (!items.length) return; for (const t of targets || []) queue.push({ name: t.node, input: items }); });
  }
};

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  let runError = null;
  const useWebhook = opt.mockLive;
  const webhookInput = [{ json: {
    headers: { 'content-type': 'application/json', 'x-webhook-secret': opt.badSecret ? 'wrong-secret-value' : (env.INBOUND_WEBHOOK_SECRET || '') },
    params: {}, query: {},
    body: { calls: fixture.calls.map(({ expected, mockCrm, mockAiAnalysis, ...c }) => c) },
  } }];
  try { await execute(useWebhook ? 'Webhook Trigger' : 'Manual Test Trigger', useWebhook ? webhookInput : [{ json: {} }]); } catch (e) { runError = e; }

  const get = (n) => (outputs.has(n) ? outputs.get(n).flat().map((i) => i.json) : null);
  const cfg = (get('Config & Safety Gate') || [])[0];
  const decisions = get('Urgency Classification & Escalation Decision') || [];
  const preview = (get('Dry-Run CRM Update Preview') || [])[0];
  const writes = (get('Collect HubSpot Update Results') || [])[0];
  const slackMsgs = get('RevOps Slack Block Kit Builder') || [];
  const summary = (get('Execution Summary & Audit') || [])[0];

  log(bold('\nCall Urgency NLP Routing Engine · offline simulation'));
  log(dim(`trigger: ${useWebhook ? 'webhook' : 'manual'} · fixture: ${path.relative(ROOT, fixturePath)} · ${opt.mockLive ? 'MOCK-LIVE' : opt.mockAi ? 'sandbox + MOCK-AI' : 'sandbox defaults'}${opt.blockEnv ? ' · $env BLOCKED' : ''} · no network`));
  if (cfg) {
    log(bold('\nSafety gates'));
    log(`  mode=${cfg.modeLabel}  inboundAuth=${cfg.inboundAuth}  sandbox=${cfg.sandboxMode}  dryRun=${cfg.dryRun}  ai=${cfg.allowAiCall ? `${cfg.aiProvider}/${cfg.aiModel}` : 'off'}`);
    log(`  allowHubspotMutations=${cfg.allowHubspotMutations}  allowSlackSend=${cfg.allowSlackSend}  allowOpsAlert=${cfg.allowOpsAlert}`);
    (cfg.warnings || []).forEach((w) => log(dim(`  ! ${w}`)));
  }
  if (decisions.length) {
    log(bold('\nCalls'));
    for (const d of decisions) {
      log(`  ${d.callId}  ${d.prospect.company.padEnd(22)} ${d.urgency.level.padEnd(8)} ${String(d.urgency.score).padStart(3)} (lex ${String(d.urgency.lexiconScore).padStart(3)}${d.urgency.aiScore !== null ? ` / ai ${String(d.urgency.aiScore).padStart(3)}` : ''})  ${d.sentiment.label.padEnd(8)} ent=${d.enterprise.isEnterprise ? 'Y' : 'n'}  → ${d.escalation.status}${d.escalation.target ? ` [${d.escalation.target}]` : ''}${d.review.needed ? '  ⚠ review' : ''}`);
      log(dim(`      ${d.urgency.method} · signals: ${d.signals.slice(0, 5).map((s) => s.phrase).join(', ') || 'none'}${d.negatedSignals.length ? ` · negated: ${d.negatedSignals.join(', ')}` : ''}${d.redaction.total ? ` · redacted ${d.redaction.total}` : ''}`));
    }
  }
  if (preview) log(bold('\nHubSpot (preview only)'), `\n  blocked: ${preview.blockedReason} · would update ${preview.wouldUpdate.contacts} contact(s), ${preview.wouldUpdate.deals} deal(s)`);
  if (writes) log(bold('\nHubSpot (mock live)'), `\n  ${writes.succeeded}/${writes.attempted} record update(s) succeeded · failures ${writes.failures.length}`);
  log(bold('\nSlack'), `\n  ${slackMsgs.length} escalation message(s) built${slackMsgs.length ? ` · send=${slackMsgs[0].allowSend}${slackMsgs[0].skipReason ? ` (skipped: ${slackMsgs[0].skipReason})` : ''}` : ''}`);
  log(bold('\nHTTP calls'), httpCalls.length ? `(${httpCalls.length}, all mocked)` : '\n  none (zero external requests)');
  httpCalls.forEach((h) => log(dim(`  POST ${h.url}${h.target ? ` · target=${h.target}` : ''}`)));
  if (summary) log(bold('\nSummary'), `\n  status=${summary.status} · checksum=${summary.checksum} · opsAlert=${summary.needsOpsAlert}`);
  if (runError) log(bold('\nRun error'), `\n  ${runError.message}`);

  // ── Behavioural checks
  if (opt.badSecret) {
    check('bad secret: run rejected at intake', runError && /rejected/i.test(runError.message));
    check('bad secret: zero HTTP requests', httpCalls.length === 0);
  } else {
    check('workflow executed without throwing', !runError, runError ? runError.message : '');
  }
  if (cfg && opt.checks && !opt.badSecret) {
    // The Webhook Trigger's own output holds the raw request headers (as it does in n8n execution data); every node after it must not.
    const allOut = JSON.stringify([...outputs.entries()].filter(([n]) => n !== 'Webhook Trigger').map(([, v]) => v));
    check('no secret values leaked into any node output after the trigger', secretValues.every((v) => !allOut.includes(v)));
    check('config item never contains webhook headers', !JSON.stringify(cfg).includes('x-webhook-secret'));
    const isDefault = !opt.mockAi && !opt.mockLive && !opt.envFile && opt.set.length === 0;
    if (isDefault) {
      check('safe defaults: sandbox on, dry-run on, AI off', cfg.sandboxMode && cfg.dryRun && !cfg.allowAiCall);
      check('safe defaults: CRM, Slack and ops gates closed', !cfg.allowHubspotMutations && !cfg.allowSlackSend && !cfg.allowOpsAlert);
      check('safe defaults: zero HTTP requests', httpCalls.length === 0);
    }
    if (usingDefaultFixture && decisions.length) {
      const by = Object.fromEntries(decisions.map((d) => [d.callId, d]));
      for (const c of fixture.calls) {
        const d = by[c.callId];
        check(`${c.callId}: level ${c.expected.urgencyLevel}`, d && d.urgency.level === c.expected.urgencyLevel, d ? `got ${d.urgency.level} (${d.urgency.score})` : 'missing');
        check(`${c.callId}: escalation ${c.expected.escalationStatus}`, d && d.escalation.status === c.expected.escalationStatus, d ? `got ${d.escalation.status}` : 'missing');
      }
      const inj = by['mock-call-0006'];
      check('injection call: flagged and AI score ignored', inj.injectionSuspected && inj.review.needed && !/^blended$/.test(inj.urgency.method));
      check('injection call: email, phone and card redacted', inj.redaction.counts.email >= 1 && inj.redaction.counts.phone >= 1 && inj.redaction.counts.card >= 1);
      check('injection call: summary does not repeat injected instructions', !/ignore all previous instructions/i.test(inj.summary));
      check('injection call: no CRM match, no update', !inj.crm.matched && inj.updates.skipReason === 'no_matching_contact');
      check('low call: negated "urgent" not scored', by['mock-call-0001'].negatedSignals.includes('urgent'));
      const downstream = JSON.stringify([(get('Transcript Redaction & Prep') || []).map((x) => [x.redactedSegments, x.analysisText]), get('Build AI Requests'), decisions, slackMsgs, summary, preview, httpCalls.filter((h) => !h.node.startsWith('HubSpot: Search'))]);
      check('no raw PII after redaction (email/phone/card from transcript)', !/unknown\.caller@unlisted|555-010-9999|4111 1111 1111 1111/.test(downstream));
      check('Slack payloads contain no email addresses or phone numbers', !/@[a-z0-9-]+\.example\.com|\+1-555-01\d\d/i.test(JSON.stringify(slackMsgs)));
      check('2 escalation messages built (EnterpriseCorp, GlobalHoldings)', slackMsgs.length === 2 && slackMsgs.every((m) => m.blockCount <= 50));
      check('Slack sections within Block Kit text limits', slackMsgs.every((m) => m.payload.blocks.every((b) => !b.text || b.text.text.length <= 3000)));
      check('6 contacts + 6 deals prepared for update (unmatched caller skipped)', (() => { const c = decisions.filter((d) => d.updates.contact).length; const dl = decisions.filter((d) => d.updates.deal).length; return c === 6 && dl === 5; })(), 'deals: 5 callers have open deals');
      if (opt.mockAi && !opt.aiGarbage) check('AI enrichment blended for non-injection calls', decisions.filter((d) => d.callId !== 'mock-call-0006').every((d) => d.urgency.method === 'blended'));
      if (opt.aiGarbage) check('invalid AI JSON falls back to lexicon for every call', decisions.every((d) => /^lexicon_only/.test(d.urgency.method)));
    }
    if (opt.mockLive) {
      check('mock-live: webhook secret verified', cfg.inboundAuth === 'verified');
      check('mock-live: one contact + one deal search per call', httpCalls.filter((h) => h.node === 'HubSpot: Search Contact').length === fixture.calls.length && httpCalls.filter((h) => h.node === 'HubSpot: Search Open Deals').length === fixture.calls.length);
      check(`mock-live: one AI call per call (${(env.AI_PROVIDER || 'openai')})`, httpCalls.filter((h) => h.node.startsWith('AI:')).length === fixture.calls.length && httpCalls.filter((h) => h.node.startsWith('AI:')).every((h) => (env.AI_PROVIDER === 'anthropic') === h.node.includes('Anthropic')));
      check('mock-live: AI requests contain only redacted text', httpCalls.filter((h) => h.node.startsWith('AI:')).every((h) => !/4111 1111|unknown\.caller@unlisted/.test(h.body)));
      if (opt.failWrites) {
        check('fail-writes: completes with errors (no throw)', summary && summary.status === 'completed_with_errors');
        check('fail-writes: ops alert raised', summary && summary.needsOpsAlert && httpCalls.some((h) => h.node === 'Ops: Post Failure Alert'));
      } else {
        check('mock-live: contact + deal batch updates succeeded', writes && writes.failed === 0 && writes.succeeded === 11);
        check('mock-live: 2 Slack alerts sent, Critical → executive webhook', summary && summary.slack.status === 'sent' && httpCalls.filter((h) => h.node === 'Slack: Post Escalation Alert').map((h) => h.target).sort().join() === 'executive,sales_leadership');
      }
    }
    if (opt.blockEnv) check('blocked $env falls back to sandbox + dry-run', cfg.sandboxMode && cfg.dryRun && !cfg.envAccessible);
  }

  log(bold('\nChecks'));
  for (const c of checks) log(`  ${c.pass ? ok('PASS') : bad('FAIL')} ${c.name}${c.detail ? dim(` — ${c.detail}`) : ''}`);
  const failed = checks.filter((c) => !c.pass);
  const report = { simulatedAt: new Date().toISOString(), durationMs: Date.now() - started, options: { ...opt, set: opt.set.map((s) => s.split('=')[0]) }, runError: runError ? runError.message : null, executed, httpCalls: httpCalls.map(({ body, ...h }) => h), checks, audit: summary, decisions, slackMessages: slackMsgs.map((m) => m.payload), crmPreview: preview, crmResults: writes };
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, mask(JSON.stringify(report, null, 2)));
  if (opt.json) console.log(mask(JSON.stringify(summary, null, 2)));
  log(dim(`\nFull report: ${path.relative(process.cwd(), opt.out)}`));
  log(failed.length ? bad(`\n${failed.length} check(s) failed.`) : ok(`\nAll ${checks.length} checks passed.`));
  if (runError && !opt.badSecret && !opt.quiet) console.error(bad(runError.stack));
  process.exit(failed.length ? 1 : 0);
})();
